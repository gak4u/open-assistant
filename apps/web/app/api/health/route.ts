import { NextResponse } from "next/server";
import { memory } from "@/lib/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const m = memory();
    await m.ping();
    const stats = await m.stats();
    return NextResponse.json({ daemon: true, stats });
  } catch (err) {
    return NextResponse.json(
      { daemon: false, error: err instanceof Error ? err.message : String(err) },
      { status: 503 },
    );
  }
}
