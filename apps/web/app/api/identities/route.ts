import { NextResponse } from "next/server";
import { MemoryStore, getIdentities } from "@open-assistant/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let cached: MemoryStore | null = null;
function memory(): MemoryStore {
  cached ??= new MemoryStore();
  return cached;
}

export async function GET() {
  try {
    const identities = await getIdentities(memory());
    return NextResponse.json(identities);
  } catch (err) {
    return NextResponse.json(
      { user: null, assistant: null, error: err instanceof Error ? err.message : String(err) },
      { status: 503 },
    );
  }
}
