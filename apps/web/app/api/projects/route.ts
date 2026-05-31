import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import { memory } from "@/lib/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface ProjectDTO {
  id: string;
  name: string;
  description: string;
  localPath: string | null;
  sessionId: string | null;
  sessionCount: number;
  messageCount: number;
  lastActiveMs: number;
  lastPrompt: string;
  markers: string[];
  hasRepo: boolean;
  pathExists: boolean;
  status: "active" | "archived";
}

export async function GET() {
  try {
    const entities = await memory().listEntities({ type: "project", limit: 500 });
    const projects: ProjectDTO[] = entities.map((e) => {
      const a = e.attributes ?? {};
      const localPath = typeof a["local_path"] === "string" ? a["local_path"] : null;
      const sessionId = typeof a["session_id"] === "string" ? a["session_id"] : null;
      const pathExists = localPath ? safeExists(localPath) : false;
      const lastActiveMs = typeof a["last_active_ms"] === "number" ? (a["last_active_ms"] as number) : 0;
      // "active" per spec = the project's local path still exists on disk AND
      // at least one Claude Code session has touched it. "archived" = either
      // path went away or there's no session for it.
      const sessionCount = numAttr(a, "session_count");
      const isActive = pathExists && sessionCount > 0;
      return {
        id: e.id,
        name: e.name,
        description: e.description ?? "",
        localPath,
        sessionId,
        sessionCount,
        messageCount: numAttr(a, "message_count"),
        lastActiveMs,
        lastPrompt: typeof a["last_prompt"] === "string" ? a["last_prompt"] : "",
        markers: typeof a["markers"] === "string" ? a["markers"].split(",").filter(Boolean) : [],
        hasRepo: a["has_repo"] === true || a["has_repo"] === "true",
        pathExists,
        status: isActive ? "active" : "archived",
      };
    });
    projects.sort((a, b) => b.lastActiveMs - a.lastActiveMs || a.name.localeCompare(b.name));
    return NextResponse.json({ projects });
  } catch (err) {
    return NextResponse.json(
      { projects: [], error: err instanceof Error ? err.message : String(err) },
      { status: 503 },
    );
  }
}

function numAttr(a: Record<string, unknown>, k: string): number {
  const v = a[k];
  return typeof v === "number" ? v : Number(v ?? 0) || 0;
}

function safeExists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}
