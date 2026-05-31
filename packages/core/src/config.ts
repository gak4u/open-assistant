import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

const ProviderName = z.enum(["anthropic", "claude-cli", "ollama", "openai-compatible"]);
export type ProviderName = z.infer<typeof ProviderName>;

const LlmConfig = z.object({
  provider: ProviderName.default("claude-cli"),
  model: z.string().default(""),
  apiKey: z.string().default(""),
  baseUrl: z.string().default(""),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().min(1).max(200000).default(4096),
});
export type LlmConfig = z.infer<typeof LlmConfig>;

const MemoryConfig = z.object({
  falkordbHost: z.string().default("127.0.0.1"),
  falkordbPort: z.number().int().min(1).max(65535).default(6379),
  falkordbGraph: z.string().default("open_assistant"),
  falkordbPassword: z.string().default(""),
});
export type MemoryConfig = z.infer<typeof MemoryConfig>;

const DaemonConfig = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(7338),
});
export type DaemonConfig = z.infer<typeof DaemonConfig>;

const OnboardingConfig = z.object({
  completed: z.boolean().default(false),
  lastRunAt: z.number().default(0),
  lastSummary: z
    .object({
      sessionsFound: z.number().default(0),
      reposFound: z.number().default(0),
      projectsCreated: z.number().default(0),
      entitiesCreated: z.number().default(0),
      relationsCreated: z.number().default(0),
    })
    .default({}),
});
export type OnboardingConfigT = z.infer<typeof OnboardingConfig>;

const Config = z.object({
  llm: LlmConfig.default({}),
  memory: MemoryConfig.default({}),
  daemon: DaemonConfig.default({}),
  onboarding: OnboardingConfig.default({}),
});
export type Config = z.infer<typeof Config>;

export const DEFAULT_CONFIG: Config = Config.parse({});

const CONFIG_DIR = path.join(homedir(), ".open-assistant");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

let cached: Config | null = null;
let cachedMtimeMs = 0;
const emitter = new EventEmitter();
let watcher: ReturnType<typeof watch> | null = null;

export function configPath(): string {
  return CONFIG_PATH;
}

/** Read the config file, merging with defaults. Creates the file on first read. */
export function loadConfig(): Config {
  ensureDir();
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), { mode: 0o600 });
    cached = DEFAULT_CONFIG;
    return cached;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    raw = {};
  }
  const result = Config.safeParse(raw);
  cached = result.success ? result.data : DEFAULT_CONFIG;
  return cached;
}

/** Return cached config (loads on first call). Refreshes if file mtime changed. */
export function currentConfig(): Config {
  if (!cached) return loadConfig();
  // Cheap freshness check on subsequent calls — only stat, no parse, unless changed.
  try {
    const stat = statSync(CONFIG_PATH);
    if (stat.mtimeMs !== cachedMtimeMs) {
      cachedMtimeMs = stat.mtimeMs;
      return loadConfig();
    }
  } catch {
    /* file missing — just return cached */
  }
  return cached;
}

export interface SaveOptions {
  /**
   * Field paths (dot-delimited) where an empty string in the patch means
   * "keep the existing value" rather than "clear to empty". Used for secret
   * fields like `llm.apiKey` that the settings UI deliberately leaves blank
   * on display so the user can avoid retyping. All other empty strings DO
   * overwrite — that's how you clear a non-secret field.
   */
  preserveEmpty?: string[];
}

const DEFAULT_PRESERVE = ["llm.apiKey", "memory.falkordbPassword"];

export function saveConfig(partial: DeepPartial<Config>, opts: SaveOptions = {}): Config {
  const current = currentConfig();
  const preserve = new Set(opts.preserveEmpty ?? DEFAULT_PRESERVE);
  const merged = mergeDeep(structuredClone(current), partial, preserve, "");
  const parsed = Config.parse(merged);
  ensureDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(parsed, null, 2), { mode: 0o600 });
  cached = parsed;
  cachedMtimeMs = Date.now();
  emitter.emit("change", parsed);
  return parsed;
}

/**
 * Start watching the config file for external changes. Safe to call multiple
 * times — only one watcher is registered.
 */
export function startWatching(): void {
  if (watcher) return;
  ensureDir();
  try {
    watcher = watch(CONFIG_PATH, { persistent: false }, (event) => {
      if (event === "change" || event === "rename") {
        try {
          const next = loadConfig();
          emitter.emit("change", next);
        } catch {
          /* malformed config — keep cached */
        }
      }
    });
  } catch {
    /* if the file doesn't exist yet, load (which creates it) then watch */
    loadConfig();
    if (existsSync(CONFIG_PATH) && !watcher) {
      watcher = watch(CONFIG_PATH, { persistent: false }, () => {
        try {
          const next = loadConfig();
          emitter.emit("change", next);
        } catch {
          /* ignore */
        }
      });
    }
  }
}

export function stopWatching(): void {
  watcher?.close();
  watcher = null;
}

export function onConfigChange(handler: (cfg: Config) => void): () => void {
  emitter.on("change", handler);
  return () => emitter.off("change", handler);
}

/**
 * Redact an API key for display. Shows the first 6 + last 4 characters with
 * dots in between, so the operator can recognise their key without exposing
 * the whole secret to anyone watching.
 */
export function redactSecret(secret: string): string {
  if (!secret) return "";
  if (secret.length <= 12) return "•".repeat(secret.length);
  return `${secret.slice(0, 6)}…${secret.slice(-4)}`;
}

export function redactedConfig(cfg: Config = currentConfig()): Config & { llm: LlmConfig & { apiKeyMasked: string; hasApiKey: boolean } } {
  return {
    ...cfg,
    llm: {
      ...cfg.llm,
      apiKey: "",
      apiKeyMasked: redactSecret(cfg.llm.apiKey),
      hasApiKey: !!cfg.llm.apiKey,
    },
  };
}

// ---------------- helpers ----------------

function ensureDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function mergeDeep<T extends Record<string, unknown>>(
  target: T,
  source: DeepPartial<T>,
  preserve: Set<string>,
  pathPrefix: string,
): T {
  for (const key of Object.keys(source) as (keyof T)[]) {
    const sv = source[key];
    const fullPath = pathPrefix ? `${pathPrefix}.${String(key)}` : String(key);
    if (sv === undefined) continue;
    if (typeof sv === "string" && sv === "" && preserve.has(fullPath)) continue;
    if (sv && typeof sv === "object" && !Array.isArray(sv)) {
      const tv = (target[key] && typeof target[key] === "object" ? target[key] : {}) as Record<
        string,
        unknown
      >;
      (target as Record<string, unknown>)[key as string] = mergeDeep(
        tv,
        sv as DeepPartial<Record<string, unknown>>,
        preserve,
        fullPath,
      );
    } else {
      (target as Record<string, unknown>)[key as string] = sv;
    }
  }
  return target;
}
