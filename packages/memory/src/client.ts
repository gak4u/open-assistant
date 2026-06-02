import { Redis } from "ioredis";
import {
  type Entity,
  type EntityType,
  type Relation,
  type RelationType,
  type Turn,
  entityId,
} from "./schema.js";

export interface MemoryConfig {
  host?: string;
  port?: number;
  password?: string;
  graph?: string;
}

export interface MemorySearchHit {
  entity: Entity;
  score: number;
}

export interface SubgraphResult {
  entities: Entity[];
  relations: Relation[];
}

/**
 * FalkorDB graph client.
 *
 * FalkorDB is Redis-compatible — every graph operation is a single Redis
 * command (`GRAPH.QUERY <graph> <cypher>`). We use ioredis as the transport
 * and emit Cypher-style queries for FalkorDB to execute.
 */
export class MemoryStore {
  private readonly redis: Redis;
  private readonly graph: string;
  private initialized = false;

  constructor(config: MemoryConfig = {}) {
    this.redis = new Redis({
      host: config.host ?? process.env.FALKORDB_HOST ?? "127.0.0.1",
      port: Number(config.port ?? process.env.FALKORDB_PORT ?? 6379),
      password: config.password ?? process.env.FALKORDB_PASSWORD ?? undefined,
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    this.graph = config.graph ?? process.env.FALKORDB_GRAPH ?? "open_assistant";
  }

  async connect(): Promise<void> {
    if (this.redis.status === "ready" || this.redis.status === "connecting") return;
    await this.redis.connect();
  }

  async ping(): Promise<string> {
    await this.connect();
    return this.redis.ping();
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }

  /** Ensure indexes exist. Safe to call repeatedly. */
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.connect();
    // Range indexes via Cypher CREATE — works across FalkorDB versions.
    const rangeStmts = [
      "CREATE INDEX FOR (e:Entity) ON (e.id)",
      "CREATE INDEX FOR (e:Entity) ON (e.type)",
      "CREATE INDEX FOR (e:Entity) ON (e.name)",
      "CREATE INDEX FOR (t:Turn) ON (t.id)",
      "CREATE INDEX FOR (t:Turn) ON (t.session_id)",
    ];
    for (const s of rangeStmts) {
      try {
        await this.query(s);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/already.*indexed|already exists/i.test(msg)) {
          // eslint-disable-next-line no-console
          console.warn(`[memory] init warning: ${msg}`);
        }
      }
    }
    // Full-text index via FalkorDB's native procedure call — the Cypher
    // `CREATE FULLTEXT INDEX ... ON (...)` form is silently dropped on
    // older FalkorDB builds, leaving searchEntities returning nothing.
    // The procedure call form works back to 1.x.
    try {
      await this.query(
        "CALL db.idx.fulltext.createNodeIndex('Entity', 'name', 'description')",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/already.*indexed|already exists|attempt to create.*existing/i.test(msg)) {
        // eslint-disable-next-line no-console
        console.warn(`[memory] init warning (fulltext index): ${msg}`);
      }
    }
    this.initialized = true;
  }

  /**
   * Send a Cypher query to FalkorDB. Returns the raw parsed response.
   * For richer ergonomics use {@link queryRows}.
   */
  async query(cypher: string, params?: Record<string, unknown>, readOnly = false): Promise<unknown> {
    await this.connect();
    const cmd = readOnly ? "GRAPH.RO_QUERY" : "GRAPH.QUERY";
    const full = params ? `CYPHER ${formatParams(params)} ${cypher}` : cypher;
    // We use verbose mode (no --compact) so property keys come back as strings
    // rather than indices into a separate key table.
    return this.redis.call(cmd, this.graph, full);
  }

  /**
   * Run a query and return rows as objects keyed by RETURN alias.
   */
  async queryRows(
    cypher: string,
    params?: Record<string, unknown>,
    readOnly = false,
  ): Promise<Record<string, unknown>[]> {
    const raw = (await this.query(cypher, params, readOnly)) as unknown[];
    // FalkorDB verbose mode returns [header, rows, stats]
    //   header: ["col1", "col2"]
    //   rows: [[cell1, cell2], ...]
    // A node cell is [["id", N], ["labels", [...]], ["properties", [["k", v], ...]]]
    // An edge cell is [["id", N], ["type", "REL"], ["src_node", N], ["dest_node", N], ["properties", [...]]]
    if (!Array.isArray(raw) || raw.length < 2) return [];
    const header = raw[0];
    const rows = raw[1];
    if (!Array.isArray(header) || !Array.isArray(rows)) return [];
    return rows.map((row) => {
      const obj: Record<string, unknown> = {};
      header.forEach((name, i) => {
        if (typeof name !== "string") return;
        obj[name] = decodeValue((row as unknown[])[i]);
      });
      return obj;
    });
  }

  // -------- Entities --------

  async upsertEntity(entity: Omit<Entity, "id" | "created_at" | "updated_at"> & { id?: string }): Promise<Entity> {
    await this.init();
    const id = entity.id ?? entityId(entity.type, entity.name);
    const now = Date.now();

    // FalkorDB's CYPHER param parser handles scalars reliably across versions.
    // Build individual SET clauses to avoid relying on map-parameter support.
    const params: Record<string, unknown> = {
      id,
      type: entity.type,
      name: entity.name,
      now,
    };
    // ALWAYS-write fields: type and name come from required args; updated_at
    // is the freshness signal. Description is only touched when the caller
    // explicitly provided one — otherwise re-upserts (e.g. from a `remember`
    // call that just adds a relation) would silently wipe the existing text.
    const onCreate = ["e.type = $type", "e.name = $name", "e.updated_at = $now"];
    const onMatch = ["e.type = $type", "e.name = $name", "e.updated_at = $now"];
    if (entity.description !== undefined) {
      params["description"] = entity.description;
      onCreate.push("e.description = $description");
      onMatch.push("e.description = $description");
    } else {
      // On create only, seed an empty string so reads don't return undefined.
      onCreate.push("e.description = ''");
    }
    if (entity.attributes) {
      let i = 0;
      for (const [k, v] of Object.entries(entity.attributes)) {
        const safeKey = k.replace(/[^a-zA-Z0-9_]/g, "_");
        const paramName = `attr${i++}`;
        const clause = `e.attr_${safeKey} = $${paramName}`;
        onCreate.push(clause);
        onMatch.push(clause);
        params[paramName] = v;
      }
    }
    await this.query(
      `
      MERGE (e:Entity {id: $id})
      ON CREATE SET ${onCreate.join(", ")}, e.created_at = $now
      ON MATCH  SET ${onMatch.join(", ")}
      RETURN e
      `,
      params,
    );
    return { id, ...entity, created_at: now, updated_at: now };
  }

  async getEntity(id: string): Promise<Entity | null> {
    const rows = await this.queryRows(
      `MATCH (e:Entity {id: $id}) RETURN e`,
      { id },
      true,
    );
    const row = rows[0];
    if (!row) return null;
    return nodeToEntity(row["e"]);
  }

  async listEntities(opts: { type?: EntityType; limit?: number } = {}): Promise<Entity[]> {
    const limit = Math.min(opts.limit ?? 100, 1000);
    const where = opts.type ? `WHERE e.type = $type` : "";
    const rows = await this.queryRows(
      `MATCH (e:Entity) ${where} RETURN e ORDER BY e.updated_at DESC LIMIT ${limit}`,
      opts.type ? { type: opts.type } : undefined,
      true,
    );
    return rows.map((r) => nodeToEntity(r["e"])).filter((e): e is Entity => !!e);
  }

  async forgetEntity(id: string): Promise<boolean> {
    const rows = await this.queryRows(
      `MATCH (e:Entity {id: $id}) DETACH DELETE e RETURN 1 AS ok`,
      { id },
    );
    return rows.length > 0;
  }

  async searchEntities(query: string, limit = 10): Promise<MemorySearchHit[]> {
    await this.init();
    const cap = Math.min(limit, 50);

    // First try the fulltext index. The FT query parser treats `-`, `,`, `.`,
    // `:`, and quotes as special syntax, so passing a raw user prompt like
    // "open-assistant" returns zero rows even though entities match. Strip
    // those down to word tokens before sending.
    const ftQuery = ftSanitize(query);
    if (ftQuery) {
      try {
        const rows = await this.queryRows(
          `CALL db.idx.fulltext.queryNodes('Entity', $q) YIELD node, score
           RETURN node, score ORDER BY score DESC LIMIT ${cap}`,
          { q: ftQuery },
          true,
        );
        const hits = rows
          .map((r) => {
            const entity = nodeToEntity(r["node"]);
            if (!entity) return null;
            return { entity, score: Number(r["score"] ?? 0) };
          })
          .filter((x): x is MemorySearchHit => !!x);
        if (hits.length) return hits;
        // Fall through to substring on empty — FT may legitimately have no
        // match even though substring would (older index, never re-indexed
        // after upgrade, special char that survived sanitize, etc.).
      } catch {
        // Fall through.
      }
    }

    // Substring fallback. Single CONTAINS over (name + description) catches
    // anything the FT path missed and is the only thing that works at all
    // when the FT index isn't there (old FalkorDB) or wasn't populated yet.
    const rows = await this.queryRows(
      `MATCH (e:Entity)
       WHERE toLower(e.name) CONTAINS toLower($q)
          OR toLower(e.description) CONTAINS toLower($q)
       RETURN e LIMIT ${cap}`,
      { q: query },
      true,
    );
    return rows
      .map((r) => nodeToEntity(r["e"]))
      .filter((e): e is Entity => !!e)
      .map((entity) => ({ entity, score: 0.5 }));
  }

  // -------- Relations --------

  async addRelation(rel: Relation): Promise<void> {
    await this.init();
    const now = rel.created_at ?? Date.now();
    await this.query(
      `
      MATCH (a:Entity {id: $from}), (b:Entity {id: $to})
      MERGE (a)-[r:REL {type: $type}]->(b)
      ON CREATE SET r.created_at = $now, r.weight = coalesce($weight, 1.0), r.context = $context
      ON MATCH  SET r.weight = coalesce(r.weight, 1.0) + 0.1,
                    r.context = coalesce($context, r.context)
      `,
      {
        from: rel.from,
        to: rel.to,
        type: rel.type,
        context: rel.context ?? "",
        weight: rel.weight ?? 1.0,
        now,
      },
    );
  }

  async neighbors(id: string, depth = 1, limit = 50): Promise<SubgraphResult> {
    return this.subgraphForEntities([id], depth, limit);
  }

  async subgraphForEntities(ids: string[], depth = 1, limit = 200): Promise<SubgraphResult> {
    if (ids.length === 0) return { entities: [], relations: [] };
    const d = Math.min(Math.max(depth, 1), 2);

    // Two cheap queries: nodes and edges. Easier to reason about than a single
    // path-collecting query, and well within FalkorDB's Cypher subset.
    const nodeRows = await this.queryRows(
      `
      MATCH (e:Entity) WHERE e.id IN $ids
      OPTIONAL MATCH (e)-[*1..${d}]-(n:Entity)
      WITH collect(DISTINCT e) + collect(DISTINCT n) AS ns
      UNWIND ns AS node
      WITH node WHERE node IS NOT NULL
      RETURN node LIMIT ${limit}
      `,
      { ids },
      true,
    );
    const entities: Entity[] = [];
    const seen = new Set<string>();
    for (const row of nodeRows) {
      const e = nodeToEntity(row["node"]);
      if (e && !seen.has(e.id)) {
        seen.add(e.id);
        entities.push(e);
      }
    }
    if (!entities.length) return { entities: [], relations: [] };

    const allIds = entities.map((e) => e.id);
    const edgeRows = await this.queryRows(
      `
      MATCH (a:Entity)-[r:REL]-(b:Entity)
      WHERE a.id IN $ids AND b.id IN $ids
      RETURN a.id AS fromId, b.id AS toId, r LIMIT ${limit * 4}
      `,
      { ids: allIds },
      true,
    );
    const relations: Relation[] = [];
    const edgeSeen = new Set<string>();
    for (const row of edgeRows) {
      const from = typeof row["fromId"] === "string" ? row["fromId"] : null;
      const to = typeof row["toId"] === "string" ? row["toId"] : null;
      if (!from || !to) continue;
      const raw = row["r"];
      if (!isEdge(raw)) continue;
      const type = (raw.properties["type"] as RelationType | undefined) ?? "related_to";
      // Each undirected edge surfaces twice (a→b and b→a); dedupe by id.
      const key = `${raw.id}`;
      if (edgeSeen.has(key)) continue;
      edgeSeen.add(key);
      relations.push({
        from,
        to,
        type,
        context: typeof raw.properties["context"] === "string" ? raw.properties["context"] : undefined,
        weight: typeof raw.properties["weight"] === "number" ? raw.properties["weight"] : undefined,
        created_at:
          typeof raw.properties["created_at"] === "number" ? raw.properties["created_at"] : undefined,
      });
    }
    return { entities, relations };
  }

  // -------- Turns (conversation log) --------

  async recordTurn(turn: Turn, mentions: string[] = []): Promise<void> {
    await this.init();
    await this.query(
      `
      MERGE (t:Turn {id: $id})
      SET t.session_id = $session_id,
          t.role = $role,
          t.content = $content,
          t.created_at = $created_at
      `,
      turn as unknown as Record<string, unknown>,
    );
    for (const entId of mentions) {
      await this.query(
        `
        MATCH (t:Turn {id: $tid}), (e:Entity {id: $eid})
        MERGE (t)-[m:MENTIONS]->(e)
        ON CREATE SET m.created_at = $now
        `,
        { tid: turn.id, eid: entId, now: Date.now() },
      );
    }
  }

  async recentTurns(sessionId: string, limit = 20): Promise<Turn[]> {
    const rows = await this.queryRows(
      `MATCH (t:Turn {session_id: $sid})
       RETURN t ORDER BY t.created_at DESC LIMIT ${Math.min(limit, 200)}`,
      { sid: sessionId },
      true,
    );
    return rows
      .map((r) => nodeToTurn(r["t"]))
      .filter((t): t is Turn => !!t)
      .reverse();
  }

  /**
   * Drop the entire graph. Returns the number of nodes that were removed.
   * Safe to call on an empty graph.
   */
  async clearGraph(): Promise<number> {
    await this.connect();
    try {
      const rows = await this.queryRows(
        `MATCH (n) WITH count(n) AS n DETACH DELETE n RETURN n AS deleted`,
        undefined,
        false,
      );
      const deleted = Number(rows[0]?.["deleted"] ?? 0);
      // Reset init state so the next operation re-creates indexes.
      this.initialized = false;
      return deleted;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/empty key|empty graph/i.test(msg)) return 0;
      throw err;
    }
  }

  async stats(): Promise<{ entities: number; relations: number; turns: number }> {
    // Wrap each in a soft-fail so an empty graph (no key in Redis yet) reports
    // zeros instead of throwing "Invalid graph operation on empty key".
    const count = async (cypher: string): Promise<number> => {
      try {
        const rows = await this.queryRows(cypher, undefined, true);
        return Number(rows[0]?.["c"] ?? 0);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/empty key|empty graph/i.test(msg)) return 0;
        throw err;
      }
    };
    const [entities, relations, turns] = await Promise.all([
      count(`MATCH (e:Entity) RETURN count(e) AS c`),
      count(`MATCH ()-[r:REL]->() RETURN count(r) AS c`),
      count(`MATCH (t:Turn) RETURN count(t) AS c`),
    ]);
    return { entities, relations, turns };
  }
}

// ---------- helpers ----------

/**
 * Strip FT-parser-meaningful characters from a user query. Redis Search
 * (which backs FalkorDB's fulltext) treats hyphens as NOT, dots and colons
 * as field/special syntax, and quotes as phrase delimiters. So a raw
 * prompt like `"open-assistant"` parses to "open NOT assistant" and
 * returns nothing. We reduce to plain words separated by spaces; the FT
 * engine then ANDs them, which is what users actually want.
 */
function ftSanitize(s: string): string {
  return s
    .replace(/[-,.:;/\\(){}\[\]"'`<>!@#$%^&*+=~|?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatParams(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    parts.push(`${k}=${formatValue(v)}`);
  }
  return parts.join(" ");
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(formatValue).join(",")}]`;
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).map(
      ([k, vv]) => `${k}: ${formatValue(vv)}`,
    );
    return `{${entries.join(", ")}}`;
  }
  return JSON.stringify(String(v));
}

interface DecodedNode {
  __node: true;
  id: number;
  labels: string[];
  properties: Record<string, unknown>;
}

interface DecodedEdge {
  __edge: true;
  id: number;
  type: string;
  src: number;
  dst: number;
  properties: Record<string, unknown>;
}

/**
 * Decode a value cell from FalkorDB's verbose (non-compact) response.
 *
 * Nodes and edges come back as an array of [key, value] pairs:
 *   node:  [["id", N], ["labels", ["L"]], ["properties", [["k", v], ...]]]
 *   edge:  [["id", N], ["type", "REL"], ["src_node", N], ["dest_node", N], ["properties", [...]]]
 * Maps look the same shape; we disambiguate by inspecting which keys appear.
 * Everything else (scalars, plain arrays) passes through.
 */
function decodeValue(v: unknown): unknown {
  if (v == null) return v;
  if (typeof v !== "object") return v;
  if (!Array.isArray(v)) return v;

  // Empty array: just an empty list.
  if (v.length === 0) return [];

  // Heuristic: if every element is a [string, value] pair, treat the outer
  // array as a map / structured value.
  const looksLikeMap = v.every(
    (entry) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string",
  );
  if (looksLikeMap) {
    const map: Record<string, unknown> = {};
    for (const entry of v as Array<[string, unknown]>) {
      const [k, val] = entry;
      map[k] = decodeValue(val);
    }
    if ("labels" in map && "properties" in map) {
      const labels = Array.isArray(map["labels"])
        ? (map["labels"] as unknown[]).map((l) => String(l))
        : [];
      return {
        __node: true,
        id: Number(map["id"] ?? 0),
        labels,
        properties: (map["properties"] ?? {}) as Record<string, unknown>,
      } satisfies DecodedNode;
    }
    if ("src_node" in map && "dest_node" in map) {
      return {
        __edge: true,
        id: Number(map["id"] ?? 0),
        type: typeof map["type"] === "string" ? map["type"] : String(map["type"] ?? "REL"),
        src: Number(map["src_node"] ?? 0),
        dst: Number(map["dest_node"] ?? 0),
        properties: (map["properties"] ?? {}) as Record<string, unknown>,
      } satisfies DecodedEdge;
    }
    return map;
  }

  return v.map(decodeValue);
}

function isNode(v: unknown): v is DecodedNode {
  return !!v && typeof v === "object" && (v as { __node?: boolean }).__node === true;
}

function isEdge(v: unknown): v is DecodedEdge {
  return !!v && typeof v === "object" && (v as { __edge?: boolean }).__edge === true;
}

function nodeToEntity(v: unknown): Entity | null {
  if (!isNode(v)) return null;
  const p = v.properties;
  if (typeof p["id"] !== "string" || typeof p["type"] !== "string" || typeof p["name"] !== "string") {
    return null;
  }
  const attributes: Record<string, string | number | boolean> = {};
  for (const [k, val] of Object.entries(p)) {
    if (k.startsWith("attr_") && (typeof val === "string" || typeof val === "number" || typeof val === "boolean")) {
      attributes[k.slice(5)] = val;
    }
  }
  return {
    id: p["id"],
    type: p["type"] as EntityType,
    name: p["name"],
    description: typeof p["description"] === "string" ? p["description"] : undefined,
    attributes: Object.keys(attributes).length ? attributes : undefined,
    created_at: typeof p["created_at"] === "number" ? p["created_at"] : undefined,
    updated_at: typeof p["updated_at"] === "number" ? p["updated_at"] : undefined,
  };
}

function nodeToTurn(v: unknown): Turn | null {
  if (!isNode(v)) return null;
  const p = v.properties;
  if (typeof p["id"] !== "string" || typeof p["session_id"] !== "string") return null;
  return {
    id: p["id"],
    session_id: p["session_id"],
    role: (p["role"] as Turn["role"]) ?? "user",
    content: typeof p["content"] === "string" ? p["content"] : "",
    created_at: typeof p["created_at"] === "number" ? p["created_at"] : 0,
  };
}

