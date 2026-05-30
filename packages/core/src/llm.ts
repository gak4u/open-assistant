import Anthropic from "@anthropic-ai/sdk";
import { spawn, spawnSync } from "node:child_process";

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

export interface LLMProvider {
  readonly name: string;
  complete(messages: ChatMessage[], opts?: { system?: string; maxTokens?: number }): Promise<LLMCompletion>;
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
}

export interface OllamaProviderOptions {
  baseUrl?: string;
  model?: string;
}

/**
 * Minimal Ollama provider. Used as a fallback when no Anthropic key is set —
 * also handy for fully-local hot-path inference.
 */
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
      options: {
        num_predict: opts.maxTokens ?? 1024,
      },
    };
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { message?: { content?: string } };
    return {
      text: data.message?.content ?? "",
      model: this.model,
    };
  }
}

export interface ClaudeCliProviderOptions {
  binary?: string;
  model?: string;
}

/**
 * Spawns the local `claude` CLI in print mode (`claude -p`). Uses whatever
 * session auth the user already has configured for Claude Code — handy when
 * there's no raw ANTHROPIC_API_KEY in the environment but the user is already
 * signed in to Claude Code locally.
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
    const { system, dialogue } = splitSystem(messages, opts.system);
    // Flatten the conversation into a single prompt the CLI can consume.
    const parts: string[] = [];
    if (system) parts.push(`[system]\n${system}`);
    for (const m of dialogue) {
      parts.push(`[${m.role}]\n${m.content}`);
    }
    parts.push("[assistant]");
    const prompt = parts.join("\n\n");

    return new Promise((resolve, reject) => {
      const args = ["-p", prompt, "--output-format", "text"];
      if (this.model) args.push("--model", this.model);
      const child = spawn(this.binary, args, {
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
        if (code === 0) {
          resolve({ text: stdout.trim(), model: this.model ?? "claude-cli" });
        } else {
          reject(new Error(`claude CLI exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
        }
      });
    });
  }
}

export function selectProvider(): LLMProvider {
  const explicit = (process.env.OA_LLM_PROVIDER ?? "").toLowerCase();
  if (explicit === "anthropic") return new AnthropicProvider();
  if (explicit === "claude-cli") return new ClaudeCliProvider();
  if (explicit === "ollama") return new OllamaProvider();

  const anthropic = new AnthropicProvider();
  if (anthropic.isConfigured) return anthropic;
  if (ClaudeCliProvider.isAvailable()) return new ClaudeCliProvider();
  return new OllamaProvider();
}

function splitSystem(
  messages: ChatMessage[],
  extra?: string,
): { system?: string; dialogue: ChatMessage[] } {
  const systems = messages.filter((m) => m.role === "system").map((m) => m.content);
  if (extra) systems.unshift(extra);
  const dialogue = messages.filter((m) => m.role !== "system");
  return {
    system: systems.length ? systems.join("\n\n") : undefined,
    dialogue,
  };
}
