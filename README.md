# open-assistant

A **self-hostable, privacy-first AI assistant daemon** with persistent graph memory, a remote
agent runner, and a built-in MCP server. Talk to it from the CLI, the web UI, or any MCP client
(Claude Desktop, Claude Code, Cursor, …) — and it remembers what you tell it across sessions.

- **Persistent memory** via FalkorDB (Redis-compatible graph DB). Every turn is stored as a node;
  entities and relations are extracted and linked into a queryable graph.
- **Pluggable LLM backend.** Defaults to Anthropic Claude; falls back to Ollama if no API key is
  set, so you can run end-to-end locally.
- **MCP server.** Exposes `ask`, `remember`, `forget`, `search_memory`, `run_agent` over either
  stdio or Streamable HTTP — drop it into any MCP-aware client.
- **Remote agents.** Long-running tasks are queued and executed by a sub-agent (Claude Code CLI if
  installed, otherwise direct API). Results flow back into the graph.
- **Daemon.** Always-on process with a `/health` endpoint, ready for `launchd` (Mac) or
  `systemd` (Linux).

---

## Architecture

```
                  ┌────────────────────────────────────────────────────┐
                  │                  open-assistant                    │
                  │                                                    │
   MCP clients ─► │  ┌──────────────┐    ┌──────────────────────────┐  │
   (Claude Desk-  │  │ mcp-server   │◄──►│ core (Assistant)         │  │
   top, Claude    │  │ stdio + HTTP │    │  ├─ LLM provider         │  │
   Code, …)       │  └──────────────┘    │  │   ├─ Anthropic        │  │
                  │         ▲             │  │   └─ Ollama (local)  │  │
   CLI (oa) ─────►│         │             │  └─ memory-augmented    │  │
                  │  ┌──────┴───────┐    │     chat loop           │  │
   web UI ───────►│  │ daemon       │────►└──────────────────────────┘  │
   (Next.js)      │  │ HTTP :7338   │              │     ▲              │
                  │  └──────────────┘              ▼     │              │
                  │                       ┌──────────────────────────┐  │
                  │                       │ memory                   │  │
                  │                       │  ├─ graph schema         │  │
                  │                       │  │  (Entity/REL/Turn)    │  │
                  │                       │  ├─ entity extractor     │  │
                  │                       │  │  (LLM)                │  │
                  │                       │  └─ subgraph retrieval   │  │
                  │                       └─────────────┬────────────┘  │
                  │                                     │               │
                  │                       ┌─────────────▼────────────┐  │
                  │                       │ FalkorDB (Redis)         │  │
                  │                       │ - graph: open_assistant  │  │
                  │                       │ - lists: oa:agent:queue  │  │
                  │                       └──────────────────────────┘  │
                  │                                     ▲               │
                  │  ┌──────────────┐                   │               │
                  │  │ agent        │ enqueue / consume │               │
                  │  │  ├─ queue    │───────────────────┘               │
                  │  │  └─ runner   │ → claude CLI or Anthropic direct  │
                  │  └──────────────┘                                   │
                  └────────────────────────────────────────────────────┘
```

---

## Layout

```
open-assistant/
  packages/
    memory/        FalkorDB client + graph schema + LLM entity extraction
    core/          Assistant orchestrator + LLM provider abstraction
    mcp-server/    MCP server exposing ask/remember/forget/search/run_agent
    agent/         Remote agent runner + Redis-backed task queue
    cli/           `oa` CLI (chat / ask / memory / agent / status)
  apps/
    daemon/        Always-on HTTP + MCP server (launchd / systemd templates)
    web/           Next.js dark-theme chat UI
```

---

## Quick start

### 1. Start FalkorDB

```sh
docker compose up -d
# or:
docker run -p 6379:6379 -p 3000:3000 falkordb/falkordb:latest
```

The web UI for the graph is at <http://localhost:3000>.

### 2. Configure

```sh
cp .env.example .env
# set ANTHROPIC_API_KEY (or run Ollama locally for fully-offline use)
```

### 3. Install + build

```sh
pnpm install
pnpm build
```

### 4. Use it

```sh
# Single-shot:
pnpm cli ask "remind me what I told you about the indigo project"

# Interactive:
pnpm cli chat

# Browse memory:
pnpm cli memory list
pnpm cli memory search "indigo"
pnpm cli memory neighbours project:indigo

# Dispatch a remote agent:
pnpm cli agent run "summarise today's commits in ~/Personal/foo"

# Daemon (HTTP + MCP + background agent worker):
pnpm dev               # apps/daemon dev mode
# health: curl http://127.0.0.1:7338/health
```

---

## Connecting an MCP client

### Claude Desktop / Claude Code (stdio)

`~/.config/claude/claude_desktop_config.json` (or Claude Code's settings):

```json
{
  "mcpServers": {
    "open-assistant": {
      "command": "node",
      "args": ["/path/to/open-assistant/packages/mcp-server/dist/bin.js"]
    }
  }
}
```

### HTTP (Streamable transport)

Point any MCP-over-HTTP client at:

```
http://127.0.0.1:7338/mcp
```

Tools advertised:

| Tool            | Input                                       | What it does                                   |
| --------------- | ------------------------------------------- | ---------------------------------------------- |
| `ask`           | `question`, optional `session_id`           | Memory-augmented Q&A; persists the turn        |
| `remember`      | `name`, `type`, optional `description`, `related_to` | Upsert an entity (and optional edge)  |
| `forget`        | `id` or `name`+`type`                       | Delete an entity and its relations             |
| `search_memory` | `query`, `limit`, `include_neighbours`      | Full-text search the entity graph              |
| `run_agent`     | `task`, optional `wait`                     | Queue (or inline-run) a remote sub-agent       |
| `agent_status`  | `id`                                        | Look up a queued / completed agent task        |

---

## Daemon as a service

### macOS (launchd)

```sh
sudo mkdir -p /usr/local/lib/open-assistant
sudo cp -R . /usr/local/lib/open-assistant
sudo cp apps/daemon/launchd/com.open-assistant.daemon.plist \
  /Library/LaunchDaemons/
sudo launchctl load /Library/LaunchDaemons/com.open-assistant.daemon.plist
```

### Linux (systemd)

```sh
sudo cp -R . /opt/open-assistant
sudo cp apps/daemon/systemd/open-assistant.service /etc/systemd/system/
sudo cp .env /etc/open-assistant.env
sudo systemctl enable --now open-assistant
```

---

## Graph schema

Entities (`(:Entity)`) carry `id`, `type`, `name`, `description`, and arbitrary `attr_*` props.
Relations are stored as `(:Entity)-[:REL { type, weight, context }]->(:Entity)` so any pair of
labels can connect. Conversation turns are `(:Turn)` nodes linked to entities via
`(:Turn)-[:MENTIONS]->(:Entity)`.

Supported types out of the box:

- **Entities:** `person`, `place`, `project`, `event`, `organization`, `fact`, `topic`, `artifact`
- **Relations:** `worked_on`, `mentioned`, `related_to`, `happened_at`, `located_in`, `knows`,
  `owns`, `part_of`, `depends_on`, `produced`

Want more? They're plain string types — extend `packages/memory/src/schema.ts`.

---

## Configuration reference

All config lives in `.env` (loaded by `dotenv` at the CLI / daemon entry points):

| Variable             | Default                          | Purpose                              |
| -------------------- | -------------------------------- | ------------------------------------ |
| `ANTHROPIC_API_KEY`  | —                                | Required for the Anthropic backend   |
| `OA_MODEL`           | `claude-sonnet-4-20250514`       | Default Claude model                 |
| `OA_MAX_TOKENS`      | `4096`                           | Default completion ceiling           |
| `OLLAMA_BASE_URL`    | `http://127.0.0.1:11434`         | Local Ollama endpoint                |
| `OLLAMA_MODEL`       | `llama3.2`                       | Local fallback model                 |
| `FALKORDB_HOST`      | `127.0.0.1`                      | FalkorDB host                        |
| `FALKORDB_PORT`      | `6379`                           | FalkorDB port                        |
| `FALKORDB_PASSWORD`  | —                                | Optional auth                        |
| `FALKORDB_GRAPH`     | `open_assistant`                 | Graph name                           |
| `OA_DAEMON_HOST`     | `127.0.0.1`                      | Daemon bind address                  |
| `OA_DAEMON_PORT`     | `7338`                           | Daemon HTTP port                     |
| `OA_AGENT_WORKDIR`   | `/tmp/open-assistant-agents`     | Scratch dir for spawned sub-agents   |

---

## Privacy posture

- Everything runs locally by default; FalkorDB lives in `docker compose` on your machine.
- No telemetry. No remote calls beyond the LLM provider you configure.
- Pick Ollama as your provider for a fully air-gapped deployment.

---

## License

MIT — see [LICENSE](./LICENSE).
