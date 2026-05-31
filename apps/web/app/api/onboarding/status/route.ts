import { NextResponse } from "next/server";
import { currentConfig } from "@open-assistant/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const cfg = currentConfig();
  return NextResponse.json({
    completed: cfg.onboarding.completed,
    lastRunAt: cfg.onboarding.lastRunAt,
    lastSummary: cfg.onboarding.lastSummary,
  });
}
