#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { registerAsk } from "./commands/ask.js";
import { registerChat } from "./commands/chat.js";
import { registerMemory } from "./commands/memory.js";
import { registerAgent } from "./commands/agent.js";
import { registerStatus } from "./commands/status.js";

const program = new Command();

program
  .name("oa")
  .description("open-assistant — self-hostable, privacy-first AI assistant")
  .version("0.1.0");

registerAsk(program);
registerChat(program);
registerMemory(program);
registerAgent(program);
registerStatus(program);

program.parseAsync(process.argv).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err?.message ?? err);
  process.exit(1);
});
