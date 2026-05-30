import { randomUUID } from "node:crypto";
import {
  EntityExtractor,
  MemoryStore,
  ingestText,
  type Entity,
  type Relation,
  type SubgraphResult,
} from "@open-assistant/memory";
import { AnthropicProvider, OllamaProvider, selectProvider, type ChatMessage, type LLMProvider } from "./llm.js";

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
}

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
    // Share the chat provider with the extractor by default so both code paths
    // use the same auth (e.g. claude-cli session) without extra configuration.
    this.extractor = opts.extractor ?? new EntityExtractor({ provider: this.provider });
    this.sessionId = opts.sessionId ?? randomUUID();
    this.ingest = opts.ingest ?? true;
  }

  async ask(prompt: string, opts: { system?: string; maxTokens?: number } = {}): Promise<AskResult> {
    const userTurnId = randomUUID();
    const assistantTurnId = randomUUID();
    const now = Date.now();

    // 1) Ingest user turn → entities/relations → mentions
    let mentions: string[] = [];
    if (this.ingest) {
      try {
        const ing = await ingestText(this.memory, this.extractor, prompt, {
          sessionId: this.sessionId,
          turnId: userTurnId,
          role: "user",
          createdAt: now,
        });
        mentions = ing.mentions;
      } catch (err) {
        // If extraction fails (e.g. no API key), still log the turn unaugmented.
        await this.memory.recordTurn(
          { id: userTurnId, session_id: this.sessionId, role: "user", content: prompt, created_at: now },
          [],
        );
      }
    } else {
      await this.memory.recordTurn(
        { id: userTurnId, session_id: this.sessionId, role: "user", content: prompt, created_at: now },
        [],
      );
    }

    // 2) Retrieve relevant memory subgraph (mentioned entities + 1-hop neighbours,
    //    augmented by a fulltext search over the prompt)
    const subgraph = await this.retrieveMemory(prompt, mentions);

    // 3) Compose context and call the LLM
    const history = await this.memory.recentTurns(this.sessionId, 12);
    const messages: ChatMessage[] = [];
    const memoryBlock = formatMemoryBlock(subgraph);
    if (memoryBlock) {
      messages.push({ role: "system", content: memoryBlock });
    }
    for (const t of history) {
      if (t.id === userTurnId) continue;
      if (t.role === "user" || t.role === "assistant") {
        messages.push({ role: t.role, content: t.content });
      }
    }
    messages.push({ role: "user", content: prompt });

    const completion = await this.provider.complete(messages, {
      system: opts.system ?? DEFAULT_SYSTEM,
      maxTokens: opts.maxTokens,
    });

    // 4) Persist assistant turn (and extract entities from it too)
    if (this.ingest) {
      try {
        await ingestText(this.memory, this.extractor, completion.text, {
          sessionId: this.sessionId,
          turnId: assistantTurnId,
          role: "assistant",
          createdAt: Date.now(),
        });
      } catch {
        await this.memory.recordTurn(
          {
            id: assistantTurnId,
            session_id: this.sessionId,
            role: "assistant",
            content: completion.text,
            created_at: Date.now(),
          },
          [],
        );
      }
    } else {
      await this.memory.recordTurn(
        {
          id: assistantTurnId,
          session_id: this.sessionId,
          role: "assistant",
          content: completion.text,
          created_at: Date.now(),
        },
        [],
      );
    }

    return {
      reply: completion.text,
      sessionId: this.sessionId,
      turnIds: { user: userTurnId, assistant: assistantTurnId },
      memoryUsed: subgraph,
      model: completion.model,
    };
  }

  /** Look up the most relevant subgraph for a prompt. */
  async retrieveMemory(prompt: string, seedIds: string[] = []): Promise<SubgraphResult> {
    const hits = await this.memory.searchEntities(prompt, 8).catch(() => []);
    const ids = new Set<string>(seedIds);
    for (const h of hits) ids.add(h.entity.id);
    if (ids.size === 0) return { entities: [], relations: [] };
    return this.memory.subgraphForEntities([...ids], 1);
  }
}

function formatMemoryBlock(sub: SubgraphResult): string | null {
  if (!sub.entities.length && !sub.relations.length) return null;
  const entitiesPart = sub.entities
    .slice(0, 30)
    .map((e: Entity) => `- (${e.type}) ${e.name}${e.description ? ` — ${e.description}` : ""}`)
    .join("\n");
  const relationsPart = sub.relations
    .slice(0, 50)
    .map((r: Relation) => `- ${r.from} —[${r.type}]→ ${r.to}${r.context ? ` (${r.context})` : ""}`)
    .join("\n");
  return [
    "MEMORY (from graph store — use when relevant):",
    entitiesPart && `Entities:\n${entitiesPart}`,
    relationsPart && `Relations:\n${relationsPart}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export { AnthropicProvider, OllamaProvider };
