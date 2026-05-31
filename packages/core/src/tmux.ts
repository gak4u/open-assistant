import { spawn, spawnSync } from "node:child_process";

export interface TmuxSessionInfo {
  name: string;
  attached: boolean;
  createdAt: number; // seconds since epoch (from tmux)
  windowCount: number;
}

/**
 * Thin Node wrapper around the `tmux` CLI. Synchronous calls are fine here —
 * tmux operations are all sub-100ms and we use them on hot paths (every
 * project status read).
 */
export function isTmuxAvailable(): boolean {
  try {
    const r = spawnSync("tmux", ["-V"], { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}

export function hasSession(name: string): boolean {
  const r = spawnSync("tmux", ["has-session", "-t", `=${name}`], { stdio: "ignore" });
  return r.status === 0;
}

export function listSessions(): TmuxSessionInfo[] {
  const r = spawnSync(
    "tmux",
    ["list-sessions", "-F", "#{session_name}\t#{session_attached}\t#{session_created}\t#{session_windows}"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return [];
  const out: TmuxSessionInfo[] = [];
  for (const line of (r.stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    const [name, attached, created, windows] = line.split("\t");
    if (!name) continue;
    out.push({
      name,
      attached: attached === "1",
      createdAt: Number(created) || 0,
      windowCount: Number(windows) || 0,
    });
  }
  return out;
}

export interface NewSessionOptions {
  name: string;
  cwd: string;
  /**
   * Initial command, run as the session's startup program (NOT via send-keys
   * after the shell starts). This avoids races with interactive shell init
   * prompts (oh-my-zsh update prompts, password prompts, etc.) that would
   * otherwise eat the first few characters of our typed input. After the
   * command exits we `exec zsh -i` so the tmux pane stays alive for the user.
   */
  command?: string;
  windowName?: string;
}

/**
 * Create a detached tmux session in `cwd`. Returns true if a new session was
 * created, false if a session by that name was already running.
 */
export function newSession(opts: NewSessionOptions): { created: boolean; name: string } {
  if (hasSession(opts.name)) return { created: false, name: opts.name };
  const args = buildNewSessionArgs(opts);
  const r = spawnSync("tmux", args, { stdio: "pipe", encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`tmux new-session failed: ${r.stderr.trim()}`);
  }
  return { created: true, name: opts.name };
}

function buildNewSessionArgs(opts: NewSessionOptions): string[] {
  const args = ["new-session", "-d", "-s", opts.name, "-c", opts.cwd];
  // Suppress oh-my-zsh's auto-update prompt — it fires on interactive shell
  // startup and would block the user (or eat keystrokes).
  args.push("-e", "DISABLE_AUTO_UPDATE=true", "-e", "DISABLE_UPDATE_PROMPT=true");
  if (opts.windowName) args.push("-n", opts.windowName);
  if (opts.command) {
    const shellArg = `${opts.command}; exec ${defaultShell()} -i`;
    args.push(defaultShell(), "-i", "-c", shellArg);
  }
  return args;
}

function defaultShell(): string {
  // Prefer the user's $SHELL so their rc files (and functions like
  // `superclaude`) are available. Fall back to zsh on macOS, bash on Linux.
  return process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
}

export function killSession(name: string): boolean {
  const r = spawnSync("tmux", ["kill-session", "-t", `=${name}`], { stdio: "ignore" });
  return r.status === 0;
}

/**
 * Send a command line to the session as if the user typed it + Enter.
 * Multi-line commands are joined with `;`; if you need real newlines, send
 * them as separate calls.
 */
export function sendCommand(name: string, command: string): void {
  const r = spawnSync(
    "tmux",
    ["send-keys", "-t", `${name}:`, command, "Enter"],
    { stdio: "pipe", encoding: "utf8" },
  );
  if (r.status !== 0) {
    throw new Error(`tmux send-keys failed: ${r.stderr.trim()}`);
  }
}

/** Capture the last N lines from the active pane of a session. */
export function capturePane(name: string, lines = 200): string {
  const r = spawnSync(
    "tmux",
    ["capture-pane", "-p", "-t", `${name}:`, "-S", `-${lines}`],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return "";
  return r.stdout ?? "";
}

/** The shell command a user runs in their own terminal to attach. */
export function attachCommand(name: string): string {
  return `tmux attach -t ${shellQuote(name)}`;
}

/**
 * Canonical tmux session name for a project. Slug derived from the entity id
 * so it's stable across renames. Bounded length so tmux is happy.
 */
export function sessionNameFor(projectEntityId: string): string {
  const slug = projectEntityId.replace(/^project:/, "").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
  return `oa-${slug}`;
}

// Async variant when the caller wants to await (e.g. inside an HTTP handler
// that's already async); avoids blocking the event loop on synchronous spawn.
export function newSessionAsync(opts: NewSessionOptions): Promise<{ created: boolean; name: string }> {
  return new Promise((resolve, reject) => {
    if (hasSession(opts.name)) return resolve({ created: false, name: opts.name });
    const args = buildNewSessionArgs(opts);
    const child = spawn("tmux", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`tmux new-session failed: ${stderr.trim()}`));
      resolve({ created: true, name: opts.name });
    });
  });
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
