import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Assistant, currentConfig, onboardingCoordinator, type OnboardingEvent } from "@open-assistant/core";
import { AgentQueue } from "@open-assistant/agent";
import { EntityTypes, MemoryStore, entityId } from "@open-assistant/memory";

export interface BuildServerOptions {
  assistant?: Assistant;
  memory?: MemoryStore;
  queue?: AgentQueue;
}

export interface OpenAssistantServer {
  server: McpServer;
  assistant: Assistant;
  memory: MemoryStore;
  queue: AgentQueue;
}

/** Build an MCP server with the open-assistant tools registered. */
export function buildServer(opts: BuildServerOptions = {}): OpenAssistantServer {
  const memory = opts.memory ?? new MemoryStore();
  const assistant = opts.assistant ?? new Assistant({ memory });
  const queue = opts.queue ?? new AgentQueue();

  const server = new McpServer(
    { name: "open-assistant", version: "0.1.0" },
    {
      capabilities: { tools: {}, resources: {}, logging: {} },
      instructions:
        "Persistent, graph-backed personal assistant. Use `ask` for memory-augmented Q&A, " +
        "`remember`/`forget` to manage entities directly, `search_memory` to query the graph, " +
        "`run_agent` to dispatch a long-running sub-agent task, and `run_onboarding` to " +
        "scan your Claude Code sessions + code directories and seed the memory graph. " +
        "Read `onboarding://status` for the current onboarding state.",
    },
  );

  server.tool(
    "ask",
    "Ask open-assistant a question. Pulls relevant memory automatically and persists the turn.",
    {
      question: z.string().min(1).describe("The question or instruction"),
      session_id: z.string().optional().describe("Optional session ID to continue an existing conversation"),
    },
    async ({ question, session_id }) => {
      const a = session_id
        ? new Assistant({ memory, sessionId: session_id, provider: assistant.provider, extractor: assistant.extractor })
        : assistant;
      const result = await a.ask(question);
      return {
        content: [
          { type: "text", text: result.reply },
          {
            type: "text",
            text: `\n---\n(session ${result.sessionId}, ${result.memoryUsed.entities.length} memory entities used)`,
          },
        ],
      };
    },
  );

  server.tool(
    "remember",
    "Insert or update an entity in the graph memory. Optionally connect it to another entity.",
    {
      name: z.string().min(1),
      type: z.enum(EntityTypes),
      description: z.string().optional(),
      related_to: z
        .object({
          name: z.string(),
          type: z.enum(EntityTypes),
          relation: z.string().default("related_to"),
        })
        .optional()
        .describe("Optional entity to link this one to"),
    },
    async ({ name, type, description, related_to }) => {
      const entity = await memory.upsertEntity({ name, type, description });
      if (related_to) {
        const other = await memory.upsertEntity({ name: related_to.name, type: related_to.type });
        await memory.addRelation({
          from: entity.id,
          to: other.id,
          // We trust the caller here; unknown relation strings get stored under "related_to".
          type: (related_to.relation as never) ?? "related_to",
        });
        return {
          content: [
            {
              type: "text",
              text: `Remembered ${entity.id} and linked to ${other.id} via ${related_to.relation}.`,
            },
          ],
        };
      }
      return { content: [{ type: "text", text: `Remembered ${entity.id}.` }] };
    },
  );

  server.tool(
    "forget",
    "Delete an entity (and all its relations) from memory by name+type or by id.",
    {
      id: z.string().optional(),
      name: z.string().optional(),
      type: z.enum(EntityTypes).optional(),
    },
    async ({ id, name, type }) => {
      const target = id ?? (name && type ? entityId(type, name) : null);
      if (!target) {
        return {
          isError: true,
          content: [{ type: "text", text: "Provide either `id` or both `name` and `type`." }],
        };
      }
      const ok = await memory.forgetEntity(target);
      return {
        content: [{ type: "text", text: ok ? `Forgot ${target}.` : `No entity matched ${target}.` }],
      };
    },
  );

  server.tool(
    "search_memory",
    "Full-text search the entity graph and return top matches with their immediate neighbours.",
    {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(50).default(10),
      include_neighbours: z.boolean().default(true),
    },
    async ({ query, limit, include_neighbours }) => {
      const hits = await memory.searchEntities(query, limit);
      const blocks: string[] = [];
      if (!hits.length) return { content: [{ type: "text", text: "No matches." }] };
      for (const h of hits) {
        blocks.push(`(${h.entity.type}) ${h.entity.name} — ${h.entity.description ?? ""}`.trim());
      }
      let neighboursText = "";
      if (include_neighbours) {
        const sub = await memory.subgraphForEntities(hits.map((h) => h.entity.id), 1);
        if (sub.relations.length) {
          neighboursText =
            "\n\nRelations:\n" +
            sub.relations
              .slice(0, 50)
              .map((r) => `- ${r.from} —[${r.type}]→ ${r.to}`)
              .join("\n");
        }
      }
      return { content: [{ type: "text", text: blocks.join("\n") + neighboursText }] };
    },
  );

  server.tool(
    "run_agent",
    "Queue a remote sub-agent task. Returns a task ID; use `agent_status` to poll.",
    {
      task: z.string().min(1).describe("The task description for the sub-agent"),
      wait: z
        .boolean()
        .default(false)
        .describe("If true, block until the task finishes (suitable for short tasks only)"),
    },
    async ({ task, wait }) => {
      const enqueued = await queue.enqueue(task);
      if (!wait) {
        return {
          content: [
            { type: "text", text: `Queued task ${enqueued.id}. Poll with agent_status.` },
          ],
        };
      }
      // In-line execution: import lazily so the MCP server stays cheap to load.
      const { AgentRunner } = await import("@open-assistant/agent");
      const runner = new AgentRunner({ queue, memory });
      const result = await runner.runTask(enqueued);
      return { content: [{ type: "text", text: result.output }] };
    },
  );

  server.tool(
    "agent_status",
    "Look up a previously queued agent task by ID.",
    { id: z.string().min(1) },
    async ({ id }) => {
      const task = await queue.get(id);
      if (!task) return { isError: true, content: [{ type: "text", text: `No task ${id}.` }] };
      const text = [
        `id: ${task.id}`,
        `status: ${task.status}`,
        task.workdir ? `workdir: ${task.workdir}` : null,
        task.error ? `error: ${task.error}` : null,
        task.result ? `\n---\n${task.result}` : null,
      ]
        .filter(Boolean)
        .join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  // ---------------------------- Onboarding ---------------------------------

  const coordinator = onboardingCoordinator();

  server.tool(
    "run_onboarding",
    "Scan Claude Code sessions, discover code repos, and seed the memory graph with one project entity per repo. Streams progress lines and returns a final summary. Pass lightweight=true to skip the filesystem repo scan (sessions only).",
    {
      lightweight: z
        .boolean()
        .default(false)
        .describe("Skip the filesystem repo discovery — only seed projects from Claude Code sessions"),
    },
    async ({ lightweight }) => {
      const isFresh = coordinator.isIdle();
      // Collect events emitted during THIS call (not historical ones).
      const captured: OnboardingEvent[] = [];
      const off = coordinator.on("event", (e) => captured.push(e));
      try {
        const summary = await coordinator.start(memory, { lightweight });
        const text = renderOnboardingText({
          lightweight,
          attachedToExistingRun: !isFresh,
          events: captured,
          summary,
        });
        return { content: [{ type: "text", text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text", text: `Onboarding failed: ${msg}` }],
        };
      } finally {
        off();
      }
    },
  );

  server.tool(
    "onboarding_status",
    "Get the current onboarding state (never_run / in_progress / completed) and last summary.",
    {},
    async () => {
      const text = formatOnboardingStatusText();
      return { content: [{ type: "text", text }] };
    },
  );

  server.resource(
    "onboarding-status",
    "onboarding://status",
    {
      description: "Current onboarding state — never_run / in_progress / completed — plus the last run's summary.",
      mimeType: "application/json",
    },
    async (uri) => {
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(buildStatusPayload(), null, 2),
          },
        ],
      };
    },
  );

  // Auto-trigger lightweight onboarding the first time a server is built when
  // the user has never run it. Guarded by the config flag so multiple MCP
  // processes (Claude Code + Claude Desktop both connecting) don't all retry.
  maybeAutoOnboard(memory, server);

  return { server, assistant, memory, queue };
}

// ============================ helpers ====================================

function buildStatusPayload() {
  const cfg = currentConfig();
  const snap = onboardingCoordinator().current_snapshot();
  const stateFromCoordinator: "never_run" | "in_progress" | "completed" | "error" =
    snap.state === "running"
      ? "in_progress"
      : snap.state === "done"
        ? "completed"
        : snap.state === "error"
          ? "error"
          : cfg.onboarding.completed
            ? "completed"
            : "never_run";
  return {
    state: stateFromCoordinator,
    completed: cfg.onboarding.completed,
    lastRunAt: cfg.onboarding.lastRunAt,
    lastSummary: cfg.onboarding.lastSummary,
    currentRun:
      snap.state === "running"
        ? {
            startedAt: snap.startedAt,
            lightweight: snap.lightweight,
            recentEvents: snap.events.slice(-5),
          }
        : null,
    error: snap.error ?? null,
  };
}

function formatOnboardingStatusText(): string {
  const p = buildStatusPayload();
  const lines: string[] = [`state: ${p.state}`];
  if (p.lastRunAt) {
    lines.push(`last run: ${new Date(p.lastRunAt).toISOString()}`);
    const s = p.lastSummary;
    if (s) {
      lines.push(
        `last summary: ${s.projectsCreated} projects, ${s.sessionsFound} sessions, ${s.reposFound} repos, ` +
          `${s.entitiesCreated} entities, ${s.relationsCreated} relations`,
      );
    }
  } else {
    lines.push("(no completed run yet)");
  }
  if (p.currentRun) {
    lines.push(
      `currently running (${p.currentRun.lightweight ? "lightweight" : "full"}) since ` +
        new Date(p.currentRun.startedAt).toISOString(),
    );
  }
  if (p.error) lines.push(`last error: ${p.error}`);
  return lines.join("\n");
}

function renderOnboardingText(args: {
  lightweight: boolean;
  attachedToExistingRun: boolean;
  events: OnboardingEvent[];
  summary: { sessionsFound: number; reposFound: number; projectsCreated: number; entitiesCreated: number; relationsCreated: number; durationMs?: number };
}): string {
  const lines: string[] = [];
  lines.push(args.lightweight ? "▷ Lightweight onboarding (sessions only)" : "▷ Onboarding");
  if (args.attachedToExistingRun) lines.push("(attached to an in-flight run; results below reflect the shared state)");
  lines.push("");
  for (const e of args.events) {
    if (e.type === "phase") lines.push(`▸ ${e.phase ?? ""}${e.message ? ` — ${e.message}` : ""}`);
    else if (e.type === "message" && e.message) lines.push(`  ${e.message}`);
    else if (e.type === "error" && e.error) lines.push(`  ✗ ${e.error}`);
  }
  lines.push("");
  lines.push("── summary ──");
  const s = args.summary;
  lines.push(`  projects:   ${s.projectsCreated}`);
  lines.push(`  sessions:   ${s.sessionsFound}`);
  lines.push(`  repos:      ${s.reposFound}`);
  lines.push(`  entities:   ${s.entitiesCreated}`);
  lines.push(`  relations:  ${s.relationsCreated}`);
  if (typeof s.durationMs === "number") lines.push(`  took:       ${(s.durationMs / 1000).toFixed(1)}s`);
  return lines.join("\n");
}

// Module-level guard so a single process never auto-runs twice even when
// multiple buildServer() calls happen (HTTP daemon makes one per session).
let autoAttempted = false;

function maybeAutoOnboard(memory: MemoryStore, server: McpServer): void {
  if (autoAttempted) return;
  autoAttempted = true;
  let cfg;
  try {
    cfg = currentConfig();
  } catch {
    return;
  }
  if (cfg.onboarding.completed) return;
  const coord = onboardingCoordinator();
  if (!coord.isIdle()) return;

  // Fire-and-forget. The coordinator persists the completion flag, so
  // subsequent buildServer() calls (in this process or in other MCP clients)
  // skip the auto-run.
  coord
    .start(memory, { lightweight: true })
    .then((summary) => {
      const message =
        `open-assistant: first-connect onboarding (lightweight) complete — ` +
        `${summary.projectsCreated ?? 0} projects · ${summary.sessionsFound ?? 0} sessions · ` +
        `${summary.entitiesCreated ?? 0} entities. Call \`run_onboarding\` for the full sweep ` +
        `(includes filesystem repo discovery).`;
      // Notify clients that subscribed to logging. Wrapped in try because not
      // every client supports it.
      try {
        server.server.sendLoggingMessage({ level: "info", data: message });
      } catch {
        /* not subscribed — that's fine */
      }
    })
    .catch((err) => {
      try {
        server.server.sendLoggingMessage({
          level: "error",
          data: `open-assistant: auto-onboarding failed — ${err instanceof Error ? err.message : String(err)}`,
        });
      } catch {
        /* swallow */
      }
    });
}
