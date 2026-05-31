"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./settings.module.css";
import { OnboardingModal } from "../OnboardingModal";

type ProviderName = "anthropic" | "claude-cli" | "ollama" | "openai-compatible";

type SettingsResponse = {
  config: {
    llm: {
      provider: ProviderName;
      model: string;
      apiKey: string;
      apiKeyMasked: string;
      hasApiKey: boolean;
      baseUrl: string;
      temperature: number;
      maxTokens: number;
    };
    memory: {
      falkordbHost: string;
      falkordbPort: number;
      falkordbGraph: string;
      falkordbPassword: string;
    };
    daemon: { host: string; port: number };
  };
  path: string;
  mcpBinPath: string;
};

type DaemonHealth = { up: boolean; entities?: number; relations?: number; turns?: number };

const PROVIDERS: { value: ProviderName; label: string; hint: string }[] = [
  { value: "anthropic", label: "Anthropic", hint: "Claude API — requires ANTHROPIC_API_KEY or key below" },
  { value: "claude-cli", label: "Claude CLI", hint: "Uses your local `claude` Code session — no API key needed" },
  { value: "ollama", label: "Ollama", hint: "Local llama.cpp / Ollama daemon" },
  { value: "openai-compatible", label: "OpenAI-compatible", hint: "OpenAI, vLLM, LM Studio, Together, Groq, …" },
];

export default function SettingsPage() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<SettingsResponse["config"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [daemonHealth, setDaemonHealth] = useState<DaemonHealth>({ up: false });
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [identitiesDraft, setIdentitiesDraft] = useState<{ user: string; assistant: string }>({
    user: "",
    assistant: "",
  });
  const [onboardingTrigger, setOnboardingTrigger] = useState<number | null>(null);
  const [onboardingStatus, setOnboardingStatus] = useState<{ completed: boolean; lastRunAt: number; lastSummary: { projectsCreated: number; entitiesCreated: number; sessionsFound: number; reposFound: number; relationsCreated: number } } | null>(null);

  const load = useCallback(async () => {
    const [s, h, id, ob] = await Promise.all([
      fetch("/api/settings").then((r) => r.json()).catch(() => null),
      fetch("/api/health").then((r) => (r.ok ? r.json() : { daemon: false })).catch(() => ({ daemon: false })),
      fetch("/api/identities").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/onboarding/status").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (s) {
      setData(s);
      setDraft(s.config);
    }
    setDaemonHealth({ up: !!h?.daemon, ...(h?.stats ?? {}) });
    if (id) setIdentitiesDraft({ user: id.user ?? "", assistant: id.assistant ?? "" });
    if (ob) setOnboardingStatus(ob);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const update = <K extends keyof SettingsResponse["config"]>(
    section: K,
    patch: Partial<SettingsResponse["config"][K]>,
  ) => {
    setDraft((d) => (d ? { ...d, [section]: { ...d[section], ...patch } } : d));
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setSavedFlash(false);
    try {
      const r = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!r.ok) throw new Error(`http ${r.status}`);
      const s = (await r.json()) as SettingsResponse;
      setData(s);
      setDraft(s.config);

      // Also persist identity edits if changed.
      await fetch("/api/identities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          user: identitiesDraft.user || null,
          assistant: identitiesDraft.assistant || null,
        }),
      });

      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    } catch (err) {
      setTestResult(err instanceof Error ? err.message : String(err));
      setTestOk(false);
    } finally {
      setBusy(false);
    }
  };

  const testConnection = async () => {
    setTestResult("Pinging FalkorDB…");
    setTestOk(null);
    try {
      const r = await fetch("/api/health");
      const j = (await r.json()) as { daemon?: boolean; stats?: { entities: number; relations: number; turns: number }; error?: string };
      if (j.daemon && j.stats) {
        setTestOk(true);
        setTestResult(`OK · ${j.stats.entities} entities · ${j.stats.relations} relations · ${j.stats.turns} turns`);
        setDaemonHealth({ up: true, ...j.stats });
      } else {
        setTestOk(false);
        setTestResult(`Failed: ${j.error ?? "FalkorDB unreachable"}`);
      }
    } catch (err) {
      setTestOk(false);
      setTestResult(err instanceof Error ? err.message : String(err));
    }
  };

  const clearMemory = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/memory/clear", { method: "POST" });
      const j = (await r.json()) as { ok: boolean; deleted?: number; error?: string };
      if (j.ok) {
        setTestOk(true);
        setTestResult(`Cleared graph — ${j.deleted ?? 0} nodes removed`);
        setDaemonHealth({ up: true, entities: 0, relations: 0, turns: 0 });
      } else {
        setTestOk(false);
        setTestResult(`Clear failed: ${j.error ?? "unknown"}`);
      }
    } catch (err) {
      setTestOk(false);
      setTestResult(err instanceof Error ? err.message : String(err));
    } finally {
      setConfirmClear(false);
      setBusy(false);
    }
  };

  if (!draft || !data) {
    return <div className={styles.shell}><p style={{ color: "var(--fg-dim)" }}>Loading…</p></div>;
  }

  const mcpCommand = `claude mcp add -s user open-assistant -- node ${data.mcpBinPath}`;

  return (
    <div className={styles.shell}>
      <div className={styles.inner}>
        <header className={styles.header}>
          <div>
            <h1 className={styles.title}>Settings</h1>
            <p className={styles.path}>{data.path}</p>
          </div>
          <div>
            <span className={`${styles.badge} ${daemonHealth.up ? styles.ok : styles.bad}`}>
              <span className={styles.dot} /> daemon {daemonHealth.up ? "online" : "offline"}
            </span>
          </div>
        </header>

        {/* ---------- Identity ---------- */}
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Identity</h2>
            <p className={styles.sectionHint}>Names shown in the chat. Auto-detected from messages too.</p>
          </div>
          <div className={styles.row}>
            <label className={styles.lbl} htmlFor="user-name">Your name</label>
            <input id="user-name" type="text" placeholder="(not set)"
              value={identitiesDraft.user}
              onChange={(e) => setIdentitiesDraft((d) => ({ ...d, user: e.target.value }))}
            />
          </div>
          <div className={styles.row}>
            <label className={styles.lbl} htmlFor="assistant-name">Assistant name</label>
            <input id="assistant-name" type="text" placeholder="open-assistant"
              value={identitiesDraft.assistant}
              onChange={(e) => setIdentitiesDraft((d) => ({ ...d, assistant: e.target.value }))}
            />
          </div>
        </section>

        {/* ---------- LLM Provider ---------- */}
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>LLM Provider</h2>
            <p className={styles.sectionHint}>Selected provider handles chat + entity extraction.</p>
          </div>
          <div className={styles.row}>
            <label className={styles.lbl} htmlFor="provider">Provider</label>
            <div className={styles.field}>
              <select id="provider"
                value={draft.llm.provider}
                onChange={(e) => {
                  // Models don't translate across providers — clear the field
                  // so the placeholder for the new provider is visible.
                  update("llm", { provider: e.target.value as ProviderName, model: "" });
                }}
              >
                {PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
              <span className={styles.hint}>
                {PROVIDERS.find((p) => p.value === draft.llm.provider)?.hint}
              </span>
            </div>
          </div>
          <div className={styles.row}>
            <label className={styles.lbl} htmlFor="model">Model</label>
            <input id="model" type="text"
              placeholder={modelPlaceholder(draft.llm.provider)}
              value={draft.llm.model}
              onChange={(e) => update("llm", { model: e.target.value })}
            />
          </div>
          <div className={styles.row}>
            <label className={styles.lbl} htmlFor="api-key">API key</label>
            <div className={styles.field}>
              <input id="api-key" type="password"
                placeholder={data.config.llm.hasApiKey ? `${data.config.llm.apiKeyMasked}  ·  leave blank to keep` : "sk-…"}
                value={draft.llm.apiKey}
                onChange={(e) => update("llm", { apiKey: e.target.value })}
                autoComplete="off"
              />
              <span className={styles.hint}>
                Stored at {data.path} (mode 0600). Never written to the graph.
              </span>
            </div>
          </div>
          <div className={styles.row}>
            <label className={styles.lbl} htmlFor="base-url">Base URL</label>
            <input id="base-url" type="url"
              placeholder={baseUrlPlaceholder(draft.llm.provider)}
              value={draft.llm.baseUrl}
              onChange={(e) => update("llm", { baseUrl: e.target.value })}
            />
          </div>
          <div className={styles.row}>
            <label className={styles.lbl} htmlFor="temperature">Temperature</label>
            <div className={styles.slider}>
              <input id="temperature" type="range" min={0} max={1} step={0.05}
                value={draft.llm.temperature}
                onChange={(e) => update("llm", { temperature: Number(e.target.value) })}
              />
              <span className={styles.value}>{draft.llm.temperature.toFixed(2)}</span>
            </div>
          </div>
          <div className={styles.row}>
            <label className={styles.lbl} htmlFor="max-tokens">Max tokens</label>
            <div className={styles.inputRow}>
              <input id="max-tokens" type="number" className={styles.narrow} min={1} max={64000}
                value={draft.llm.maxTokens}
                onChange={(e) => update("llm", { maxTokens: Number(e.target.value) || 1 })}
              />
            </div>
          </div>
        </section>

        {/* ---------- Memory ---------- */}
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Memory</h2>
            <p className={styles.sectionHint}>Where the graph lives.</p>
          </div>
          <div className={styles.row}>
            <label className={styles.lbl} htmlFor="db-host">FalkorDB host</label>
            <input id="db-host" type="text"
              value={draft.memory.falkordbHost}
              onChange={(e) => update("memory", { falkordbHost: e.target.value })}
            />
          </div>
          <div className={styles.row}>
            <label className={styles.lbl} htmlFor="db-port">Port</label>
            <div className={styles.inputRow}>
              <input id="db-port" type="number" className={styles.narrow} min={1} max={65535}
                value={draft.memory.falkordbPort}
                onChange={(e) => update("memory", { falkordbPort: Number(e.target.value) || 6379 })}
              />
            </div>
          </div>
          <div className={styles.row}>
            <label className={styles.lbl} htmlFor="db-graph">Graph name</label>
            <input id="db-graph" type="text"
              value={draft.memory.falkordbGraph}
              onChange={(e) => update("memory", { falkordbGraph: e.target.value })}
            />
          </div>
          <div className={styles.actions}>
            <button type="button" className="ghost" onClick={testConnection} disabled={busy}>
              Test connection
            </button>
            <button type="button" className="primary" onClick={() => setOnboardingTrigger(Date.now())} disabled={busy}>
              {onboardingStatus?.completed ? "Re-run onboarding" : "Run onboarding"}
            </button>
            <button type="button" className="danger" onClick={() => setConfirmClear(true)} disabled={busy}>
              Clear all memory…
            </button>
            <div className={styles.grow} />
            {testResult && (
              <span className={`${styles.statusLine} ${testOk === true ? styles.ok : testOk === false ? styles.bad : ""}`}>
                {testResult}
              </span>
            )}
          </div>
          {onboardingStatus?.completed && onboardingStatus.lastSummary && (
            <p className={styles.sectionHint}>
              Last onboarding: {onboardingStatus.lastSummary.projectsCreated} projects ·{" "}
              {onboardingStatus.lastSummary.entitiesCreated} entities ·{" "}
              {onboardingStatus.lastSummary.sessionsFound} sessions scanned.
            </p>
          )}
        </section>

        {/* ---------- Daemon ---------- */}
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Daemon</h2>
            <p className={styles.sectionHint}>MCP server + agent worker.</p>
          </div>
          <div className={styles.row}>
            <label className={styles.lbl}>Status</label>
            <span className={`${styles.badge} ${daemonHealth.up ? styles.ok : styles.bad}`}>
              <span className={styles.dot} /> {daemonHealth.up ? "online" : "offline"}
            </span>
          </div>
          <div className={styles.row}>
            <label className={styles.lbl} htmlFor="daemon-host">Bind host</label>
            <input id="daemon-host" type="text"
              value={draft.daemon.host}
              onChange={(e) => update("daemon", { host: e.target.value })}
            />
          </div>
          <div className={styles.row}>
            <label className={styles.lbl} htmlFor="daemon-port">MCP port</label>
            <div className={styles.inputRow}>
              <input id="daemon-port" type="number" className={styles.narrow} min={1} max={65535}
                value={draft.daemon.port}
                onChange={(e) => update("daemon", { port: Number(e.target.value) || 7338 })}
              />
              <span className={styles.statusLine}>HTTP: /mcp + /health</span>
            </div>
          </div>
          <div className={styles.field}>
            <label className={styles.lbl} style={{ marginBottom: 4 }}>Claude Code / Desktop registration</label>
            <CodeBlock text={mcpCommand} />
            <span className={styles.hint}>
              Runs the server in stdio mode under your user scope. After registering, the tools
              appear under <code>mcp__open-assistant__*</code> in any Claude Code session.
            </span>
          </div>
        </section>

        <div className={styles.saveBar}>
          <span className={`${styles.savedTag} ${savedFlash ? styles.show : ""}`}>✓ Saved to {data.path}</span>
          <button type="button" className="ghost" onClick={() => { setDraft(data.config); load(); }} disabled={busy}>
            Revert
          </button>
          <button type="button" className="primary" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save settings"}
          </button>
        </div>
      </div>

      <OnboardingModal
        triggeredAt={onboardingTrigger}
        onClose={() => setOnboardingTrigger(null)}
        onComplete={() => load()}
      />

      {confirmClear && (
        <div className={styles.confirm} onClick={() => setConfirmClear(false)}>
          <div className={styles.confirmBox} onClick={(e) => e.stopPropagation()}>
            <h3>Clear all memory?</h3>
            <p>
              This deletes every node and relationship in the <code>{draft.memory.falkordbGraph}</code>{" "}
              graph, including your identities, every conversation turn, and all extracted entities.
              FalkorDB will recreate the empty graph on the next write.
            </p>
            <div className={styles.actions} style={{ justifyContent: "flex-end" }}>
              <button type="button" className="ghost" onClick={() => setConfirmClear(false)} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="danger" onClick={clearMemory} disabled={busy}>
                {busy ? "Clearing…" : "Yes, clear it all"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function modelPlaceholder(p: ProviderName): string {
  switch (p) {
    case "anthropic": return "claude-sonnet-4-20250514";
    case "claude-cli": return "(leave blank to use CLI default)";
    case "ollama": return "llama3.2";
    case "openai-compatible": return "gpt-4o-mini";
  }
}

function baseUrlPlaceholder(p: ProviderName): string {
  switch (p) {
    case "anthropic": return "(leave blank — uses api.anthropic.com)";
    case "claude-cli": return "(not used)";
    case "ollama": return "http://127.0.0.1:11434";
    case "openai-compatible": return "https://api.openai.com/v1";
  }
}

function CodeBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={styles.codeBlock}>
      <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{text}</pre>
      <button
        type="button"
        className={`ghost ${styles.copyBtn}`}
        onClick={() => {
          navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}
