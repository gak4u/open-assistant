import { NextResponse } from "next/server";
import { detectStatus } from "@open-assistant/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(detectStatus());
}
