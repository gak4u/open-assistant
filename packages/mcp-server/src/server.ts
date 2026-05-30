import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Assistant } from "@open-assistant/core";
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
      capabilities: { tools: {}, resources: {} },
      instructions:
        "Persistent, graph-backed personal assistant. Use `ask` for memory-augmented Q&A, " +
        "`remember`/`forget` to manage entities directly, `search_memory` to query the graph, " +
        "and `run_agent` to dispatch a long-running sub-agent task.",
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

  return { server, assistant, memory, queue };
}
