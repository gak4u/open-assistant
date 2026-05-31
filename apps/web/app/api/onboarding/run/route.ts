import { runOnboarding, saveConfig } from "@open-assistant/core";
import { memory } from "@/lib/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();
function sseEvent(name: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function POST() {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const evt of runOnboarding(memory())) {
          controller.enqueue(sseEvent(evt.type, evt));
          if (evt.type === "done" && evt.summary) {
            // Persist completion + summary into the config file.
            saveConfig({
              onboarding: {
                completed: true,
                lastRunAt: Date.now(),
                lastSummary: {
                  sessionsFound: evt.summary.sessionsFound,
                  reposFound: evt.summary.reposFound,
                  projectsCreated: evt.summary.projectsCreated,
                  entitiesCreated: evt.summary.entitiesCreated,
                  relationsCreated: evt.summary.relationsCreated,
                },
              },
            });
          }
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
