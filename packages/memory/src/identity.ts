import type { MemoryStore } from "./client.js";

export interface Identities {
  user: string | null;
  assistant: string | null;
}

export interface IdentityUpdate {
  user?: string;
  assistant?: string;
}

/**
 * Heuristics for catching the two cases we actually care about — the user
 * introducing themselves, or the user naming the assistant. Tight patterns
 * on purpose: false positives end up persisted as someone's identity, so
 * "i'm tired" should never match "user's name is Tired".
 */
const USER_PATTERNS: RegExp[] = [
  /(?:^|[\s.,;:!?(])my name(?:'?s| is)\s+([A-Z][a-zA-Z'\-]{1,30})/i,
  /(?:^|[\s.,;:!?(])(?:please\s+)?call me\s+([A-Z][a-zA-Z'\-]{1,30})/i,
  /(?:^|[\s.,;:!?(])i(?:'?m| am)\s+([A-Z][a-zA-Z'\-]{1,30})(?=[\s.,;:!?]|$)/i,
];

const ASSISTANT_PATTERNS: RegExp[] = [
  /(?:^|[\s.,;:!?(])i(?:'?ll| will)\s+call you\s+([A-Z][a-zA-Z'\-]{1,30})/i,
  /(?:^|[\s.,;:!?(])your name(?:'?s| is)\s+([A-Z][a-zA-Z'\-]{1,30})/i,
  /(?:^|[\s.,;:!?(])(?:from now on,?\s+)?you(?:'?re| are)\s+([A-Z][a-zA-Z'\-]{1,30})(?=[\s.,;:!?]|$)/i,
  /(?:^|[\s.,;:!?(])let(?:'?s| us)\s+(?:call|name) you\s+([A-Z][a-zA-Z'\-]{1,30})/i,
];

const STOPWORDS = new Set(
  [
    // Common false-positives for "I am X" — pronouns, states, adjectives.
    "i", "me", "we", "you", "he", "she", "it", "they",
    "sorry", "tired", "done", "here", "there", "back",
    "fine", "good", "great", "okay", "ok", "ready",
    "curious", "confused", "lost", "wrong", "right",
    "happy", "sad", "angry", "afraid", "scared",
    "the", "a", "an",
  ].map((s) => s.toLowerCase()),
);

function normalizeName(raw: string): string {
  return raw[0]!.toUpperCase() + raw.slice(1).toLowerCase();
}

/**
 * Pull identity updates from a user message. Returns whichever roles were
 * mentioned; intentionally returns nothing for ambiguous phrasing.
 */
export function detectIdentities(text: string): IdentityUpdate {
  const out: IdentityUpdate = {};
  for (const re of USER_PATTERNS) {
    const m = text.match(re);
    if (m && m[1] && !STOPWORDS.has(m[1].toLowerCase())) {
      out.user = normalizeName(m[1]);
      break;
    }
  }
  for (const re of ASSISTANT_PATTERNS) {
    const m = text.match(re);
    if (m && m[1] && !STOPWORDS.has(m[1].toLowerCase())) {
      out.assistant = normalizeName(m[1]);
      break;
    }
  }
  return out;
}

const KEY = (role: "user" | "assistant") => `identity:${role}`;

/**
 * Persist the current user / assistant names in their own marker entities.
 * Stored as `person` nodes with a stable id so they're easy to read back —
 * the actual display name lives in the `name` field.
 */
export async function setIdentity(
  store: MemoryStore,
  role: "user" | "assistant",
  name: string,
): Promise<void> {
  await store.upsertEntity({
    id: KEY(role),
    type: "person",
    name,
    description: role === "user" ? "The human chatting" : "The assistant's chosen name",
    attributes: { role, is_marker: true },
  });
}

export async function getIdentities(store: MemoryStore): Promise<Identities> {
  const [u, a] = await Promise.all([store.getEntity(KEY("user")), store.getEntity(KEY("assistant"))]);
  return { user: u?.name ?? null, assistant: a?.name ?? null };
}

export async function applyIdentityUpdate(
  store: MemoryStore,
  update: IdentityUpdate,
): Promise<Identities> {
  const writes: Promise<void>[] = [];
  if (update.user) writes.push(setIdentity(store, "user", update.user));
  if (update.assistant) writes.push(setIdentity(store, "assistant", update.assistant));
  if (writes.length) await Promise.all(writes);
  return getIdentities(store);
}
