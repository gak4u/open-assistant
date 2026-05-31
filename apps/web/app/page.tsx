"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import styles from "./page.module.css";
import { OnboardingModal } from "./OnboardingModal";

type Msg = { role: "user" | "assistant"; content: string; meta?: string };
type Health = "unknown" | "ok" | "bad";
type Identities = { user: string | null; assistant: string | null };

export default function Home() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [health, setHealth] = useState<Health>("unknown");
  const [stats, setStats] = useState<{ entities: number; relations: number; turns: number } | null>(null);
  const [identities, setIdentities] = useState<Identities>({ user: null, assistant: null });
  const [activeProjects, setActiveProjects] = useState<number | null>(null);
  const [onboardingTrigger, setOnboardingTrigger] = useState<number | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<string | undefined>(undefined);
  const checkedOnboardingRef = useRef(false);

  useEffect(() => {
    // Auto-launch onboarding on first visit if it's never been run.
    if (checkedOnboardingRef.current) return;
    checkedOnboardingRef.current = true;
    fetch("/api/onboarding/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && data.completed === false) {
          setOnboardingTrigger(Date.now());
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const check = async () => {
      try {
        const [h, id, p] = await Promise.all([
          fetch("/api/health").then((r) => (r.ok ? r.json() : null)).catch(() => null),
          fetch("/api/identities").then((r) => (r.ok ? r.json() : null)).catch(() => null),
          fetch("/api/projects").then((r) => (r.ok ? r.json() : null)).catch(() => null),
        ]);
        setHealth(h?.daemon ? "ok" : "bad");
        if (h?.stats) setStats(h.stats);
        if (id) setIdentities({ user: id.user ?? null, assistant: id.assistant ?? null });
        if (Array.isArray(p?.projects)) {
          setActiveProjects(p.projects.filter((proj: { status: string }) => proj.status === "active").length);
        }
      } catch {
        setHealth("bad");
      }
    };
    check();
    const interval = setInterval(check, 15000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status, busy]);

  const userLabel = (identities.user ?? "you").toLowerCase();
  const assistantLabel = (identities.assistant ?? "assistant").toLowerCase();

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "" }]);
    setBusy(true);
    setStatus("Connecting…");

    try {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: text, session_id: sessionRef.current }),
      });
      if (!r.ok || !r.body) throw new Error(`http ${r.status}`);

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      const appendChunk = (chunk: string) => {
        setMessages((m) => {
          const copy = [...m];
          const last = copy[copy.length - 1];
          if (last && last.role === "assistant") {
            copy[copy.length - 1] = { ...last, content: last.content + chunk };
          }
          return copy;
        });
      };

      const setLastMeta = (meta: string) => {
        setMessages((m) => {
          const copy = [...m];
          const last = copy[copy.length - 1];
          if (last && last.role === "assistant") {
            copy[copy.length - 1] = { ...last, meta };
          }
          return copy;
        });
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop() ?? "";

        for (const block of events) {
          let evt = "message";
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) evt = line.slice(7).trim();
            else if (line.startsWith("data: ")) data += (data ? "\n" : "") + line.slice(6);
          }
          if (!data) continue;
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(data);
          } catch {
            continue;
          }

          if (evt === "status") {
            setStatus(typeof payload.text === "string" ? payload.text : null);
          } else if (evt === "identity") {
            const id = (payload.identities ?? {}) as Identities;
            setIdentities({ user: id.user ?? null, assistant: id.assistant ?? null });
          } else if (evt === "text") {
            if (status !== null) setStatus(null);
            if (typeof payload.text === "string") appendChunk(payload.text);
          } else if (evt === "done") {
            sessionRef.current = (payload.sessionId as string | undefined) ?? sessionRef.current;
            const used =
              ((payload.memoryUsed as { entities?: unknown[] } | undefined)?.entities?.length) ?? 0;
            const model = (payload.model as string | undefined) ?? "unknown";
            setLastMeta(`${model} · ${used} memory entities`);
            setStatus(null);
          } else if (evt === "error") {
            const errMsg = (payload.error as string | undefined) ?? "error";
            appendChunk(`\n\n[error: ${errMsg}]`);
            setStatus(null);
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMessages((m) => {
        const copy = [...m];
        const last = copy[copy.length - 1];
        if (last && last.role === "assistant" && !last.content) {
          copy[copy.length - 1] = { ...last, content: `error: ${msg}` };
        }
        return copy;
      });
    } finally {
      setBusy(false);
      setStatus(null);
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  };

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>
            {identities.assistant ?? "open-assistant"}
          </h1>
          <p className={styles.subtitle}>
            {identities.user
              ? `talking to ${identities.user} · persistent graph memory`
              : "persistent graph memory · self-hosted"}
          </p>
        </div>
        <div className={styles.status}>
          <span className={`${styles.dot} ${health === "ok" ? styles.ok : health === "bad" ? styles.bad : ""}`} />
          <span>{health === "ok" ? "online" : health === "bad" ? "offline" : "…"}</span>
          {stats && (
            <span>
              {stats.entities} entities · {stats.relations} relations · {stats.turns} turns
            </span>
          )}
          {activeProjects !== null && activeProjects > 0 && (
            <Link href="/projects" className={styles.projectsPill}>
              {activeProjects} active {activeProjects === 1 ? "project" : "projects"} →
            </Link>
          )}
        </div>
      </header>

      <section className={styles.messages}>
        {messages.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.tag}>v0.2 · streaming</span>
            <h2>Ask anything.</h2>
            <p>
              Tokens stream in live. Memory is queried while you wait. Tell me your name (&quot;my
              name is …&quot;) or name me (&quot;I&apos;ll call you …&quot;) and we&apos;ll both be
              labelled accordingly. Cmd/Ctrl+Enter to send.
            </p>
          </div>
        ) : (
          messages.map((m, i) => {
            const isLastAssistant = i === messages.length - 1 && m.role === "assistant";
            const showThinkingDots = isLastAssistant && busy && !m.content;
            return (
              <article key={i} className={`${styles.msg} ${styles[m.role]}`}>
                <div className={styles.who}>{m.role === "user" ? userLabel : assistantLabel}</div>
                <div>
                  <div className={styles.body}>
                    {m.content}
                    {isLastAssistant && busy && m.content && <span className={styles.cursor}>▍</span>}
                    {showThinkingDots && <span className={styles.dots} aria-label="thinking">…</span>}
                  </div>
                  {isLastAssistant && status && <div className={styles.statusLine}>{status}</div>}
                  {m.meta && <div className={styles.meta}>{m.meta}</div>}
                </div>
              </article>
            );
          })
        )}
        <div ref={endRef} />
      </section>

      <footer className={styles.composer}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          rows={2}
          placeholder="Ask anything…  (Cmd/Ctrl+Enter to send)"
          disabled={busy}
        />
        <button className="primary" onClick={send} disabled={busy || !input.trim()}>
          Send
        </button>
      </footer>

      <OnboardingModal
        triggeredAt={onboardingTrigger}
        onClose={() => setOnboardingTrigger(null)}
        onComplete={() => {
          fetch("/api/projects")
            .then((r) => (r.ok ? r.json() : null))
            .then((p) => {
              if (Array.isArray(p?.projects)) {
                setActiveProjects(
                  p.projects.filter((proj: { status: string }) => proj.status === "active").length,
                );
              }
            })
            .catch(() => undefined);
        }}
      />
    </main>
  );
}
