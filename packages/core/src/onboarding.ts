import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { MemoryStore, entityId, type EntityType, type RelationType } from "@open-assistant/memory";
import { detectStatus as detectSuperclaude, install as installSuperclaude } from "./superclaude.js";

export type OnboardingPhase =
  | "checking_superclaude"
  | "scanning_sessions"
  | "resolving_paths"
  | "scanning_repos"
  | "matching"
  | "building_graph"
  | "done"
  | "error";

export interface OnboardingEvent {
  type: "phase" | "progress" | "message" | "done" | "error";
  phase?: OnboardingPhase;
  current?: number;
  total?: number;
  message?: string;
  summary?: OnboardingSummary;
  error?: string;
}

export interface OnboardingSummary {
  sessionsFound: number;
  sessionsParsed: number;
  reposFound: number;
  sessionsMatched: number;
  projectsCreated: number;
  entitiesCreated: number;
  relationsCreated: number;
  durationMs: number;
}

interface SessionRecord {
  sessionId: string;
  jsonlPath: string;
  cwd: string;
  lastActiveMs: number;
  firstPrompt: string;
  messageCount: number;
  source: "index" | "jsonl-scan";
}

interface RepoRecord {
  path: string;
  name: string;
  markers: string[];
}

export interface OnboardingOptions {
  /** Override the path where Claude Code session dirs live. */
  claudeProjectsDir?: string;
  /** Override the dirs scanned for code repos. */
  repoSearchDirs?: string[];
  /** Max depth when walking repoSearchDirs. */
  repoMaxDepth?: number;
  /**
   * Lightweight mode: skip the filesystem repo scan and only seed projects
   * from Claude Code sessions. Used by the auto-on-first-connect path from
   * the MCP server, where we want a fast first impression and let the user
   * run the full sweep on demand.
   */
  lightweight?: boolean;
}

const DEFAULT_REPO_DIRS = [
  path.join(homedir(), "Projects"),
  path.join(homedir(), "Personal"),
  path.join(homedir(), "Work"),
  path.join(homedir(), "Code"),
  path.join(homedir(), "src"),
  path.join(homedir(), "Developer"),
  path.join(homedir(), "Documents"),
];

const REPO_MARKERS = [".git", "package.json", "Cargo.toml", "pyproject.toml", "go.mod", "Gemfile"];

// Heuristic: skip session dirs whose cwd looks like a temp/scratch path.
const SKIP_CWD_PATTERNS = [
  /^\/private\/tmp\b/,
  /^\/tmp\b/,
  /^\/var\/folders\b/,
  /^\/$/, // bare "/" sessions
];

/**
 * Onboarding engine. Walks Claude Code's session store and the user's code
 * directories, persisting one project entity per real project. Yields a
 * stream of progress events so the UI can render a live progress bar.
 */
export async function* runOnboarding(
  store: MemoryStore,
  opts: OnboardingOptions = {},
): AsyncGenerator<OnboardingEvent, OnboardingSummary, void> {
  const start = Date.now();
  const summary: OnboardingSummary = {
    sessionsFound: 0,
    sessionsParsed: 0,
    reposFound: 0,
    sessionsMatched: 0,
    projectsCreated: 0,
    entitiesCreated: 0,
    relationsCreated: 0,
    durationMs: 0,
  };

  try {
    const claudeRoot = opts.claudeProjectsDir ?? path.join(homedir(), ".claude", "projects");
    const repoDirs = (opts.repoSearchDirs ?? DEFAULT_REPO_DIRS).filter((d) => existsSync(d));

    // --- Phase 0: ensure `superclaude` is wired up in the user's shell ----
    yield { type: "phase", phase: "checking_superclaude", message: "Checking superclaude…" };
    const before = detectSuperclaude();
    if (before.installed) {
      const where = before.rcFile ? ` (defined in ${shortPath(before.rcFile)})` : "";
      yield { type: "message", message: `superclaude already installed${where}` };
    } else if (!before.rcFile) {
      // Shell unknown — log the fallback we'll use and continue.
      yield {
        type: "message",
        message: `superclaude not installed — shell unknown, will use \`claude --dangerously-skip-permissions\` directly`,
      };
    } else {
      yield {
        type: "message",
        message: `superclaude not found — installing into ${shortPath(before.rcFile)}…`,
      };
      const result = installSuperclaude();
      if (result.wrote) {
        const v = result.version ? ` (verified ${result.version})` : "";
        yield {
          type: "message",
          message: `superclaude installed${v}. ${result.hint ?? ""}`.trim(),
        };
      } else if (result.error) {
        // Non-fatal — onboarding continues with claude fallback.
        yield {
          type: "message",
          message: `superclaude install failed: ${result.error}. Using \`claude --dangerously-skip-permissions\` fallback.`,
        };
      }
    }

    // --- Phase 1: enumerate session dirs ----------------------------------
    yield { type: "phase", phase: "scanning_sessions", message: `Scanning ${claudeRoot}…` };
    if (!existsSync(claudeRoot)) {
      yield { type: "message", message: `Claude projects dir not found at ${claudeRoot}` };
    }
    const sessionDirs = existsSync(claudeRoot)
      ? readdirSync(claudeRoot, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => path.join(claudeRoot, d.name))
      : [];

    yield { type: "message", message: `Found ${sessionDirs.length} session directories` };

    const sessions: SessionRecord[] = [];
    for (let i = 0; i < sessionDirs.length; i++) {
      const dir = sessionDirs[i]!;
      yield { type: "progress", phase: "scanning_sessions", current: i + 1, total: sessionDirs.length };
      const fromIndex = readSessionsIndex(dir);
      if (fromIndex.length) {
        sessions.push(...fromIndex);
        continue;
      }
      sessions.push(...readJsonlsInDir(dir));
    }
    summary.sessionsFound = sessions.length;
    summary.sessionsParsed = sessions.length;
    yield { type: "message", message: `Parsed ${sessions.length} sessions` };

    // --- Phase 2: drop sessions whose cwd is gone or temp -----------------
    yield { type: "phase", phase: "resolving_paths", message: "Resolving project paths…" };
    const validSessions = sessions.filter((s) => {
      if (!s.cwd) return false;
      if (SKIP_CWD_PATTERNS.some((p) => p.test(s.cwd))) return false;
      return existsSync(s.cwd);
    });
    yield { type: "message", message: `${validSessions.length} sessions point to live paths` };

    // --- Phase 3: scan filesystem for repos (skipped in lightweight mode) --
    const repos: RepoRecord[] = [];
    if (opts.lightweight) {
      yield {
        type: "message",
        message: "Skipping repo discovery (lightweight mode — run full onboarding from the web UI to scan ~/Projects, ~/Personal, etc.)",
      };
    } else {
      yield { type: "phase", phase: "scanning_repos", message: `Scanning ${repoDirs.length} repo roots…` };
      const maxDepth = opts.repoMaxDepth ?? 3;
      for (let i = 0; i < repoDirs.length; i++) {
        const root = repoDirs[i]!;
        yield {
          type: "progress",
          phase: "scanning_repos",
          current: i + 1,
          total: repoDirs.length,
          message: `Scanning ${shortPath(root)}…`,
        };
        walkForRepos(root, maxDepth, repos);
      }
      summary.reposFound = repos.length;
      yield { type: "message", message: `Found ${repos.length} repos` };
    }

    // --- Phase 4: match sessions ↔ repos, build project list --------------
    yield { type: "phase", phase: "matching", message: "Matching sessions to repos…" };
    const reposByPath = new Map<string, RepoRecord>();
    for (const r of repos) reposByPath.set(r.path, r);

    interface ProjectAggregate {
      path: string;
      name: string;
      sessionIds: string[];
      lastActiveMs: number;
      messageCount: number;
      lastPrompt: string;
      markers: string[];
      hasRepo: boolean;
    }
    const projects = new Map<string, ProjectAggregate>();

    // Seed from sessions
    for (const s of validSessions) {
      const matched = reposByPath.get(s.cwd) ?? findEnclosingRepo(repos, s.cwd);
      const projPath = matched?.path ?? s.cwd;
      const name = matched?.name ?? (path.basename(s.cwd) || "root");
      const cur = projects.get(projPath) ?? {
        path: projPath,
        name,
        sessionIds: [],
        lastActiveMs: 0,
        messageCount: 0,
        lastPrompt: "",
        markers: matched?.markers ?? [],
        hasRepo: !!matched,
      };
      cur.sessionIds.push(s.sessionId);
      cur.lastActiveMs = Math.max(cur.lastActiveMs, s.lastActiveMs);
      cur.messageCount += s.messageCount;
      if (s.lastActiveMs >= cur.lastActiveMs - 1) cur.lastPrompt = s.firstPrompt;
      if (matched) cur.hasRepo = true;
      projects.set(projPath, cur);
    }
    // Seed from repos that have no session
    for (const r of repos) {
      if (!projects.has(r.path)) {
        projects.set(r.path, {
          path: r.path,
          name: r.name,
          sessionIds: [],
          lastActiveMs: 0,
          messageCount: 0,
          lastPrompt: "",
          markers: r.markers,
          hasRepo: true,
        });
      }
    }
    summary.sessionsMatched = validSessions.filter(
      (s) => reposByPath.has(s.cwd) || findEnclosingRepo(repos, s.cwd) !== null,
    ).length;
    yield {
      type: "message",
      message: `Aggregated to ${projects.size} unique projects (${summary.sessionsMatched} sessions matched to repos)`,
    };

    // --- Phase 5: write to FalkorDB ---------------------------------------
    yield { type: "phase", phase: "building_graph", message: "Building memory graph…" };
    const projectArr = [...projects.values()].sort((a, b) => b.lastActiveMs - a.lastActiveMs);
    for (let i = 0; i < projectArr.length; i++) {
      const p = projectArr[i]!;
      yield {
        type: "progress",
        phase: "building_graph",
        current: i + 1,
        total: projectArr.length,
        message: p.name,
      };
      const attrs: Record<string, string | number | boolean> = {
        local_path: p.path,
        session_count: p.sessionIds.length,
        message_count: p.messageCount,
        has_repo: p.hasRepo,
      };
      if (p.sessionIds.length) attrs["session_id"] = p.sessionIds[0]!;
      if (p.lastActiveMs) attrs["last_active_ms"] = p.lastActiveMs;
      if (p.markers.length) attrs["markers"] = p.markers.join(",");
      if (p.lastPrompt) attrs["last_prompt"] = p.lastPrompt.slice(0, 200);

      await store.upsertEntity({
        id: entityId("project", p.name),
        type: "project",
        name: p.name,
        description: p.path,
        attributes: attrs,
      });
      summary.projectsCreated++;
      summary.entitiesCreated++;

      // Link to markers as artifact entities — a lightweight tech-stack hint.
      for (const marker of p.markers) {
        const tech = techFor(marker);
        if (!tech) continue;
        const techEntity = await store.upsertEntity({
          type: "topic" as EntityType,
          name: tech,
          description: "Detected via repo marker",
        });
        summary.entitiesCreated++;
        await store.addRelation({
          from: entityId("project", p.name),
          to: techEntity.id,
          type: "depends_on" as RelationType,
        });
        summary.relationsCreated++;
      }
    }

    summary.durationMs = Date.now() - start;
    yield { type: "done", phase: "done", summary };
    return summary;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    summary.durationMs = Date.now() - start;
    yield { type: "error", phase: "error", error: msg, summary };
    return summary;
  }
}

// ---------------- helpers ----------------

interface IndexEntry {
  sessionId?: string;
  fullPath?: string;
  fileMtime?: number;
  firstPrompt?: string;
  messageCount?: number;
  projectPath?: string;
}

function readSessionsIndex(dir: string): SessionRecord[] {
  const idxPath = path.join(dir, "sessions-index.json");
  if (!existsSync(idxPath)) return [];
  try {
    const raw = JSON.parse(readFileSync(idxPath, "utf8")) as { entries?: IndexEntry[] };
    const out: SessionRecord[] = [];
    for (const e of raw.entries ?? []) {
      if (!e.sessionId || !e.projectPath || !e.fullPath) continue;
      out.push({
        sessionId: e.sessionId,
        jsonlPath: e.fullPath,
        cwd: e.projectPath,
        lastActiveMs: e.fileMtime ?? 0,
        firstPrompt: e.firstPrompt ?? "",
        messageCount: e.messageCount ?? 0,
        source: "index",
      });
    }
    return out;
  } catch {
    return [];
  }
}

function readJsonlsInDir(dir: string): SessionRecord[] {
  const out: SessionRecord[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    const sessionId = name.replace(/\.jsonl$/, "");
    let cwd = "";
    try {
      // Pull the first cwd we find in the file. Reading the full file is
      // wasteful for huge logs, but they're short and we only do this once.
      const text = readFileSync(full, "utf8");
      const m = text.match(/"cwd"\s*:\s*"([^"]+)"/);
      cwd = m?.[1] ?? "";
    } catch {
      /* unreadable */
    }
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(full).mtimeMs;
    } catch {
      /* gone */
    }
    out.push({
      sessionId,
      jsonlPath: full,
      cwd,
      lastActiveMs: mtimeMs,
      firstPrompt: "",
      messageCount: 0,
      source: "jsonl-scan",
    });
  }
  return out;
}

function walkForRepos(root: string, maxDepth: number, into: RepoRecord[]): void {
  const visit = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: { name: string; isDir: boolean }[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).map((d) => ({
        name: d.name,
        isDir: d.isDirectory(),
      }));
    } catch {
      return;
    }
    const markers = REPO_MARKERS.filter((m) => entries.some((e) => e.name === m));
    if (markers.length) {
      into.push({ path: dir, name: path.basename(dir), markers });
      // Don't descend into a repo — nested submodules / monorepos are out of scope.
      return;
    }
    // Heuristic: skip dirs that obviously aren't user repos.
    for (const e of entries) {
      if (!e.isDir) continue;
      if (e.name.startsWith(".")) continue;
      if (e.name === "node_modules" || e.name === "venv" || e.name === ".venv") continue;
      visit(path.join(dir, e.name), depth + 1);
    }
  };
  visit(root, 0);
}

function findEnclosingRepo(repos: RepoRecord[], p: string): RepoRecord | null {
  // Longest-prefix match so /Users/x/Projects/foo/sub picks /Users/x/Projects/foo.
  let best: RepoRecord | null = null;
  for (const r of repos) {
    if (p === r.path || p.startsWith(r.path + path.sep)) {
      if (!best || r.path.length > best.path.length) best = r;
    }
  }
  return best;
}

function techFor(marker: string): string | null {
  switch (marker) {
    case "package.json": return "Node.js";
    case "Cargo.toml": return "Rust";
    case "pyproject.toml": return "Python";
    case "go.mod": return "Go";
    case "Gemfile": return "Ruby";
    case ".git": return null; // not really a tech
    default: return null;
  }
}

function shortPath(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}
