import { NextRequest } from "next/server";
import { Assistant } from "@open-assistant/core";
import { memory } from "@/lib/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();
function sseEvent(name: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function POST(req: NextRequest) {
  const { question, session_id } = (await req.json()) as { question?: string; session_id?: string };
  if (!question?.trim()) {
    return new Response(JSON.stringify({ error: "missing question" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const assistant = new Assistant({ memory: memory(), sessionId: session_id });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const evt of assistant.askStream(question)) {
          controller.enqueue(sseEvent(evt.type, evt));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        controller.enqueue(sseEvent("error", { type: "error", error: msg }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
