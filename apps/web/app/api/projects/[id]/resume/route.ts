import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
  const entity = await memory().getEntity(id);
  if (!entity) return NextResponse.json({ ok: false, error: "project not found" }, { status: 404 });
  const localPath = String(entity.attributes?.["local_path"] ?? "");
  if (!localPath) return NextResponse.json({ ok: false, error: "project has no local_path" }, { status: 400 });
  if (!existsSync(localPath))
    return NextResponse.json({ ok: false, error: `path missing: ${localPath}` }, { status: 400 });

  // Pick iTerm if installed, fall back to Terminal.
  const useITerm = existsSync("/Applications/iTerm.app");
  const cdCmd = `cd ${shellQuote(localPath)} && claude`;
  const script = useITerm
    ? `tell application "iTerm"
         activate
         create window with default profile
         tell current session of current window
           write text ${appleQuote(cdCmd)}
         end tell
       end tell`
    : `tell application "Terminal"
         activate
         do script ${appleQuote(cdCmd)}
       end tell`;

  return new Promise<Response>((resolve) => {
    const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("close", (code) => {
      if (code === 0) resolve(NextResponse.json({ ok: true, opened_in: useITerm ? "iTerm" : "Terminal", path: localPath }));
      else
        resolve(
          NextResponse.json(
            { ok: false, error: `osascript exited ${code}: ${err.trim()}` },
            { status: 500 },
          ),
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
