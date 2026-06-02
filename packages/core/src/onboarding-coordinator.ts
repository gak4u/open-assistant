import { EventEmitter } from "node:events";
import { MemoryStore } from "@open-assistant/memory";
import { saveConfig } from "./config.js";
import { runOnboarding, type OnboardingEvent, type OnboardingOptions, type OnboardingSummary } from "./onboarding.js";

export type CoordinatorState = "idle" | "running" | "done" | "error";

export interface CoordinatorSnapshot {
  state: CoordinatorState;
  startedAt: number;
  finishedAt: number;
  lightweight: boolean;
  events: OnboardingEvent[];
  summary?: OnboardingSummary;
  error?: string;
}

/**
 * Wraps runOnboarding so a single run can have multiple subscribers and so
 * concurrent triggers no-op into the existing run. Both the MCP server's
 * auto-on-first-connect path and the explicit `run_onboarding` tool share
 * the same coordinator state.
 */
export class OnboardingCoordinator {
  private snapshot: CoordinatorSnapshot = {
    state: "idle",
    startedAt: 0,
    finishedAt: 0,
    lightweight: false,
    events: [],
  };
  private readonly emitter = new EventEmitter();
  private current: Promise<OnboardingSummary> | null = null;

  isIdle(): boolean {
    return this.snapshot.state !== "running";
  }

  current_snapshot(): CoordinatorSnapshot {
    return { ...this.snapshot, events: [...this.snapshot.events] };
  }

  on(event: "event", handler: (e: OnboardingEvent) => void): () => void;
  on(event: "done", handler: (s: CoordinatorSnapshot) => void): () => void;
  on(event: string, handler: (...args: never[]) => void): () => void {
    this.emitter.on(event, handler as never);
    return () => this.emitter.off(event, handler as never);
  }

  /**
   * Start a run. If one's already in progress, returns the in-flight promise
   * so callers attach to the same execution.
   */
  start(store: MemoryStore, opts: OnboardingOptions = {}): Promise<OnboardingSummary> {
    if (this.current) return this.current;

    this.snapshot = {
      state: "running",
      startedAt: Date.now(),
      finishedAt: 0,
      lightweight: !!opts.lightweight,
      events: [],
    };

    this.current = (async () => {
      try {
        let lastSummary: OnboardingSummary | undefined;
        for await (const event of runOnboarding(store, opts)) {
          this.snapshot.events.push(event);
          this.emitter.emit("event", event);
          if (event.type === "done" && event.summary) lastSummary = event.summary;
          if (event.type === "error" && event.error) this.snapshot.error = event.error;
        }
        this.snapshot.summary = lastSummary;
        this.snapshot.state = lastSummary ? "done" : "error";
        this.snapshot.finishedAt = Date.now();

        if (lastSummary) {
          // Persist the completion flag — same shape the SSE route writes.
          try {
            saveConfig({
              onboarding: {
                completed: true,
                lastRunAt: this.snapshot.finishedAt,
                lastSummary: {
                  sessionsFound: lastSummary.sessionsFound,
                  reposFound: lastSummary.reposFound,
                  projectsCreated: lastSummary.projectsCreated,
                  entitiesCreated: lastSummary.entitiesCreated,
                  relationsCreated: lastSummary.relationsCreated,
                },
              },
            });
          } catch {
            /* config write is best-effort */
          }
        }

        this.emitter.emit("done", this.current_snapshot());
        return lastSummary ?? ({} as OnboardingSummary);
      } finally {
        this.current = null;
      }
    })();

    return this.current;
  }
}

let singleton: OnboardingCoordinator | null = null;
/** Process-wide singleton — multiple MCP sessions share the same run state. */
export function onboardingCoordinator(): OnboardingCoordinator {
  if (!singleton) singleton = new OnboardingCoordinator();
  return singleton;
}
