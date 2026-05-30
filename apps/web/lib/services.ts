import { MemoryStore } from "@open-assistant/memory";
import { currentConfig, onConfigChange, startWatching, type MemoryConfig } from "@open-assistant/core";

// Start watching the config file once — subsequent imports reuse this.
startWatching();

let cached: MemoryStore | null = null;
let stamp = "";

function memoryStamp(cfg: MemoryConfig): string {
  return `${cfg.falkordbHost}|${cfg.falkordbPort}|${cfg.falkordbGraph}|${cfg.falkordbPassword}`;
}

function build(cfg: MemoryConfig): MemoryStore {
  return new MemoryStore({
    host: cfg.falkordbHost,
    port: cfg.falkordbPort,
    graph: cfg.falkordbGraph,
    password: cfg.falkordbPassword || undefined,
  });
}

onConfigChange((cfg) => {
  const next = memoryStamp(cfg.memory);
  if (next !== stamp) {
    cached?.close().catch(() => undefined);
    cached = null;
    stamp = next;
  }
});

export function memory(): MemoryStore {
  const cfg = currentConfig();
  const next = memoryStamp(cfg.memory);
  if (!cached || next !== stamp) {
    cached?.close().catch(() => undefined);
    cached = build(cfg.memory);
    stamp = next;
  }
  return cached;
}
