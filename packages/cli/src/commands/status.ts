import { Command } from "commander";
import kleur from "kleur";
import { MemoryStore } from "@open-assistant/memory";

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show daemon + memory status")
    .action(async () => {
      const memory = new MemoryStore();
      const daemonUrl =
        `http://${process.env.OA_DAEMON_HOST ?? "127.0.0.1"}:${process.env.OA_DAEMON_PORT ?? 7338}/health`;
      let daemonHealth: string;
      try {
        const r = await fetch(daemonUrl, { signal: AbortSignal.timeout(1500) });
        daemonHealth = r.ok ? kleur.green("up") : kleur.red(`http ${r.status}`);
      } catch {
        daemonHealth = kleur.red("down");
      }
      let memHealth: string;
      let stats: { entities: number; relations: number; turns: number } | null = null;
      try {
        await memory.ping();
        memHealth = kleur.green("up");
        stats = await memory.stats();
      } catch (err) {
        memHealth = kleur.red(`down (${err instanceof Error ? err.message : String(err)})`);
      }
      console.log(`${kleur.bold("daemon")}    ${daemonHealth} ${kleur.gray(daemonUrl)}`);
      console.log(`${kleur.bold("falkordb")}  ${memHealth}`);
      if (stats) {
        console.log(
          `${kleur.bold("memory")}    ${stats.entities} entities · ${stats.relations} relations · ${stats.turns} turns`,
        );
      }
      await memory.close();
    });
}
