import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { existsSync } from "node:fs";
import { configPath, currentConfig, redactedConfig, saveConfig } from "@open-assistant/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function mcpBinPath(): string {
  // Walk up from this file until we find the workspace root (the package.json
  // that has "name": "open-assistant"), then point at the built mcp-server bin.
  const here = process.cwd();
  let dir = here;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "packages", "mcp-server", "dist", "bin.js");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback to a relative reference if we can't locate it.
  return path.join(here, "packages", "mcp-server", "dist", "bin.js");
}

export async function GET() {
  const cfg = redactedConfig(currentConfig());
  return NextResponse.json({
    config: cfg,
    path: configPath(),
    mcpBinPath: mcpBinPath(),
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as Record<string, unknown>;
  try {
    const saved = saveConfig(body as never);
    return NextResponse.json({
      config: redactedConfig(saved),
      path: configPath(),
      mcpBinPath: mcpBinPath(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
