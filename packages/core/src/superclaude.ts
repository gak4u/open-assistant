import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type DetectedShell = "zsh" | "bash" | "fish" | "unknown";

export interface SuperclaudeStatus {
  /** Final answer: is the user able to invoke `superclaude` from their shell. */
  installed: boolean;
  /** Detected from $SHELL — used to pick which rc file to modify. */
  shell: DetectedShell;
  /** The rc file we'd write to (or did write to). null if shell is unknown. */
  rcFile: string | null;
  /**
   * How we know it's installed:
   *   - "our-marker"   we previously wrote it ourselves
   *   - "user-defined" the user had it before (no marker, but a definition exists)
   *   - "not-found"    rc file has no definition
   */
  source: "our-marker" | "user-defined" | "not-found";
  /** Optional `superclaude --version` output, if we ran it. */
  version?: string;
  /** A copy-pasteable note for the user about reloading existing shells. */
  hint?: string;
}

export interface InstallResult extends SuperclaudeStatus {
  /** True if we wrote to the rc file in this call. False if no-op. */
  wrote: boolean;
  /** What we appended (for the UI to show). */
  snippet?: string;
  /** What failed, if anything. */
  error?: string;
}

const MARKER = "# added by open-assistant";

const POSIX_FUNCTION = (marker: string) =>
  `\n${marker}\nsuperclaude() {\n  claude --dangerously-skip-permissions "$@"\n}\n`;

const FISH_FUNCTION = `function superclaude\n    claude --dangerously-skip-permissions $argv\nend\n`;

/** Pick the right shell flavour for the current user. */
export function detectShell(envShell: string | undefined = process.env.SHELL): DetectedShell {
  if (!envShell) return "unknown";
  const base = path.basename(envShell);
  if (base === "zsh") return "zsh";
  if (base === "bash") return "bash";
  if (base === "fish") return "fish";
  return "unknown";
}

/**
 * The rc / functions file we'd modify for a given shell. For bash we prefer
 * ~/.bashrc, but if only ~/.bash_profile exists (the common macOS shape) we
 * pick that instead.
 */
export function rcFileFor(shell: DetectedShell, home = homedir()): string | null {
  switch (shell) {
    case "zsh":
      return path.join(home, ".zshrc");
    case "bash": {
      const rc = path.join(home, ".bashrc");
      const profile = path.join(home, ".bash_profile");
      if (existsSync(rc)) return rc;
      if (existsSync(profile)) return profile;
      return rc; // we'll create it
    }
    case "fish":
      return path.join(home, ".config", "fish", "functions", "superclaude.fish");
    case "unknown":
    default:
      return null;
  }
}

/**
 * Returns the current install state without modifying anything. Cheap —
 * reads at most one file. Fast enough to call on every settings render.
 */
export function detectStatus(envShell?: string): SuperclaudeStatus {
  const shell = detectShell(envShell);
  const rcFile = rcFileFor(shell);
  if (!rcFile || !existsSync(rcFile)) {
    return {
      installed: false,
      shell,
      rcFile,
      source: "not-found",
      hint: shell === "unknown"
        ? "Could not detect your shell from $SHELL. Open the daemon with $SHELL set, or run `claude --dangerously-skip-permissions` directly."
        : undefined,
    };
  }
  const text = readFileSync(rcFile, "utf8");
  if (text.includes(MARKER) && /\bsuperclaude\b/.test(text)) {
    return { installed: true, shell, rcFile, source: "our-marker", hint: sourceHint(rcFile, shell) };
  }
  // Fish defines a function-per-file; for fish, file presence is the signal.
  if (shell === "fish") {
    return { installed: true, shell, rcFile, source: "user-defined", hint: sourceHint(rcFile, shell) };
  }
  if (hasSuperclaudeDefinition(text)) {
    return { installed: true, shell, rcFile, source: "user-defined", hint: sourceHint(rcFile, shell) };
  }
  return { installed: false, shell, rcFile, source: "not-found" };
}

/**
 * Install the superclaude function into the user's rc file (idempotent).
 * If it's already there (ours or theirs), no-op. Verifies by spawning the
 * user's shell interactively and asking for `superclaude --version`.
 */
export function install(envShell?: string): InstallResult {
  const status = detectStatus(envShell);
  if (status.installed) {
    return { ...status, wrote: false };
  }
  if (!status.rcFile) {
    return {
      ...status,
      wrote: false,
      error:
        "Cannot install: shell not detected. Set $SHELL or run `claude --dangerously-skip-permissions` directly.",
    };
  }

  const rcFile = status.rcFile;
  const shell = status.shell;
  let snippet = "";
  try {
    if (shell === "fish") {
      // One function per file is the fish convention.
      mkdirSync(path.dirname(rcFile), { recursive: true });
      snippet = `# ${MARKER.replace(/^# /, "")}\n${FISH_FUNCTION}`;
      writeFileSync(rcFile, snippet, { mode: 0o644 });
    } else {
      snippet = POSIX_FUNCTION(MARKER);
      // Make sure the file exists; appendFileSync will create it, but we want
      // ownership to be the user's umask.
      if (!existsSync(rcFile)) writeFileSync(rcFile, "", { mode: 0o644 });
      appendFileSync(rcFile, snippet);
    }
  } catch (err) {
    return {
      ...status,
      wrote: false,
      error: `Failed to write ${rcFile}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Re-detect so the result reflects post-install state.
  const after = detectStatus(envShell);
  const version = tryVersionThroughShell(shell);
  return {
    ...after,
    wrote: true,
    snippet,
    version,
    hint: sourceHint(rcFile, shell),
  };
}

/**
 * Best-effort version probe. Spawns the user's interactive shell so the
 * function definition resolves. Returns undefined if the shell errors or
 * the function isn't reachable from a fresh subshell.
 */
function tryVersionThroughShell(shell: DetectedShell): string | undefined {
  if (shell === "unknown") return undefined;
  const bin =
    shell === "zsh" ? "/bin/zsh" :
    shell === "bash" ? "/bin/bash" :
    "fish";
  // Fish's interactive flag differs; we just shell into the right binary.
  const args = shell === "fish"
    ? ["-c", "superclaude --version"]
    : ["-i", "-c", "superclaude --version 2>&1"];
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      DISABLE_AUTO_UPDATE: "true",
      DISABLE_UPDATE_PROMPT: "true",
    },
    timeout: 8000,
  });
  if (r.status !== 0) return undefined;
  // Pull the first plausible version line.
  const out = (r.stdout ?? "").trim();
  const m = out.match(/(\d+\.\d+\.\d+\S*)/);
  return m?.[1] ? `${m[1]}` : out.split("\n").pop() || undefined;
}

function hasSuperclaudeDefinition(rcText: string): boolean {
  return (
    /^\s*superclaude\s*\(\s*\)/m.test(rcText) ||
    /^\s*function\s+superclaude\b/m.test(rcText) ||
    /^\s*alias\s+superclaude=/m.test(rcText)
  );
}

function sourceHint(rcFile: string, shell: DetectedShell): string {
  if (shell === "fish") {
    return `Fish picks up new functions automatically. New terminals will see superclaude immediately.`;
  }
  const tilde = rcFile.replace(homedir(), "~");
  return `Run \`source ${tilde}\` in any open terminal (or just open a new one) to use superclaude there.`;
}

export const SUPERCLAUDE_MARKER = MARKER;
