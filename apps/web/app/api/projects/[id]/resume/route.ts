import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  attachCommand,
  hasSession,
  isTmuxAvailable,
  newSessionAsync,
  recordProjectSession,
  sessionNameFor,
} from "@open-assistant/core";
import { memory } from "@/lib/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (process.platform !== "darwin") {
    return NextResponse.json(
      { ok: false, error: "Resume in iTerm is macOS-only (osascript not available)" },
      { status: 400 },
    );
  }
  if (!isTmuxAvailable()) {
    return NextResponse.json(
      { ok: false, error: "tmux not found on PATH — install it: `brew install tmux`" },
      { status: 400 },
    );
  }
  const entity = await memory().getEntity(id);
  if (!entity) return NextResponse.json({ ok: false, error: "project not found" }, { status: 404 });
  const localPath = String(entity.attributes?.["local_path"] ?? "");
  if (!localPath) return NextResponse.json({ ok: false, error: "project has no local_path" }, { status: 400 });
  if (!existsSync(localPath))
    return NextResponse.json({ ok: false, error: `path missing: ${localPath}` }, { status: 400 });
  const sessionId = String(entity.attributes?.["session_id"] ?? "");
  const tabName = entity.name;
  const tmuxName = sessionNameFor(id);

  // 1) Create-or-attach the project's tmux session. If it's already running
  //    (e.g. user resumed earlier and the daemon was restarted) we just attach
  //    to it; the existing Claude Code is still alive in there.
  let created = false;
  const alreadyExisted = hasSession(tmuxName);
  if (!alreadyExisted) {
    // `superclaude` is a shell function in the user's interactive zsh that
    // wraps `claude --dangerously-skip-permissions`. We use `if … then … else`
    // (not `() || …`) because zsh chokes on subshell redirections in that form.
    const claudeCmd = sessionId
      ? `if type superclaude >/dev/null 2>&1; then superclaude --resume ${shellQuote(sessionId)}; else claude --dangerously-skip-permissions --resume ${shellQuote(sessionId)}; fi`
      : `if type superclaude >/dev/null 2>&1; then superclaude; else claude; fi`;
    const result = await newSessionAsync({
      name: tmuxName,
      cwd: localPath,
      command: claudeCmd,
      windowName: tabName.slice(0, 32),
    });
    created = result.created;
  }

  // 2) Record in the registry (so reconcileRegistry sees it as "running").
  recordProjectSession(id, {
    tmux: tmuxName,
    claudeSessionId: sessionId,
    path: localPath,
    lastResumedAt: Date.now(),
  });

  // 3) Open an iTerm window that attaches to the tmux session.
  const useITerm = existsSync("/Applications/iTerm.app");
  const attach = attachCommand(tmuxName);
  const script = useITerm
    ? `tell application "iTerm"
         activate
         set newWin to (create window with default profile)
         tell current session of newWin
           set name to ${appleQuote(tabName)}
           write text ${appleQuote(attach)}
         end tell
       end tell`
    : `tell application "Terminal"
         activate
         set newTab to (do script ${appleQuote(attach)})
         set custom title of newTab to ${appleQuote(tabName)}
       end tell`;

  return new Promise<Response>((resolve) => {
    const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("close", (code) => {
      if (code !== 0) {
        return resolve(
          NextResponse.json(
            { ok: false, error: `osascript exited ${code}: ${err.trim()}` },
            { status: 500 },
          ),
        );
      }
      resolve(
        NextResponse.json({
          ok: true,
          opened_in: useITerm ? "iTerm" : "Terminal",
          path: localPath,
          sessionId: sessionId || null,
          tmuxName,
          tmuxCreated: created,
          alreadyRunning: alreadyExisted,
          attachCommand: attach,
          tabName,
        }),
      );
    });
  });
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
function appleQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
