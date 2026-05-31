"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./onboarding.module.css";

type Phase = "scanning_sessions" | "resolving_paths" | "scanning_repos" | "matching" | "building_graph" | "done" | "error";

interface ProgressState {
  phase: Phase;
  current: number;
  total: number;
  message: string;
  log: string[];
}

interface SummaryT {
  sessionsFound: number;
  reposFound: number;
  projectsCreated: number;
  entitiesCreated: number;
  relationsCreated: number;
  sessionsMatched?: number;
  durationMs?: number;
}

export interface OnboardingModalProps {
  /** When `triggeredAt` changes to a fresh value, the modal opens and starts the run. */
  triggeredAt: number | null;
  onClose: () => void;
  onComplete?: (summary: SummaryT) => void;
}

const PHASE_LABEL: Record<Phase, string> = {
  scanning_sessions: "Scanning sessions",
  resolving_paths: "Resolving paths",
  scanning_repos: "Scanning repos",
  matching: "Matching sessions to repos",
  building_graph: "Building memory graph",
  done: "Done",
  error: "Error",
};

export function OnboardingModal({ triggeredAt, onClose, onComplete }: OnboardingModalProps) {
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState<ProgressState>({
    phase: "scanning_sessions",
    current: 0,
    total: 0,
    message: "",
    log: [],
  });
  const [summary, setSummary] = useState<SummaryT | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    setSummary(null);
    setProgress({ phase: "scanning_sessions", current: 0, total: 0, message: "", log: [] });

    try {
      const res = await fetch("/api/onboarding/run", { method: "POST" });
      if (!res.ok || !res.body) throw new Error(`http ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

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
          if (evt === "phase") {
            setProgress((p) => ({
              ...p,
              phase: (payload.phase as Phase) ?? p.phase,
              current: 0,
              total: 0,
              message: (payload.message as string) ?? "",
            }));
          } else if (evt === "progress") {
            setProgress((p) => ({
              ...p,
              phase: (payload.phase as Phase) ?? p.phase,
              current: (payload.current as number) ?? p.current,
              total: (payload.total as number) ?? p.total,
              message: (payload.message as string) ?? p.message,
            }));
          } else if (evt === "message") {
            setProgress((p) => ({
              ...p,
              log: [...p.log, String(payload.message ?? "")].slice(-8),
            }));
          } else if (evt === "done") {
            const s = (payload.summary ?? {}) as SummaryT;
            setSummary(s);
            onComplete?.(s);
          } else if (evt === "error") {
            setError((payload.error as string) ?? "Onboarding failed");
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [onComplete]);

  useEffect(() => {
    if (triggeredAt !== null) {
      setOpen(true);
      run();
    }
  }, [triggeredAt, run]);

  if (!open) return null;

  const pct = progress.total > 0 ? Math.min(100, Math.round((progress.current / progress.total) * 100)) : 0;

  return (
    <div className={styles.overlay} onClick={() => !running && setOpen(false)}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <header className={styles.header}>
          <h2>Onboarding</h2>
          <p className={styles.sub}>
            Scanning your Claude Code sessions and code directories to seed the memory graph.
          </p>
        </header>

        {summary ? (
          <div className={styles.summary}>
            <div className={styles.checkRow}>
              <span className={styles.check}>✓</span> All done
            </div>
            <dl className={styles.stats}>
              <dt>Sessions found</dt><dd>{summary.sessionsFound}</dd>
              <dt>Repos found</dt><dd>{summary.reposFound}</dd>
              <dt>Projects created</dt><dd>{summary.projectsCreated}</dd>
              <dt>Entities added</dt><dd>{summary.entitiesCreated}</dd>
              <dt>Relations added</dt><dd>{summary.relationsCreated}</dd>
              {typeof summary.durationMs === "number" && (
                <><dt>Took</dt><dd>{(summary.durationMs / 1000).toFixed(1)}s</dd></>
              )}
            </dl>
            <footer className={styles.footer}>
              <button type="button" className="primary" onClick={() => { setOpen(false); onClose(); }}>
                Done
              </button>
            </footer>
          </div>
        ) : error ? (
          <div className={styles.errorBox}>
            <p>Onboarding failed:</p>
            <pre>{error}</pre>
            <footer className={styles.footer}>
              <button type="button" className="ghost" onClick={() => { setOpen(false); onClose(); }}>Close</button>
              <button type="button" className="primary" onClick={() => run()}>Retry</button>
            </footer>
          </div>
        ) : (
          <div className={styles.body}>
            <div className={styles.phaseLine}>
              <span className={styles.spinner} />
              <strong>{PHASE_LABEL[progress.phase] ?? progress.phase}</strong>
              {progress.total > 0 && (
                <span className={styles.counter}>({progress.current}/{progress.total})</span>
              )}
            </div>
            {progress.message && (
              <p className={styles.message}>{progress.message}</p>
            )}
            <div className={styles.progressTrack}>
              <div className={styles.progressFill} style={{ width: `${pct}%` }} />
            </div>
            <ul className={styles.log}>
              {progress.log.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
