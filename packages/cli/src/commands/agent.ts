import { Command } from "commander";
import kleur from "kleur";
import { AgentQueue, AgentRunner } from "@open-assistant/agent";

export function registerAgent(program: Command): void {
  const cmd = program.command("agent").description("Dispatch and inspect remote agent tasks");

  cmd
    .command("run")
    .description("Queue an agent task (or run inline with --wait)")
    .argument("<task...>")
    .option("--wait", "execute synchronously instead of queueing")
    .option("--workdir <path>", "explicit working directory")
    .action(async (parts: string[], opts: { wait?: boolean; workdir?: string }) => {
      const task = parts.join(" ");
      const queue = new AgentQueue();
      try {
        const enqueued = await queue.enqueue(task, { workdir: opts.workdir });
        console.log(kleur.gray(`queued ${enqueued.id}`));
        if (opts.wait) {
          const runner = new AgentRunner({ queue });
          const result = await runner.runTask(enqueued);
          console.log("\n" + result.output);
        }
      } finally {
        await queue.close();
      }
    });

  cmd
    .command("status")
    .description("Show a queued / running / completed task")
    .argument("<id>")
    .action(async (id: string) => {
      const queue = new AgentQueue();
      try {
        const task = await queue.get(id);
        if (!task) {
          console.error(`no task ${id}`);
          process.exit(1);
        }
        console.log(JSON.stringify(task, null, 2));
      } finally {
        await queue.close();
      }
    });

  cmd
    .command("list")
    .description("List recent agent tasks")
    .option("--limit <n>", "max rows", "25")
    .action(async (opts: { limit?: string }) => {
      const queue = new AgentQueue();
      try {
        const tasks = await queue.list(Number(opts.limit ?? 25));
        if (!tasks.length) {
          console.log(kleur.gray("(no tasks)"));
          return;
        }
        for (const t of tasks) {
          const colour =
            t.status === "done"
              ? kleur.green
              : t.status === "failed"
                ? kleur.red
                : t.status === "running"
                  ? kleur.yellow
                  : kleur.gray;
          console.log(
            `${colour(t.status.padEnd(7))} ${t.id} ${kleur.gray(new Date(t.createdAt).toISOString())}\n  ${t.prompt.slice(0, 100)}`,
          );
        }
      } finally {
        await queue.close();
      }
    });

  cmd
    .command("worker")
    .description("Run a worker that drains the agent queue")
    .action(async () => {
      const runner = new AgentRunner();
      const stop = () => {
        console.log(kleur.gray("\nstopping…"));
        runner.stop();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      console.log(kleur.gray("worker started, ctrl+c to stop"));
      await runner.start();
      await runner.queue.close();
      await runner.memory.close();
    });
}
