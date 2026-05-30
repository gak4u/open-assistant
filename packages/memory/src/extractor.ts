import Anthropic from "@anthropic-ai/sdk";
import {
  EntityTypes,
  ExtractionResult,
  RelationTypes,
  type ExtractionResult as ExtractionResultT,
} from "./schema.js";

const SYSTEM_PROMPT = `You extract structured knowledge from conversations into a typed graph.

Output STRICT JSON matching this shape — no prose, no markdown fences:
{
  "entities": [{ "name": string, "type": EntityType, "description"?: string }],
  "relations": [{ "from": string, "to": string, "type": RelationType, "context"?: string }]
}

EntityType ∈ ${JSON.stringify(EntityTypes)}
RelationType ∈ ${JSON.stringify(RelationTypes)}

Rules:
- Use the entity name verbatim from the text when possible.
- Relations reference entities by name; both "from" and "to" must appear in the entities array.
- Skip vague references ("the project", "the meeting") without a concrete name.
- Prefer fewer high-signal entities to many noisy ones.
- If nothing extractable, return {"entities": [], "relations": []}.`;

/**
 * Minimal interface the extractor needs from any LLM. Matches @open-assistant/core's
 * LLMProvider so callers can pass the same provider used for chat.
 */
export interface ExtractorLLM {
  complete(
    messages: { role: "user" | "assistant" | "system"; content: string }[],
    opts?: { system?: string; maxTokens?: number },
  ): Promise<{ text: string }>;
}

export interface ExtractorOptions {
  /** Plug in any LLM provider (preferred). */
  provider?: ExtractorLLM;
  /** Legacy: use the Anthropic SDK directly with an API key. */
  apiKey?: string;
  model?: string;
  maxTokens?: number;
}

export class EntityExtractor {
  private readonly provider: ExtractorLLM | null;
  private readonly maxTokens: number;

  constructor(opts: ExtractorOptions = {}) {
    if (opts.provider) {
      this.provider = opts.provider;
    } else {
      const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
      const model = opts.model ?? process.env.OA_MODEL ?? "claude-sonnet-4-20250514";
      this.provider = apiKey ? new AnthropicExtractor(apiKey, model) : null;
    }
    this.maxTokens = opts.maxTokens ?? 1024;
  }

  async extract(text: string): Promise<ExtractionResultT> {
    if (!text.trim() || !this.provider) return { entities: [], relations: [] };

    const resp = await this.provider.complete(
      [{ role: "user", content: `Extract entities and relations from this text:\n\n<<<\n${text}\n>>>` }],
      { system: SYSTEM_PROMPT, maxTokens: this.maxTokens },
    );

    const json = stripFences(resp.text.trim());
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { entities: [], relations: [] };
    }
    const result = ExtractionResult.safeParse(parsed);
    return result.success ? result.data : { entities: [], relations: [] };
  }
}

class AnthropicExtractor implements ExtractorLLM {
  private readonly client: Anthropic;
  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey });
  }
  async complete(
    messages: { role: "user" | "assistant" | "system"; content: string }[],
    opts: { system?: string; maxTokens?: number } = {},
  ): Promise<{ text: string }> {
    const dialogue = messages.filter((m) => m.role !== "system");
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: opts.maxTokens ?? 1024,
      system: opts.system,
      messages: dialogue.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    });
    const text = resp.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return { text };
  }
}

function stripFences(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (m?.[1] ?? s).trim();
}
