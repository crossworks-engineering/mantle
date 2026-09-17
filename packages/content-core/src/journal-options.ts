/**
 * Browser-safe leaf for Journal option lists (kinds + gap statuses).
 *
 * These constants are needed both server-side (CRUD, extractor framing, the
 * identity/working-notes distillers) and client-side (the /journal editor +
 * filters). They live in their own module — with NO `@mantle/db` import — so a
 * client component can pull them in without dragging `postgres` into the
 * browser bundle. Same pattern as `contacts-format.ts`. `journal.ts`
 * re-exports these.
 *
 * Journal v2 (2026-08): the mood palette and life-area categories are GONE.
 * A journal entry is now one of a small set of KINDS across two lanes:
 *   - user lane:  durable self-knowledge that grounds every agent turn
 *   - agent lane: what an agent has learned about doing its job well
 * Legacy rows keep their old `mood`/`category` jsonb values; nothing reads
 * `mood` anymore, and `category` maps to a kind at read time (see
 * `legacyCategoryToKind`). No migration, no backfill.
 */

/** The lane a kind belongs to. User-lane entries feed the "# About the user"
 *  block; agent-lane entries feed the per-turn "# Working notes" block. */
export type JournalLane = 'user' | 'agent';

/** The full kind vocabulary. Stored as the bare key string in `data.kind`;
 *  free text is tolerated on read, but pickers/tools offer these. */
export const KINDS = [
  // ── user lane: who the user/org is and what they want ──────────────────
  { key: 'identity', lane: 'user', label: 'Identity' },
  { key: 'context', lane: 'user', label: 'Context' },
  { key: 'preference', lane: 'user', label: 'Preference' },
  { key: 'goal', lane: 'user', label: 'Goal' },
  // ── agent lane: what an agent has learned about doing its job ──────────
  { key: 'lesson', lane: 'agent', label: 'Lesson' },
  { key: 'expectation', lane: 'agent', label: 'Expectation' },
  { key: 'gap', lane: 'agent', label: 'Open question' },
] as const;

export type KindKey = (typeof KINDS)[number]['key'];
export const KIND_KEYS: readonly string[] = KINDS.map((k) => k.key);
export const USER_KIND_KEYS: readonly string[] = KINDS.filter((k) => k.lane === 'user').map(
  (k) => k.key,
);
export const AGENT_KIND_KEYS: readonly string[] = KINDS.filter((k) => k.lane === 'agent').map(
  (k) => k.key,
);

/** Gap-entry lifecycle. Only entries with kind='gap' carry a status. */
export const GAP_STATUSES = ['open', 'resolved'] as const;
export type GapStatus = (typeof GAP_STATUSES)[number];

/** Kind key → human label, tolerant of free-text/unknown values. */
export function kindLabel(key: string | null): string | null {
  if (!key) return null;
  const found = KINDS.find((k) => k.key === key);
  if (found) return found.label;
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** Which lane a kind belongs to. Unknown/free-text kinds read as user lane —
 *  the safe default (they render as user self-knowledge, never as agent
 *  working notes). */
export function kindLane(key: string | null): JournalLane {
  const found = KINDS.find((k) => k.key === key);
  return found?.lane ?? 'user';
}

/** Map a legacy pre-v2 `category` value to a kind, for rows written before
 *  the kind vocabulary existed. `identity`/`goal` carry over; every other
 *  life area (work, family, faith, health, emotion, …) reads as `context`.
 *  Only consulted when a row has no `kind`. */
export function legacyCategoryToKind(category: string | null): KindKey {
  if (category === 'identity') return 'identity';
  if (category === 'goal') return 'goal';
  return 'context';
}

/**
 * Normalise a user/agent-supplied entry date to a canonical ISO-8601 string,
 * or return null if it isn't a real date. Stored `entry_date` is later cast to
 * `timestamptz` in the list/identity sort, so an unparseable value (e.g. the
 * agent passing "next Tuesday") MUST be rejected here — otherwise it poisons
 * the ORDER BY and breaks the whole list. `''`/whitespace → null (no date).
 */
export function normalizeEntryDate(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}
