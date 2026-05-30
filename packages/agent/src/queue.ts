import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";

export type AgentTaskStatus = "queued" | "running" | "done" | "failed";

export interface AgentTask {
  id: string;
  prompt: string;
  workdir?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  status: AgentTaskStatus;
  result?: string;
  error?: string;
  pid?: number;
}

const QUEUE_KEY = "oa:agent:queue";
const TASK_KEY = (id: string) => `oa:agent:task:${id}`;
const TASK_TTL_SECONDS = 60 * 60 * 24 * 7; // 1 week

export interface QueueConfig {
  host?: string;
  port?: number;
  password?: string;
}

/**
 * Simple list-backed task queue on top of Redis / FalkorDB. We persist task
 * state under a per-task hash so consumers can poll without burning queue
 * space.
 */
export class AgentQueue {
  private readonly redis: Redis;

  constructor(config: QueueConfig = {}) {
    this.redis = new Redis({
      host: config.host ?? process.env.FALKORDB_HOST ?? "127.0.0.1",
      port: Number(config.port ?? process.env.FALKORDB_PORT ?? 6379),
      password: config.password ?? process.env.FALKORDB_PASSWORD ?? undefined,
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
  }

  async connect(): Promise<void> {
    if (this.redis.status === "ready" || this.redis.status === "connecting") return;
    await this.redis.connect();
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }

  async enqueue(prompt: string, opts: { workdir?: string } = {}): Promise<AgentTask> {
    await this.connect();
    const task: AgentTask = {
      id: randomUUID(),
      prompt,
      workdir: opts.workdir,
      createdAt: Date.now(),
      status: "queued",
    };
    await this.save(task);
    await this.redis.rpush(QUEUE_KEY, task.id);
    return task;
  }

  async save(task: AgentTask): Promise<void> {
    await this.connect();
    await this.redis.set(TASK_KEY(task.id), JSON.stringify(task), "EX", TASK_TTL_SECONDS);
  }

  async get(id: string): Promise<AgentTask | null> {
    await this.connect();
    const raw = await this.redis.get(TASK_KEY(id));
    return raw ? (JSON.parse(raw) as AgentTask) : null;
  }

  async update(id: string, patch: Partial<AgentTask>): Promise<AgentTask | null> {
    const cur = await this.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    await this.save(next);
    return next;
  }

  /** Blocking pop with timeout in seconds. Returns null on timeout. */
  async dequeue(timeoutSec = 5): Promise<AgentTask | null> {
    await this.connect();
    const r = await this.redis.blpop(QUEUE_KEY, timeoutSec);
    if (!r) return null;
    const id = r[1];
    return this.get(id);
  }

  async list(limit = 25): Promise<AgentTask[]> {
    await this.connect();
    // Scan task keys directly so completed tasks remain visible.
    const tasks: AgentTask[] = [];
    let cursor = "0";
    do {
      const [next, batch] = await this.redis.scan(cursor, "MATCH", "oa:agent:task:*", "COUNT", 200);
      cursor = next;
      if (batch.length) {
        const vals = await this.redis.mget(...batch);
        for (const v of vals) {
          if (v) tasks.push(JSON.parse(v) as AgentTask);
        }
      }
    } while (cursor !== "0" && tasks.length < limit * 4);
    return tasks.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }
}
