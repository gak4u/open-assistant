import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { listSessions } from "./tmux.js";

const DIR = path.join(homedir(), ".open-assistant");
const REGISTRY_PATH = path.join(DIR, "sessions.json");

export interface ProjectRegistryEntry {
  tmux: string;
  claudeSessionId: string;
  path: string;
  lastResumedAt: number;
}

export interface SessionRegistry {
  version: 1;
  projects: Record<string, ProjectRegistryEntry>;
}

const EMPTY: SessionRegistry = { version: 1, projects: {} };

function ensureDir(): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true, mode: 0o700 });
}

export function loadRegistry(): SessionRegistry {
  ensureDir();
  if (!existsSync(REGISTRY_PATH)) {
    writeFileSync(REGISTRY_PATH, JSON.stringify(EMPTY, null, 2), { mode: 0o600 });
    return structuredClone(EMPTY);
  }
  try {
    const raw = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as Partial<SessionRegistry>;
    return {
      version: 1,
      projects: raw.projects ?? {},
    };
  } catch {
    return structuredClone(EMPTY);
  }
}

export function saveRegistry(reg: SessionRegistry): void {
  ensureDir();
  writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2), { mode: 0o600 });
}

export function recordProjectSession(
  projectEntityId: string,
  entry: ProjectRegistryEntry,
): SessionRegistry {
  const reg = loadRegistry();
  reg.projects[projectEntityId] = entry;
  saveRegistry(reg);
  return reg;
}

export function dropProjectSession(projectEntityId: string): SessionRegistry {
  const reg = loadRegistry();
  delete reg.projects[projectEntityId];
  saveRegistry(reg);
  return reg;
}

export type ProjectRuntimeStatus = "running" | "paused" | "archived";

export interface ProjectRuntime {
  status: ProjectRuntimeStatus;
  tmuxName: string | null;
  tmuxAttached: boolean;
  claudeSessionId: string | null;
  lastResumedAt: number;
}

/**
 * Snapshot of all currently-live tmux sessions, indexed by name. Pass the
 * same snapshot to many projectRuntime() calls in a single listing pass to
 * avoid spawning `tmux ls` per project.
 */
export function liveTmuxSnapshot(): Map<string, { attached: boolean }> {
  const map = new Map<string, { attached: boolean }>();
  for (const s of listSessions()) map.set(s.name, { attached: s.attached });
  return map;
}

/**
 * Cross-reference the registry with `tmux ls` and return live runtime state.
 * A project is "running" if its registry tmux session actually exists;
 * "paused" if the registry has an entry but tmux doesn't; "archived" if no
 * registry entry at all (the dashboard further downgrades to archived when
 * the local path is also missing).
 */
export function projectRuntime(
  projectEntityId: string,
  live: Map<string, { attached: boolean }> = liveTmuxSnapshot(),
): ProjectRuntime {
  const reg = loadRegistry();
  const entry = reg.projects[projectEntityId];
  if (!entry) {
    return {
      status: "archived",
      tmuxName: null,
      tmuxAttached: false,
      claudeSessionId: null,
      lastResumedAt: 0,
    };
  }
  const liveEntry = live.get(entry.tmux);
  return {
    status: liveEntry ? "running" : "paused",
    tmuxName: entry.tmux,
    tmuxAttached: liveEntry?.attached ?? false,
    claudeSessionId: entry.claudeSessionId,
    lastResumedAt: entry.lastResumedAt,
  };
}

/** Reconcile registry vs tmux ls — useful on daemon startup or before listing. */
export function reconcileRegistry(): {
  registry: SessionRegistry;
  running: string[];
  paused: string[];
} {
  const reg = loadRegistry();
  const live = liveTmuxSnapshot();
  const running: string[] = [];
  const paused: string[] = [];
  for (const [projectId, entry] of Object.entries(reg.projects)) {
    if (live.has(entry.tmux)) running.push(projectId);
    else paused.push(projectId);
  }
  return { registry: reg, running, paused };
}

export function registryPath(): string {
  return REGISTRY_PATH;
}
