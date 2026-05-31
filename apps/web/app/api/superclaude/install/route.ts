import { NextResponse } from "next/server";
import { install } from "@open-assistant/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const result = install();
  if (result.error && !result.installed) {
    return NextResponse.json(result, { status: 500 });
  }
  return NextResponse.json(result);
}
