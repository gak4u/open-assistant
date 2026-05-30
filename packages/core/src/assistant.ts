import { randomUUID } from "node:crypto";
import {
  EntityExtractor,
  MemoryStore,
  applyIdentityUpdate,
  detectIdentities,
  getIdentities,
  ingestText,
  type Entity,
  type Identities,
  type Relation,
  type SubgraphResult,
} from "@open-assistant/memory";
import { AnthropicProvider, ClaudeCliProvider, OllamaProvider, selectProvider, type ChatMessage, type LLMProvider } from "./llm.js";

export interface AssistantOptions {
  memory?: MemoryStore;
  extractor?: EntityExtractor;
  provider?: LLMProvider;
  sessionId?: string;
  /** Skip the LLM-based entity extraction step (faster, no memory writes). */
  ingest?: boolean;
}

export interface AskResult {
  reply: string;
  sessionId: string;
  turnIds: { user: string; assistant: string };
  memoryUsed: SubgraphResult;
  model: string;
  identities: Identities;
}

export type StreamPhase = "searching" | "thinking" | "writing" | "finalizing";

export type AssistantStreamEvent =
  | { type: "status"; phase: StreamPhase; text: string }
  | { type: "identity"; identities: Identities }
  | { type: "text"; text: string }
  | {
      type: "done";
      sessionId: string;
      turnIds: { user: string; assistant: string };
      memoryUsed: SubgraphResult;
      model: string;
      identities: Identities;
      reply: string;
    }
  | { type: "error"; error: string };

const DEFAULT_SYSTEM = `You are open-assistant, a helpful, concise AI with persistent memory of past
conversations. You will sometimes receive a MEMORY block summarizing what the
graph store knows about the user's world — cite or use it when relevant, but
do not invent facts beyond it. When the user tells you something durable
about a person, project, or fact, acknowledge briefly and trust the system to
persist it.`;

export class Assistant {
  readonly memory: MemoryStore;
  readonly extractor: EntityExtractor;
  readonly provider: LLMProvider;
  readonly sessionId: string;
  private readonly ingest: boolean;

  constructor(opts: AssistantOptions = {}) {
    this.memory = opts.memory ?? new MemoryStore();
    this.provider = opts.provider ?? selectProvider();
    this.extractor = opts.extractor ?? new EntityExtractor({ provider: this.provider });
    this.sessionId = opts.sessionId ?? randomUUID();
    this.ingest = opts.ingest ?? true;
  }

  /**
   * Non-streaming entrypoint — kept for callers (CLI, MCP tools) that just
   * want the final reply. Internally delegates to askStream.
   */
  async ask(prompt: string, opts: { system?: string; maxTokens?: number } = {}): Promise<AskResult> {
    let result: AskResult | null = null;
    let error: string | null = null;
    for await (const event of this.askStream(prompt, opts)) {
      if (event.type === "done") {
        result = {
          reply: event.reply,
          sessionId: event.sessionId,
          turnIds: event.turnIds,
          memoryUsed: event.memoryUsed,
          model: event.model,
          identities: event.identities,
        };
      } else if (event.type === "error") {
        error = event.error;
      }
    }
    if (error) throw new Error(error);
    if (!result) throw new Error("askStream finished without a `done` event");
    return result;
  }

  /**
   * Streaming entrypoint. Emits status events for the UI, streams text
   * chunks token-by-token, and fires entity extraction in the background
   * so it never blocks the response.
   */
  async *askStream(
    prompt: string,
    opts: { system?: string; maxTokens?: number } = {},
  ): AsyncGenerator<AssistantStreamEvent, void, void> {
    const userTurnId = randomUUID();
    const assistantTurnId = randomUUID();
    const now = Date.now();

    // Identity detection runs synchronously — names are cheap to extract via
    // regex and useful to surface immediately.
    const identityUpdate = detectIdentities(prompt);
    let identities = await getIdentities(this.memory).catch(() => ({ user: null, assistant: null }));
    if (identityUpdate.user || identityUpdate.assistant) {
      identities = await applyIdentityUpdate(this.memory, identityUpdate).catch(() => identities);
      yield { type: "identity", identities };
    }

    // Record the user turn now (fast) so it appears in history regardless of
    // whether extraction succeeds.
    await this.memory
      .recordTurn(
        { id: userTurnId, session_id: this.sessionId, role: "user", content: prompt, created_at: now },
        [],
      )
      .catch(() => undefined);

    // Fire entity extraction for the user prompt in the background. We don't
    // wait — the LLM call below can run in parallel.
    const userExtraction = this.ingest
      ? ingestText(this.memory, this.extractor, prompt, {
          sessionId: this.sessionId,
          turnId: userTurnId,
          role: "user",
          createdAt: now,
        }).catch((err) => {
          // eslint-disable-next-line no-console
          console.warn("[assistant] user extraction failed:", err);
          return { mentions: [] as string[], entities: [] as Entity[], relations: [] as Relation[] };
        })
      : Promise.resolve({ mentions: [] as string[], entities: [] as Entity[], relations: [] as Relation[] });

    yield { type: "status", phase: "searching", text: "Searching memory…" };

    // Retrieve memory using a fulltext search on the prompt. We deliberately
    // skip waiting for the new extraction to land — the search already covers
    // the prompt's content directly.
    const subgraph = await this.retrieveMemory(prompt).catch(() => ({ entities: [], relations: [] }));

    yield { type: "status", phase: "thinking", text: "Thinking…" };

    // Build the messages array.
    const history = await this.memory.recentTurns(this.sessionId, 12).catch(() => []);
    const messages: ChatMessage[] = [];
    const memoryBlock = formatMemoryBlock(subgraph, identities);
    if (memoryBlock) messages.push({ role: "system", content: memoryBlock });
    for (const t of history) {
      if (t.id === userTurnId) continue;
      if (t.role === "user" || t.role === "assistant") {
        messages.push({ role: t.role, content: t.content });
      }
    }
    messages.push({ role: "user", content: prompt });

    yield { type: "status", phase: "writing", text: "Writing response…" };

    // Stream the LLM response.
    let model = this.provider.name;
    let fullText = "";
    let firstChunk = true;
    try {
      for await (const event of this.provider.stream(messages, {
        system: opts.system ?? DEFAULT_SYSTEM,
        maxTokens: opts.maxTokens,
      })) {
        if (event.type === "text") {
          if (firstChunk) firstChunk = false;
          fullText += event.text;
          yield { type: "text", text: event.text };
        } else if (event.type === "done") {
          model = event.model;
          if (event.text && !fullText) fullText = event.text;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: "error", error: msg };
      return;
    }

    // Assistant turn: record now, extract in background.
    const assistantNow = Date.now();
    await this.memory
      .recordTurn(
        {
          id: assistantTurnId,
          session_id: this.sessionId,
          role: "assistant",
          content: fullText,
          created_at: assistantNow,
        },
        [],
      )
      .catch(() => undefined);

    if (this.ingest && fullText.trim()) {
      void ingestText(this.memory, this.extractor, fullText, {
        sessionId: this.sessionId,
        turnId: assistantTurnId,
        role: "assistant",
        createdAt: assistantNow,
      }).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn("[assistant] assistant extraction failed:", err);
      });
    }

    // Wait for the in-flight user extraction so the caller's "done" event
    // reflects a settled graph state (it usually finishes mid-stream anyway).
    await userExtraction;

    yield {
      type: "done",
      sessionId: this.sessionId,
      turnIds: { user: userTurnId, assistant: assistantTurnId },
      memoryUsed: subgraph,
      model,
      identities,
      reply: fullText,
    };
  }

  /** Look up the most relevant subgraph for a prompt. */
  async retrieveMemory(prompt: string, seedIds: string[] = []): Promise<SubgraphResult> {
    const hits = await this.memory.searchEntities(prompt, 8).catch(() => []);
    const ids = new Set<string>(seedIds);
    for (const h of hits) ids.add(h.entity.id);
    // Skip the identity marker nodes from the retrieved context — the memory
    // block already includes them via the identities header.
    ids.delete("identity:user");
    ids.delete("identity:assistant");
    if (ids.size === 0) return { entities: [], relations: [] };
    return this.memory.subgraphForEntities([...ids], 1);
  }
}

function formatMemoryBlock(sub: SubgraphResult, identities: Identities): string | null {
  const hasGraph = sub.entities.length || sub.relations.length;
  const hasIdent = identities.user || identities.assistant;
  if (!hasGraph && !hasIdent) return null;

  const lines: string[] = [];
  if (hasIdent) {
    lines.push("IDENTITIES:");
    if (identities.user) lines.push(`- The human you are talking to is named ${identities.user}.`);
    if (identities.assistant) {
      lines.push(
        `- You have been named "${identities.assistant}" by the user. Refer to yourself by that name when natural.`,
      );
    }
    lines.push("");
  }

  if (hasGraph) {
    lines.push("MEMORY (from graph store — use when relevant):");
    if (sub.entities.length) {
      lines.push("Entities:");
      for (const e of sub.entities.slice(0, 30)) {
        lines.push(`- (${e.type}) ${e.name}${e.description ? ` — ${e.description}` : ""}`);
      }
      lines.push("");
    }
    if (sub.relations.length) {
      lines.push("Relations:");
      for (const r of sub.relations.slice(0, 50)) {
        lines.push(`- ${r.from} —[${r.type}]→ ${r.to}${r.context ? ` (${r.context})` : ""}`);
      }
    }
  }
  return lines.join("\n").trim();
}

export { AnthropicProvider, ClaudeCliProvider, OllamaProvider };
