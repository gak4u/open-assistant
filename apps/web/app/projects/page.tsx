"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import styles from "./projects.module.css";

type ProjectStatus = "running" | "paused" | "active" | "archived";

type Project = {
  id: string;
  name: string;
  description: string;
  localPath: string | null;
  sessionId: string | null;
  sessionCount: number;
  messageCount: number;
  lastActiveMs: number;
  lastPrompt: string;
  markers: string[];
  hasRepo: boolean;
  pathExists: boolean;
  status: ProjectStatus;
  tmux: {
    name: string | null;
    runtime: "running" | "paused" | "archived";
    attached: boolean;
    lastResumedAt: number;
    attachCommand: string | null;
  };
};

type Filter = "all" | "running" | "active" | "archived";

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [filter, setFilter] = useState<Filter>("active");
  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/projects");
      const j = (await r.json()) as { projects: Project[] };
      setProjects(j.projects);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const fireFlash = (kind: "ok" | "bad", text: string) => {
    setFlash({ kind, text });
    setTimeout(() => setFlash(null), 2400);
  };

  const resume = async (p: Project) => {
    const r = await fetch(`/api/projects/${encodeURIComponent(p.id)}/resume`, { method: "POST" });
    const j = await r.json();
    if (j.ok) {
      const action = j.alreadyRunning ? "Attached to" : j.tmuxCreated ? "Started" : "Resumed";
      fireFlash("ok", `${action} ${p.name} (tmux: ${j.tmuxName})`);
      load();
    } else fireFlash("bad", `Resume failed: ${j.error}`);
  };
  const killSession = async (p: Project) => {
    if (!confirm(`Kill the tmux session for "${p.name}"? Any in-flight Claude Code work will stop.`)) return;
    const r = await fetch(`/api/projects/${encodeURIComponent(p.id)}/kill`, { method: "POST" });
    const j = await r.json();
    if (j.ok) {
      fireFlash("ok", `Killed ${j.tmuxName}`);
      load();
    } else fireFlash("bad", `Kill failed: ${j.error}`);
  };
  const openInFinder = async (p: Project) => {
    const r = await fetch(`/api/projects/${encodeURIComponent(p.id)}/open`, { method: "POST" });
    const j = await r.json();
    if (j.ok) fireFlash("ok", `Opened ${p.name} in Finder`);
    else fireFlash("bad", `Open failed: ${j.error}`);
  };
  const forget = async (p: Project) => {
    if (!confirm(`Forget "${p.name}"? This removes its memory entity (files are untouched).`)) return;
    const r = await fetch(`/api/projects/${encodeURIComponent(p.id)}`, { method: "DELETE" });
    const j = await r.json();
    if (j.ok) {
      fireFlash("ok", `Forgot ${p.name}`);
      setProjects((all) => all.filter((x) => x.id !== p.id));
    } else fireFlash("bad", `Forget failed: ${j.error}`);
  };

  const visible = projects.filter((p) => filter === "all" || p.status === filter);
  const counts = {
    all: projects.length,
    running: projects.filter((p) => p.status === "running").length,
    active: projects.filter((p) => p.status === "active").length,
    archived: projects.filter((p) => p.status === "archived").length,
  };

  return (
    <div className={styles.shell}>
      <div className={styles.inner}>
        <header className={styles.header}>
          <div>
            <h1 className={styles.title}>Projects</h1>
            <p className={styles.sub}>
              Every project the graph knows about. Run onboarding from{" "}
              <Link href="/settings">Settings</Link> to pull more from your Claude Code sessions.
            </p>
          </div>
          <div className={styles.filters}>
            {(["running", "active", "all", "archived"] as Filter[]).map((f) => (
              <button
                key={f}
                type="button"
                className={`${styles.tab} ${filter === f ? styles.active : ""} ${f === "running" ? styles.running : ""}`}
                onClick={() => setFilter(f)}
              >
                {f} <span style={{ opacity: 0.6 }}>· {counts[f]}</span>
              </button>
            ))}
          </div>
        </header>

        {loading ? (
          <p style={{ color: "var(--fg-dim)" }}>Loading…</p>
        ) : visible.length === 0 ? (
          <div className={styles.empty}>
            <h2>No projects yet</h2>
            <p>
              Head to <Link href="/settings">Settings → Memory</Link> and click{" "}
              <strong>Run Onboarding</strong> to scan your Claude Code sessions and code directories.
            </p>
          </div>
        ) : (
          <div className={styles.grid}>
            {visible.map((p) => (
              <article key={p.id} className={styles.card}>
                <div className={styles.cardHead}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <h3 className={styles.name}>{p.name}</h3>
                    {p.localPath && <p className={styles.path} title={p.localPath}>{p.localPath}</p>}
                  </div>
                  <span className={`${styles.statusBadge} ${styles[p.status]}`}>
                    <span className={styles.dot} /> {p.status}
                  </span>
                </div>

                <div className={styles.metaRow}>
                  <span>last <strong>{p.lastActiveMs ? formatAgo(p.lastActiveMs) : "—"}</strong></span>
                  {p.sessionId && (
                    <>
                      <span className={styles.sep}>·</span>
                      <span>session <strong>{p.sessionId.slice(0, 8)}</strong></span>
                    </>
                  )}
                  {p.sessionCount > 0 && (
                    <>
                      <span className={styles.sep}>·</span>
                      <span><strong>{p.sessionCount}</strong> {p.sessionCount === 1 ? "session" : "sessions"}</span>
                    </>
                  )}
                  {p.messageCount > 0 && (
                    <>
                      <span className={styles.sep}>·</span>
                      <span><strong>{p.messageCount}</strong> msgs</span>
                    </>
                  )}
                </div>

                {p.lastPrompt && <div className={styles.prompt}>{p.lastPrompt}</div>}

                {p.tmux.name && (p.tmux.runtime === "running" || p.tmux.runtime === "paused") && (
                  <div className={styles.tmuxRow}>
                    <span className={`${styles.tmuxDot} ${styles[p.tmux.runtime]}`} />
                    <code className={styles.tmuxName}>{p.tmux.name}</code>
                    {p.tmux.attached && <span className={styles.tmuxAttached}>· attached</span>}
                    {p.tmux.attachCommand && (
                      <button
                        type="button"
                        className={styles.copyAttach}
                        title="Copy attach command"
                        onClick={() => navigator.clipboard.writeText(p.tmux.attachCommand ?? "")}
                      >
                        copy
                      </button>
                    )}
                  </div>
                )}

                {p.markers.length > 0 && (
                  <div className={styles.markers}>
                    {p.markers.map((m) => (
                      <span key={m} className={styles.markerTag}>{m}</span>
                    ))}
                  </div>
                )}

                <div className={styles.actions}>
                  <button
                    type="button"
                    className={p.status === "running" ? "primary" : "ghost"}
                    onClick={() => resume(p)}
                    disabled={!p.pathExists}
                    title={
                      p.status === "running"
                        ? "Attach a new iTerm window to the existing tmux session"
                        : p.pathExists
                          ? "Start a tmux session running `superclaude --resume`, then attach iTerm to it"
                          : "Path no longer exists"
                    }
                  >
                    {p.status === "running" ? "Attach" : "Resume"}
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => openInFinder(p)}
                    disabled={!p.pathExists}
                  >
                    Finder
                  </button>
                  {(p.status === "running" || p.status === "paused") && (
                    <button
                      type="button"
                      className="danger"
                      onClick={() => killSession(p)}
                      title="Stop the tmux session and drop it from the registry"
                    >
                      Kill
                    </button>
                  )}
                  <button
                    type="button"
                    className="danger"
                    onClick={() => forget(p)}
                  >
                    Forget
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {flash && (
        <div className={`${styles.flash} ${styles[flash.kind]}`}>{flash.text}</div>
      )}
    </div>
  );
}

function formatAgo(ms: number): string {
  const delta = Date.now() - ms;
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}
