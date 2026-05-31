import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import { liveTmuxSnapshot, projectRuntime, type ProjectRuntimeStatus } from "@open-assistant/core";
import { memory } from "@/lib/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type ProjectStatus = "running" | "paused" | "active" | "archived";

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
  status: ProjectStatus;
  tmux: {
    name: string | null;
    runtime: ProjectRuntimeStatus;
    attached: boolean;
    lastResumedAt: number;
    attachCommand: string | null;
  };
}

export async function GET() {
  try {
    const entities = await memory().listEntities({ type: "project", limit: 500 });
    const live = liveTmuxSnapshot();
    const projects: ProjectDTO[] = entities.map((e) => {
      const a = e.attributes ?? {};
      const localPath = typeof a["local_path"] === "string" ? a["local_path"] : null;
      const sessionId = typeof a["session_id"] === "string" ? a["session_id"] : null;
      const pathExists = localPath ? safeExists(localPath) : false;
      const lastActiveMs = typeof a["last_active_ms"] === "number" ? (a["last_active_ms"] as number) : 0;
      const sessionCount = numAttr(a, "session_count");
      const runtime = projectRuntime(e.id, live);
      // Status priority: a live tmux session always wins, then "paused" if we
      // know about a tmux name but it's gone, then "active" (knows a session
      // and path exists), else "archived".
      let status: ProjectStatus;
      if (runtime.status === "running") status = "running";
      else if (runtime.status === "paused") status = "paused";
      else if (pathExists && sessionCount > 0) status = "active";
      else status = "archived";

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
        status,
        tmux: {
          name: runtime.tmuxName,
          runtime: runtime.status,
          attached: runtime.tmuxAttached,
          lastResumedAt: runtime.lastResumedAt,
          attachCommand: runtime.tmuxName ? `tmux attach -t ${runtime.tmuxName}` : null,
        },
      };
    });
    // Running first, then by last activity.
    const statusOrder: Record<ProjectStatus, number> = { running: 0, paused: 1, active: 2, archived: 3 };
    projects.sort(
      (a, b) =>
        statusOrder[a.status] - statusOrder[b.status] ||
        b.lastActiveMs - a.lastActiveMs ||
        a.name.localeCompare(b.name),
    );
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
