import { NextResponse } from "next/server";
import { dropProjectSession, killSession, loadRegistry } from "@open-assistant/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const reg = loadRegistry();
  const entry = reg.projects[id];
  if (!entry) {
    return NextResponse.json({ ok: false, error: "no live session for this project" }, { status: 404 });
  }
  const killed = killSession(entry.tmux);
  // Drop the registry entry either way — if tmux was already gone we still
  // want to clean up our state.
  dropProjectSession(id);
  return NextResponse.json({ ok: true, killed, tmuxName: entry.tmux });
}
