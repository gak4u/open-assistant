import { Command } from "commander";
import kleur from "kleur";
import { EntityTypes, MemoryStore, entityId } from "@open-assistant/memory";

export function registerMemory(program: Command): void {
  const cmd = program.command("memory").description("Inspect and manage the graph memory");

  cmd
    .command("list")
    .description("List recent entities")
    .option("--type <type>", `filter by type (${EntityTypes.join("|")})`)
    .option("--limit <n>", "max rows", "25")
    .action(async (opts: { type?: string; limit?: string }) => {
      const memory = new MemoryStore();
      try {
        const limit = Number(opts.limit ?? 25);
        const type = opts.type as (typeof EntityTypes)[number] | undefined;
        if (type && !EntityTypes.includes(type)) {
          console.error(`invalid type. valid: ${EntityTypes.join(", ")}`);
          process.exit(1);
        }
        const rows = await memory.listEntities({ type, limit });
        if (!rows.length) {
          console.log(kleur.gray("(no entities)"));
          return;
        }
        for (const e of rows) {
          console.log(
            `${kleur.cyan(`(${e.type})`)} ${kleur.bold(e.name)} ${kleur.gray(e.id)}` +
              (e.description ? `\n  ${kleur.gray(e.description)}` : ""),
          );
        }
      } finally {
        await memory.close();
      }
    });

  cmd
    .command("search")
    .description("Search the memory graph")
    .argument("<query...>")
    .option("--limit <n>", "max rows", "10")
    .action(async (parts: string[], opts: { limit?: string }) => {
      const query = parts.join(" ");
      const memory = new MemoryStore();
      try {
        const hits = await memory.searchEntities(query, Number(opts.limit ?? 10));
        if (!hits.length) {
          console.log(kleur.gray("(no matches)"));
          return;
        }
        for (const h of hits) {
          console.log(
            `${kleur.cyan(`(${h.entity.type})`)} ${kleur.bold(h.entity.name)} ` +
              kleur.gray(`score=${h.score.toFixed(2)} ${h.entity.id}`) +
              (h.entity.description ? `\n  ${kleur.gray(h.entity.description)}` : ""),
          );
        }
      } finally {
        await memory.close();
      }
    });

  cmd
    .command("forget")
    .description("Delete an entity by id or name+type")
    .argument("<target>", "either an entity id or a name (use --type with a name)")
    .option("--type <type>", "type when passing a name")
    .action(async (target: string, opts: { type?: string }) => {
      const memory = new MemoryStore();
      try {
        const id = target.includes(":")
          ? target
          : opts.type
            ? entityId(opts.type as (typeof EntityTypes)[number], target)
            : null;
        if (!id) {
          console.error("provide a full entity id (type:slug) or pass --type with a name");
          process.exit(1);
        }
        const ok = await memory.forgetEntity(id);
        console.log(ok ? kleur.green(`forgot ${id}`) : kleur.yellow(`no entity ${id}`));
      } finally {
        await memory.close();
      }
    });

  cmd
    .command("neighbours")
    .description("Show the 1-hop neighbourhood of an entity")
    .argument("<id>")
    .action(async (id: string) => {
      const memory = new MemoryStore();
      try {
        const sub = await memory.neighbors(id, 1);
        if (!sub.entities.length) {
          console.log(kleur.gray("(no entity / no neighbours)"));
          return;
        }
        console.log(kleur.bold("entities"));
        for (const e of sub.entities) {
          console.log(`  ${kleur.cyan(`(${e.type})`)} ${e.name} ${kleur.gray(e.id)}`);
        }
        if (sub.relations.length) {
          console.log("\n" + kleur.bold("relations"));
          for (const r of sub.relations) {
            console.log(`  ${r.from} ${kleur.magenta(`—[${r.type}]→`)} ${r.to}`);
          }
        }
      } finally {
        await memory.close();
      }
    });
}
