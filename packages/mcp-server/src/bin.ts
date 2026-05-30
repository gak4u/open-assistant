#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";

async function main() {
  const { server } = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stdio: keep the process alive while the transport runs.
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[open-assistant-mcp] fatal:", err);
  process.exit(1);
});
