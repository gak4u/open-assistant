"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./page.module.css";

type Msg = { role: "user" | "assistant"; content: string; meta?: string };
type Health = "unknown" | "ok" | "bad";

export default function Home() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<Health>("unknown");
  const [stats, setStats] = useState<{ entities: number; relations: number; turns: number } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const check = async () => {
      try {
        const r = await fetch("/api/health");
        if (!r.ok) throw new Error();
        const data = await r.json();
        setHealth(data.daemon ? "ok" : "bad");
        setStats(data.stats ?? null);
      } catch {
        setHealth("bad");
      }
    };
    check();
    const id = setInterval(check, 15000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", content: text }]);
    setBusy(true);
    try {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: text, session_id: sessionRef.current }),
      });
      if (!r.ok) throw new Error(`http ${r.status}`);
      const data = (await r.json()) as {
        reply: string;
        sessionId: string;
        memoryUsed?: { entities: { id: string; name: string }[] };
        model: string;
      };
      sessionRef.current = data.sessionId;
      const used = data.memoryUsed?.entities?.length ?? 0;
      setMessages((m) => [
        ...m,
        { role: "assistant", content: data.reply, meta: `${data.model} · ${used} memory entities` },
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMessages((m) => [...m, { role: "assistant", content: `error: ${msg}` }]);
    } finally {
      setBusy(false);
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
          <h1 className={styles.title}>open-assistant</h1>
          <p className={styles.subtitle}>persistent graph memory · self-hosted</p>
        </div>
        <div className={styles.status}>
          <span className={`${styles.dot} ${health === "ok" ? styles.ok : health === "bad" ? styles.bad : ""}`} />
          <span>{health === "ok" ? "online" : health === "bad" ? "offline" : "…"}</span>
          {stats && (
            <span>
              {stats.entities} entities · {stats.relations} relations · {stats.turns} turns
            </span>
          )}
        </div>
      </header>

      <section className={styles.messages}>
        {messages.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.tag}>v0.1</span>
            <h2>Ask anything.</h2>
            <p>
              Every turn writes to your local FalkorDB graph and gets pulled back into context on
              the next relevant question. Cmd/Ctrl+Enter to send.
            </p>
          </div>
        ) : (
          messages.map((m, i) => (
            <article key={i} className={`${styles.msg} ${styles[m.role]}`}>
              <div className={styles.who}>{m.role}</div>
              <div>
                <div className={styles.body}>{m.content}</div>
                {m.meta && <div className={styles.meta}>{m.meta}</div>}
              </div>
            </article>
          ))
        )}
        {busy && (
          <article className={`${styles.msg} ${styles.assistant}`}>
            <div className={styles.who}>assistant</div>
            <div className={styles.body}>…</div>
          </article>
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
    </main>
  );
}
