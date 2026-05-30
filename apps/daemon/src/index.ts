#!/usr/bin/env node
import "dotenv/config";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "@open-assistant/mcp-server";
import { AgentRunner, AgentQueue } from "@open-assistant/agent";
import { Assistant } from "@open-assistant/core";
import { MemoryStore } from "@open-assistant/memory";

const HOST = process.env.OA_DAEMON_HOST ?? "127.0.0.1";
const PORT = Number(process.env.OA_DAEMON_PORT ?? 7338);

async function main() {
  // Shared singletons — one memory store, one assistant config, one queue
  // for the whole daemon. Per HTTP session we still build a fresh McpServer
  // because the SDK enforces one transport per server instance.
  const memory = new MemoryStore();
  const assistant = new Assistant({ memory });
  const queue = new AgentQueue();

  // Touch the store so we fail fast if FalkorDB isn't reachable.
  try {
    await memory.ping();
  } catch (err) {
    console.error("[daemon] failed to reach FalkorDB:", err);
    process.exit(1);
  }

  // Background agent worker.
  const runner = new AgentRunner({ queue, memory });
  runner.start().catch((err) => console.error("[agent worker]", err));

  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    // Health endpoint.
    if (req.method === "GET" && url.pathname === "/health") {
      let memUp = false;
      try {
        await memory.ping();
        memUp = true;
      } catch {
        memUp = false;
      }
      res.writeHead(memUp ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: memUp ? "ok" : "degraded", memory: memUp, agent: true }));
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    const sessionHeader = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;

    if (req.method === "POST") {
      const body = await readJson(req);
      let transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) {
        if (!isInitializeRequest(body)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "no session; send initialize first" }));
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport!);
          },
        });
        transport.onclose = () => {
          const sid = transport!.sessionId;
          if (sid) transports.delete(sid);
        };
        // Fresh McpServer per session — sharing memory/assistant/queue.
        const { server } = buildServer({ memory, assistant, queue });
        await server.connect(transport);
      }
      await transport.handleRequest(req, res, body);
      return;
    }

    if ((req.method === "GET" || req.method === "DELETE") && sessionId) {
      const transport = transports.get(sessionId);
      if (!transport) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("unknown session");
        return;
      }
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(405, { "content-type": "text/plain" });
    res.end("method not allowed");
  });

  httpServer.listen(PORT, HOST, () => {
    console.log(
      `[daemon] open-assistant listening on http://${HOST}:${PORT} (mcp: /mcp, health: /health)`,
    );
    console.log(
      `[daemon] llm provider: ${assistant.provider.name}; agent worker: started`,
    );
  });

  const shutdown = async (signal: string) => {
    console.log(`[daemon] received ${signal}, shutting down`);
    runner.stop();
    httpServer.close();
    await memory.close();
    await queue.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

main().catch((err) => {
  console.error("[daemon] fatal:", err);
  process.exit(1);
});
