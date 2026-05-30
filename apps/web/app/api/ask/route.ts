import { NextRequest, NextResponse } from "next/server";
import { Assistant } from "@open-assistant/core";
import { MemoryStore } from "@open-assistant/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let cachedMemory: MemoryStore | null = null;
function memory(): MemoryStore {
  cachedMemory ??= new MemoryStore();
  return cachedMemory;
}

export async function POST(req: NextRequest) {
  const { question, session_id } = (await req.json()) as { question?: string; session_id?: string };
  if (!question?.trim()) {
    return NextResponse.json({ error: "missing question" }, { status: 400 });
  }
  const assistant = new Assistant({ memory: memory(), sessionId: session_id });
  try {
    const result = await assistant.ask(question);
    return NextResponse.json({
      reply: result.reply,
      sessionId: result.sessionId,
      memoryUsed: { entities: result.memoryUsed.entities.map((e) => ({ id: e.id, name: e.name })) },
      model: result.model,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
