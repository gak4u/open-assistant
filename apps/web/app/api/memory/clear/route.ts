import { NextResponse } from "next/server";
import { memory } from "@/lib/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const deleted = await memory().clearGraph();
    return NextResponse.json({ ok: true, deleted });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
