import { NextRequest, NextResponse } from "next/server";
import { applyIdentityUpdate, getIdentities } from "@open-assistant/memory";
import { memory } from "@/lib/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { user?: string | null; assistant?: string | null };
  const update: { user?: string; assistant?: string } = {};
  if (typeof body.user === "string" && body.user.trim()) update.user = body.user.trim();
  if (typeof body.assistant === "string" && body.assistant.trim()) update.assistant = body.assistant.trim();
  try {
    const identities = await applyIdentityUpdate(memory(), update);
    return NextResponse.json(identities);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
