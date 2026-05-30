import { Command } from "commander";
import kleur from "kleur";
import { Assistant } from "@open-assistant/core";

export function registerAsk(program: Command): void {
  program
    .command("ask")
    .description("Ask a single question and print the answer")
    .argument("<question...>", "the question to ask")
    .option("--session <id>", "session ID to continue")
    .option("--no-ingest", "skip entity extraction (faster, no memory writes)")
    .action(async (parts: string[], opts: { session?: string; ingest?: boolean }) => {
      const question = parts.join(" ").trim();
      if (!question) {
        console.error("usage: oa ask <question>");
        process.exit(1);
      }
      const assistant = new Assistant({ sessionId: opts.session, ingest: opts.ingest !== false });
      try {
        const result = await assistant.ask(question);
        console.log(result.reply);
        if (process.stdout.isTTY) {
          console.log(
            kleur.gray(
              `\n— session ${result.sessionId} · ${result.memoryUsed.entities.length} memory entities · ${result.model}`,
            ),
          );
        }
      } finally {
        await assistant.memory.close();
      }
    });
}
