/**
 * Browser-safe leaf for Life Log option lists (moods + categories).
 *
 * These constants are needed both server-side (CRUD, extractor framing, the
 * identity-context distiller) and client-side (the /lifelog editor + filters).
 * They live in their own module — with NO `@mantle/db` import — so a client
 * component can pull them in without dragging `postgres` into the browser
 * bundle. Same pattern as `contacts-format.ts`. `lifelog.ts` re-exports these.
 */

/** Curated mood palette (emoji + label). Stored as the bare key string in
 *  `data.mood`; the UI maps key → emoji + label. Free text is tolerated on
 *  read, but the picker offers these. */
export const MOODS = [
  { key: 'happy', label: 'Happy', emoji: '😀' },
  { key: 'grateful', label: 'Grateful', emoji: '🙏' },
  { key: 'calm', label: 'Calm', emoji: '😌' },
  { key: 'excited', label: 'Excited', emoji: '🤩' },
  { key: 'hopeful', label: 'Hopeful', emoji: '🌱' },
  { key: 'reflective', label: 'Reflective', emoji: '🤔' },
  { key: 'tired', label: 'Tired', emoji: '😮‍💨' },
  { key: 'anxious', label: 'Anxious', emoji: '😟' },
  { key: 'sad', label: 'Sad', emoji: '😔' },
  { key: 'angry', label: 'Angry', emoji: '😠' },
] as const;

export type MoodKey = (typeof MOODS)[number]['key'];
export const MOOD_KEYS: readonly string[] = MOODS.map((m) => m.key);

/** Life areas the entry speaks to. Drives the identity block's grouping
 *  ("## Work", "## Faith", …) and the list filter. */
export const CATEGORIES = [
  { key: 'identity', label: 'Identity' },
  { key: 'work', label: 'Work' },
  { key: 'family', label: 'Family' },
  { key: 'relationships', label: 'Relationships' },
  { key: 'faith', label: 'Faith' },
  { key: 'health', label: 'Health' },
  { key: 'emotion', label: 'Emotion' },
  { key: 'goal', label: 'Goal' },
  { key: 'reflection', label: 'Reflection' },
] as const;

export type CategoryKey = (typeof CATEGORIES)[number]['key'];
export const CATEGORY_KEYS: readonly string[] = CATEGORIES.map((c) => c.key);

/** Mood key → display (emoji + label), tolerant of free-text/unknown values. */
export function moodDisplay(key: string | null): { emoji: string; label: string } | null {
  if (!key) return null;
  const found = MOODS.find((m) => m.key === key);
  if (found) return { emoji: found.emoji, label: found.label };
  return { emoji: '', label: key };
}

/** Category key → human label, tolerant of free-text/unknown values. */
export function categoryLabel(key: string | null): string | null {
  if (!key) return null;
  const found = CATEGORIES.find((c) => c.key === key);
  if (found) return found.label;
  return key.charAt(0).toUpperCase() + key.slice(1);
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
