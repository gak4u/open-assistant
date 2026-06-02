# open-assistant

The missing memory layer for Claude Code developers — persistent graph memory, session continuity, and project awareness, built for developers who live in the terminal.

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

## How it compares

|                       | open-assistant                              | OpenClaw                  | Hermes Agent             |
| --------------------- | ------------------------------------------- | ------------------------- | ------------------------ |
| **Primary focus**     | Claude Code session management              | Gateway / messaging       | Self-improving loop      |
| **Memory**            | FalkorDB graph (entities + relations)       | Session-level, flat       | SQLite FTS5              |
| **Audience**          | Dev teams using Claude Code                 | Non-developers            | Developers / researchers |
| **Channels**          | Web UI + MCP + CLI                          | 25+ messaging platforms   | 6 platforms              |
| **Project awareness** | First-class (onboarding + project graph)    | None                      | Limited                  |
| **Model support**     | Pluggable (Claude / Ollama / OpenAI-compat) | Provider-agnostic         | 200+ via OpenRouter      |
| **Unique angle**      | Session continuity + tmux                   | Breadth                   | Self-improving skills    |

If you use Claude Code daily and are tired of losing session context, re-explaining your projects, and restarting from scratch — open-assistant is built for you.

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
| `ask`               | `question`, optional `session_id`                       | Memory-augmented Q&A; persists the turn                    |
| `remember`          | `name`, `type`, optional `description`, `related_to`    | Upsert an entity (and optional edge)                       |
| `forget`            | `id` or `name`+`type`                                   | Delete an entity and its relations                         |
| `search_memory`     | `query`, `limit`, `include_neighbours`                  | Full-text search the entity graph                          |
| `run_agent`         | `task`, optional `wait`                                 | Queue (or inline-run) a remote sub-agent                   |
| `agent_status`      | `id`                                                    | Look up a queued / completed agent task                    |
| `run_onboarding`    | optional `lightweight`                                  | Scan Claude Code sessions + repos and seed the memory graph |
| `onboarding_status` | (none)                                                  | Current state + last summary                               |

Resources:

| URI                    | Type               | What it is                                                 |
| ---------------------- | ------------------ | ---------------------------------------------------------- |
| `onboarding://status`  | `application/json` | Live onboarding state — `never_run` / `in_progress` / `completed` plus the last summary. Clients like Claude Desktop can surface this without a tool call. |

### Triggering onboarding from an MCP client

From Claude Desktop, Claude Code, or any other MCP client connected to
open-assistant, just call the tool:

> Run the `run_onboarding` tool to scan your Claude Code sessions and build
> your memory graph.

The tool streams its progress as text and returns a final summary
(projects / sessions / repos / entities / relations). Pass `lightweight: true`
to skip the filesystem repo discovery if you only want session-derived
projects — fast first impression with no `~/Projects` walk.

**First-connect auto-run.** The very first time *any* MCP client connects
and `~/.open-assistant/config.json` has `onboarding.completed: false`, the
server kicks off a lightweight onboarding in the background and emits a
logging-message notification when it finishes. The full sweep (repo
discovery in `~/Projects`, `~/Personal`, `~/Work`, …) stays manual — call
`run_onboarding` (no args) or use the **Settings → Memory → Run onboarding**
button in the web UI.

To check whether onboarding has ever run, either:

- call the `onboarding_status` tool, or
- read the `onboarding://status` resource (same payload, JSON).

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
