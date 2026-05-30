import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import {
  EntityExtractor,
  MemoryStore,
  entityId,
  ingestText,
} from "@open-assistant/memory";
import { type AgentTask, AgentQueue } from "./queue.js";

export interface RunnerOptions {
  queue?: AgentQueue;
  memory?: MemoryStore;
  extractor?: EntityExtractor;
  /** Override workdir root (default: OA_AGENT_WORKDIR or /tmp/open-assistant-agents). */
  workdirRoot?: string;
  /**
   * Force a specific execution backend. Default is "auto":
   *   - "claude-code" if `claude` is on PATH (uses Claude Code SDK CLI)
   *   - "anthropic-direct" otherwise (single shot Messages API call)
   */
  backend?: "auto" | "claude-code" | "anthropic-direct";
  /** Polling timeout per dequeue call. */
  pollSeconds?: number;
}

export interface RunResult {
  taskId: string;
  output: string;
  backend: "claude-code" | "anthropic-direct";
  workdir: string;
}

const SUB_AGENT_SYSTEM = `You are a remote sub-agent dispatched by open-assistant.
Complete the task end-to-end and respond with a concise summary of what you
did and any results the caller will need.`;

export class AgentRunner {
  readonly queue: AgentQueue;
  readonly memory: MemoryStore;
  readonly extractor: EntityExtractor;
  readonly workdirRoot: string;
  readonly backend: NonNullable<RunnerOptions["backend"]>;
  readonly pollSeconds: number;
  private stopped = false;

  constructor(opts: RunnerOptions = {}) {
    this.queue = opts.queue ?? new AgentQueue();
    this.memory = opts.memory ?? new MemoryStore();
    this.extractor = opts.extractor ?? new EntityExtractor();
    this.workdirRoot =
      opts.workdirRoot ?? process.env.OA_AGENT_WORKDIR ?? "/tmp/open-assistant-agents";
    this.backend = opts.backend ?? "auto";
    this.pollSeconds = opts.pollSeconds ?? 5;
  }

  /** Run a single task synchronously, returning the result. */
  async runTask(task: AgentTask): Promise<RunResult> {
    const workdir = task.workdir ?? path.join(this.workdirRoot, task.id);
    await mkdir(workdir, { recursive: true });
    await this.queue.update(task.id, { status: "running", startedAt: Date.now(), workdir });

    const backend = await this.resolveBackend();
    let output = "";
    try {
      if (backend === "claude-code") {
        output = await runClaudeCodeCLI(task.prompt, workdir);
      } else {
        output = await runDirectAnthropic(task.prompt);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.queue.update(task.id, { status: "failed", error: msg, finishedAt: Date.now() });
      throw err;
    }

    // Persist the result into memory as a fact node + ingest the output text.
    const sessionId = `agent:${task.id}`;
    const taskEntityId = entityId("event", `agent-task-${task.id.slice(0, 8)}`);
    await this.memory.upsertEntity({
      id: taskEntityId,
      type: "event",
      name: `agent task ${task.id.slice(0, 8)}`,
      description: task.prompt.slice(0, 280),
      attributes: { task_id: task.id, backend, workdir },
    });
    await ingestText(this.memory, this.extractor, output, {
      sessionId,
      turnId: `${task.id}:result`,
      role: "assistant",
    }).catch(() => undefined);

    await this.queue.update(task.id, {
      status: "done",
      finishedAt: Date.now(),
      result: output,
    });

    return { taskId: task.id, output, backend, workdir };
  }

  /** Long-running worker loop. Call stop() to break out. */
  async start(): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      const task = await this.queue.dequeue(this.pollSeconds);
      if (!task) continue;
      try {
        await this.runTask(task);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[agent] task ${task.id} failed:`, err);
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private async resolveBackend(): Promise<"claude-code" | "anthropic-direct"> {
    if (this.backend === "claude-code") return "claude-code";
    if (this.backend === "anthropic-direct") return "anthropic-direct";
    return (await hasClaudeCli()) ? "claude-code" : "anthropic-direct";
  }
}

async function hasClaudeCli(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("which", ["claude"], { stdio: "ignore" });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

function runClaudeCodeCLI(prompt: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", prompt, "--output-format", "text"], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`claude exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

async function runDirectAnthropic(prompt: string): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  if (!client.apiKey) {
    throw new Error(
      "No agent backend available: install `claude` CLI or set ANTHROPIC_API_KEY",
    );
  }
  const resp = await client.messages.create({
    model: process.env.OA_MODEL ?? "claude-sonnet-4-20250514",
    max_tokens: Number(process.env.OA_MAX_TOKENS ?? 4096),
    system: SUB_AGENT_SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });
  return resp.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
