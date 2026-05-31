import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { memory } from "@/lib/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const entity = await memory().getEntity(id);
  if (!entity) return NextResponse.json({ ok: false, error: "project not found" }, { status: 404 });
  const localPath = String(entity.attributes?.["local_path"] ?? "");
  if (!localPath) return NextResponse.json({ ok: false, error: "project has no local_path" }, { status: 400 });
  if (!existsSync(localPath))
    return NextResponse.json({ ok: false, error: `path missing: ${localPath}` }, { status: 400 });

  // Use `open <path>` on macOS, `xdg-open` on Linux, `explorer` on Windows.
  const cmd =
    process.platform === "darwin"
      ? ["open", [localPath]]
      : process.platform === "win32"
        ? ["explorer", [localPath]]
        : ["xdg-open", [localPath]];

  return new Promise<Response>((resolve) => {
    const child = spawn(cmd[0] as string, cmd[1] as string[], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("close", (code) => {
      if (code === 0) resolve(NextResponse.json({ ok: true, path: localPath }));
      else resolve(NextResponse.json({ ok: false, error: `${cmd[0]} exited ${code}: ${err.trim()}` }, { status: 500 }));
    });
  });
}
