export * from "./schema.js";
export * from "./client.js";
export * from "./extractor.js";

import { MemoryStore } from "./client.js";
import { EntityExtractor, type ExtractorOptions } from "./extractor.js";
import { entityId, type Entity, type Relation } from "./schema.js";

/**
 * Ingest a free-text turn: extract entities/relations via LLM, persist them,
 * link the turn node to mentioned entities. Returns the IDs of entities
 * mentioned (useful for follow-up subgraph retrieval).
 */
export async function ingestText(
  store: MemoryStore,
  extractor: EntityExtractor,
  text: string,
  meta: { sessionId: string; turnId: string; role: "user" | "assistant" | "system"; createdAt?: number },
): Promise<{ mentions: string[]; entities: Entity[]; relations: Relation[] }> {
  const extraction = await extractor.extract(text);
  const persistedEntities: Entity[] = [];
  for (const e of extraction.entities) {
    const entity = await store.upsertEntity({
      type: e.type,
      name: e.name,
      description: e.description,
    });
    persistedEntities.push(entity);
  }
  const nameToId = new Map<string, string>();
  for (const e of extraction.entities) nameToId.set(e.name, entityId(e.type, e.name));
  const persistedRelations: Relation[] = [];
  for (const r of extraction.relations) {
    const from = nameToId.get(r.from);
    const to = nameToId.get(r.to);
    if (!from || !to) continue;
    await store.addRelation({ from, to, type: r.type, context: r.context });
    persistedRelations.push({ from, to, type: r.type, context: r.context });
  }
  const mentions = persistedEntities.map((e) => e.id);
  await store.recordTurn(
    {
      id: meta.turnId,
      session_id: meta.sessionId,
      role: meta.role,
      content: text,
      created_at: meta.createdAt ?? Date.now(),
    },
    mentions,
  );
  return { mentions, entities: persistedEntities, relations: persistedRelations };
}

export function createExtractor(opts: ExtractorOptions = {}): EntityExtractor {
  return new EntityExtractor(opts);
}
