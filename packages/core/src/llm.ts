import Anthropic from "@anthropic-ai/sdk";
import { spawn, spawnSync } from "node:child_process";
import { currentConfig, type Config } from "./config.js";

export type Role = "user" | "assistant" | "system";

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface LLMCompletion {
  text: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "done"; text: string; model: string; inputTokens?: number; outputTokens?: number };

export interface LLMProvider {
  readonly name: string;
  complete(messages: ChatMessage[], opts?: { system?: string; maxTokens?: number }): Promise<LLMCompletion>;
  stream(
    messages: ChatMessage[],
    opts?: { system?: string; maxTokens?: number },
  ): AsyncIterable<StreamEvent>;
}

export interface AnthropicProviderOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.client = new Anthropic({ apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY });
    this.model = opts.model ?? process.env.OA_MODEL ?? "claude-sonnet-4-20250514";
    this.maxTokens = opts.maxTokens ?? Number(process.env.OA_MAX_TOKENS ?? 4096);
  }

  get isConfigured(): boolean {
    return !!this.client.apiKey;
  }

  async complete(
    messages: ChatMessage[],
    opts: { system?: string; maxTokens?: number } = {},
  ): Promise<LLMCompletion> {
    const { system, dialogue } = splitSystem(messages, opts.system);
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: opts.maxTokens ?? this.maxTokens,
      system,
      messages: dialogue.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    });
    const text = resp.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return {
      text,
      model: this.model,
      inputTokens: resp.usage?.input_tokens,
      outputTokens: resp.usage?.output_tokens,
    };
  }

  async *stream(
    messages: ChatMessage[],
    opts: { system?: string; maxTokens?: number } = {},
  ): AsyncIterable<StreamEvent> {
    const { system, dialogue } = splitSystem(messages, opts.system);
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: opts.maxTokens ?? this.maxTokens,
      system,
      messages: dialogue.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    });
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { type: "text", text: event.delta.text };
      }
    }
    const final = await stream.finalMessage();
    const text = final.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    yield {
      type: "done",
      text,
      model: this.model,
      inputTokens: final.usage?.input_tokens,
      outputTokens: final.usage?.output_tokens,
    };
  }
}

export interface OllamaProviderOptions {
  baseUrl?: string;
  model?: string;
}

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(opts: OllamaProviderOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    this.model = opts.model ?? process.env.OLLAMA_MODEL ?? "llama3.2";
  }

  async complete(
    messages: ChatMessage[],
    opts: { system?: string; maxTokens?: number } = {},
  ): Promise<LLMCompletion> {
    const { system, dialogue } = splitSystem(messages, opts.system);
    const body = {
      model: this.model,
      stream: false,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        ...dialogue.map((m) => ({ role: m.role, content: m.content })),
      ],
      options: { num_predict: opts.maxTokens ?? 1024 },
    };
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { message?: { content?: string } };
    return { text: data.message?.content ?? "", model: this.model };
  }

  async *stream(
    messages: ChatMessage[],
    opts: { system?: string; maxTokens?: number } = {},
  ): AsyncIterable<StreamEvent> {
    const { system, dialogue } = splitSystem(messages, opts.system);
    const body = {
      model: this.model,
      stream: true,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        ...dialogue.map((m) => ({ role: m.role, content: m.content })),
      ],
      options: { num_predict: opts.maxTokens ?? 1024 },
    };
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) throw new Error(`Ollama error ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let full = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
          const chunk = evt.message?.content;
          if (chunk) {
            full += chunk;
            yield { type: "text", text: chunk };
          }
        } catch {
          /* ignore malformed lines */
        }
      }
    }
    yield { type: "done", text: full, model: this.model };
  }
}

export interface ClaudeCliProviderOptions {
  binary?: string;
  model?: string;
}

/**
 * Spawns the local `claude` CLI in print mode. Uses the user's Claude Code
 * session auth, so no raw API key is needed. Real token streaming via
 * `--output-format stream-json --include-partial-messages`.
 */
export class ClaudeCliProvider implements LLMProvider {
  readonly name = "claude-cli";
  private readonly binary: string;
  private readonly model?: string;

  constructor(opts: ClaudeCliProviderOptions = {}) {
    this.binary = opts.binary ?? "claude";
    this.model = opts.model ?? process.env.OA_CLAUDE_CLI_MODEL;
  }

  static isAvailable(binary = "claude"): boolean {
    try {
      const r = spawnSync("which", [binary], { stdio: "ignore" });
      return r.status === 0;
    } catch {
      return false;
    }
  }

  complete(messages: ChatMessage[], opts: { system?: string; maxTokens?: number } = {}): Promise<LLMCompletion> {
    const prompt = flattenForCli(messages, opts.system);
    return new Promise((resolve, reject) => {
      const args = ["-p", prompt, "--output-format", "text"];
      if (this.model) args.push("--model", this.model);
      const child = spawn(this.binary, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve({ text: stdout.trim(), model: this.model ?? "claude-cli" });
        else reject(new Error(`claude CLI exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
      });
    });
  }

  async *stream(
    messages: ChatMessage[],
    opts: { system?: string; maxTokens?: number } = {},
  ): AsyncIterable<StreamEvent> {
    const prompt = flattenForCli(messages, opts.system);
    const args = [
      "-p", prompt,
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
    ];
    if (this.model) args.push("--model", this.model);

    const child = spawn(this.binary, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });

    type StreamEvt =
      | { type: "stream_event"; event: { type: string; content_block?: { type: string }; delta?: { type: string; text?: string }; index?: number } }
      | { type: "result"; result?: string; is_error?: boolean }
      | { type: string; [k: string]: unknown };

    const events: StreamEvent[] = [];
    let waker: (() => void) | null = null;
    const wake = () => {
      if (waker) {
        const w = waker;
        waker = null;
        w();
      }
    };

    let done = false;
    let error: Error | null = null;
    let full = "";
    // Track block kinds by index — claude streams a "thinking" block first
    // (with signature_delta junk) then a "text" block. We only forward text.
    const blockKinds = new Map<number, string>();

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let evt: StreamEvt;
      try {
        evt = JSON.parse(line) as StreamEvt;
      } catch {
        return;
      }
      if (evt.type === "stream_event") {
        const inner = (evt as { event: { type: string; index?: number; content_block?: { type: string }; delta?: { type: string; text?: string } } }).event;
        if (inner.type === "content_block_start" && typeof inner.index === "number" && inner.content_block) {
          blockKinds.set(inner.index, inner.content_block.type);
        } else if (inner.type === "content_block_delta" && typeof inner.index === "number") {
          const kind = blockKinds.get(inner.index);
          if (kind === "text" && inner.delta?.type === "text_delta" && typeof inner.delta.text === "string") {
            full += inner.delta.text;
            events.push({ type: "text", text: inner.delta.text });
            wake();
          }
        }
      } else if (evt.type === "result") {
        const r = evt as { is_error?: boolean; result?: string };
        if (r.is_error) {
          error = new Error(r.result ?? "claude CLI returned error");
        } else if (typeof r.result === "string" && !full) {
          // Fallback: result-only mode (older claude versions).
          full = r.result;
          events.push({ type: "text", text: r.result });
        }
      }
    };

    let stderrBuf = "";
    child.stderr.on("data", (d: Buffer) => {
      stderrBuf += d.toString("utf8");
    });

    let stdoutBuf = "";
    child.stdout.on("data", (d: Buffer) => {
      stdoutBuf += d.toString("utf8");
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    });

    child.on("error", (err) => {
      error = err;
      done = true;
      wake();
    });

    child.on("close", (code) => {
      if (stdoutBuf.trim()) handleLine(stdoutBuf);
      if (code !== 0 && !error) {
        error = new Error(`claude CLI exited with code ${code}: ${stderrBuf.trim()}`);
      }
      done = true;
      wake();
    });

    while (true) {
      while (events.length) yield events.shift()!;
      if (done) break;
      await new Promise<void>((resolve) => {
        waker = resolve;
      });
    }

    if (error) throw error;
    yield { type: "done", text: full, model: this.model ?? "claude-cli" };
  }
}

export interface OpenAICompatibleOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Speaks the OpenAI `chat/completions` API. Works with the OpenAI cloud,
 * vLLM, LM Studio, Together, Groq, and any other server that mirrors the
 * schema. Streaming uses standard SSE `data:` frames.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name = "openai-compatible";
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly temperature: number | undefined;
  private readonly maxTokens: number;

  constructor(opts: OpenAICompatibleOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.model = opts.model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";
    this.temperature = opts.temperature;
    this.maxTokens = opts.maxTokens ?? Number(process.env.OA_MAX_TOKENS ?? 4096);
  }

  private buildBody(messages: ChatMessage[], system: string | undefined, stream: boolean): string {
    const msgs: { role: string; content: string }[] = [];
    if (system) msgs.push({ role: "system", content: system });
    for (const m of messages) {
      if (m.role === "system") continue;
      msgs.push({ role: m.role, content: m.content });
    }
    const body: Record<string, unknown> = {
      model: this.model,
      messages: msgs,
      max_tokens: this.maxTokens,
      stream,
    };
    if (typeof this.temperature === "number") body["temperature"] = this.temperature;
    return JSON.stringify(body);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) h["authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  async complete(
    messages: ChatMessage[],
    opts: { system?: string; maxTokens?: number } = {},
  ): Promise<LLMCompletion> {
    const { system, dialogue } = splitSystem(messages, opts.system);
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: this.buildBody(dialogue, system, false),
    });
    if (!res.ok) throw new Error(`OpenAI-compatible error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: data.choices?.[0]?.message?.content ?? "",
      model: this.model,
      inputTokens: data.usage?.prompt_tokens,
      outputTokens: data.usage?.completion_tokens,
    };
  }

  async *stream(
    messages: ChatMessage[],
    opts: { system?: string; maxTokens?: number } = {},
  ): AsyncIterable<StreamEvent> {
    const { system, dialogue } = splitSystem(messages, opts.system);
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: this.buildBody(dialogue, system, true),
    });
    if (!res.ok || !res.body) throw new Error(`OpenAI-compatible error ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let full = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE events delimited by double newlines.
      const blocks = buf.split("\n\n");
      buf = blocks.pop() ?? "";
      for (const block of blocks) {
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
            const chunk = parsed.choices?.[0]?.delta?.content;
            if (chunk) {
              full += chunk;
              yield { type: "text", text: chunk };
            }
          } catch {
            /* skip malformed frames */
          }
        }
      }
    }
    yield { type: "done", text: full, model: this.model };
  }
}

/**
 * Pick the right provider for the current request. Order of precedence:
 *  1. explicit override (OA_LLM_PROVIDER env var)
 *  2. config file (~/.open-assistant/config.json)
 *  3. heuristic: Anthropic if API key set, else claude-cli if installed, else Ollama
 *
 * Each call re-reads the config so changes to settings.json apply immediately
 * without requiring a restart.
 */
export function selectProvider(): LLMProvider {
  const cfg = (() => {
    try {
      return currentConfig();
    } catch {
      return null;
    }
  })();
  const explicit = (process.env.OA_LLM_PROVIDER ?? "").toLowerCase();
  const choice = (explicit || cfg?.llm.provider || "").toLowerCase();

  if (choice === "anthropic") return providerFromConfig("anthropic", cfg);
  if (choice === "claude-cli") return providerFromConfig("claude-cli", cfg);
  if (choice === "ollama") return providerFromConfig("ollama", cfg);
  if (choice === "openai-compatible") return providerFromConfig("openai-compatible", cfg);

  // Heuristic fallback.
  const anthropic = new AnthropicProvider();
  if (anthropic.isConfigured) return anthropic;
  if (ClaudeCliProvider.isAvailable()) return new ClaudeCliProvider();
  return new OllamaProvider();
}

function providerFromConfig(name: string, cfg: Config | null): LLMProvider {
  const llm = cfg?.llm;
  switch (name) {
    case "anthropic":
      return new AnthropicProvider({
        apiKey: llm?.apiKey || undefined,
        model: llm?.model || undefined,
        maxTokens: llm?.maxTokens,
      });
    case "claude-cli":
      return new ClaudeCliProvider({ model: llm?.model || undefined });
    case "ollama":
      return new OllamaProvider({
        baseUrl: llm?.baseUrl || undefined,
        model: llm?.model || undefined,
      });
    case "openai-compatible":
      return new OpenAICompatibleProvider({
        baseUrl: llm?.baseUrl || undefined,
        apiKey: llm?.apiKey || undefined,
        model: llm?.model || undefined,
        temperature: llm?.temperature,
        maxTokens: llm?.maxTokens,
      });
    default:
      return new ClaudeCliProvider();
  }
}

function splitSystem(
  messages: ChatMessage[],
  extra?: string,
): { system?: string; dialogue: ChatMessage[] } {
  const systems = messages.filter((m) => m.role === "system").map((m) => m.content);
  if (extra) systems.unshift(extra);
  const dialogue = messages.filter((m) => m.role !== "system");
  return { system: systems.length ? systems.join("\n\n") : undefined, dialogue };
}

function flattenForCli(messages: ChatMessage[], system?: string): string {
  const { system: combinedSystem, dialogue } = splitSystem(messages, system);
  const parts: string[] = [];
  if (combinedSystem) parts.push(`[system]\n${combinedSystem}`);
  for (const m of dialogue) parts.push(`[${m.role}]\n${m.content}`);
  parts.push("[assistant]");
  return parts.join("\n\n");
}
