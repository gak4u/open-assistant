import { Command } from "commander";
import kleur from "kleur";
import readline from "node:readline";
import { Assistant } from "@open-assistant/core";

export function registerChat(program: Command): void {
  program
    .command("chat")
    .description("Start an interactive chat session with persistent memory")
    .option("--session <id>", "resume a specific session")
    .option("--no-ingest", "skip entity extraction during the chat")
    .action(async (opts: { session?: string; ingest?: boolean }) => {
      const assistant = new Assistant({ sessionId: opts.session, ingest: opts.ingest !== false });
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

      console.log(kleur.bold().cyan("open-assistant") + kleur.gray(`  (session ${assistant.sessionId})`));
      console.log(kleur.gray("Type your message. Ctrl+C or /quit to exit.\n"));

      const prompt = () => rl.question(kleur.green("you ") + "› ", handle);

      const handle = async (line: string) => {
        const text = line.trim();
        if (!text) return prompt();
        if (text === "/quit" || text === "/exit") {
          rl.close();
          return;
        }
        try {
          const result = await assistant.ask(text);
          console.log("\n" + kleur.magenta("assistant") + " › " + result.reply + "\n");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(kleur.red(`error: ${msg}\n`));
        }
        prompt();
      };

      rl.on("close", async () => {
        await assistant.memory.close();
        console.log(kleur.gray("\nbye"));
        process.exit(0);
      });
      prompt();
    });
}
