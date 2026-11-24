/**
 * Search languages (plan page 0a1eab17, owner's word 2026-11-24, option 2):
 * the brain's extra languages for the word arm of search, a short list of
 * language codes (`es`, `pt-BR`). Empty by default: a brain that never sets
 * it searches exactly as before.
 *
 * Every `search_tsv` is built with the `english` rules, so an English word
 * never matches a Spanish one. With the list set, the keyword query also
 * holds the query's terms translated into each language (keyword-query.ts,
 * query-translate.ts). A Spanish word put through the same `english` rules
 * gives the same token as the indexed Spanish word, so no new index is
 * needed and no document is ever translated.
 *
 * Stored on the brain's profile row (the anchor owner's preferences, key
 * `searchLanguages`), as the backup settings are: read here, written by
 * `saveSearchLanguages` in @mantle/content (the one place a profile row is
 * written). Set in Settings (System) and over MCP (`search_languages`).
 */
import { eq } from 'drizzle-orm';
import { db, profiles } from '@mantle/db';
import { errorMessage } from '@mantle/std';

/** The preferences key on the brain's profile row. */
export const SEARCH_LANGUAGES_KEY = 'searchLanguages';

/** At most this many languages: each one is a model call on a new query. */
export const SEARCH_LANGUAGES_MAX = 3;

/** A language code: a 2 or 3 letter primary tag, an optional region or
 *  script (`es`, `pt-BR`, `zh-Hant`, `es-419`). */
const CODE_RE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i;

/** A code in its usual case: `pt-br` → `pt-BR`, `ZH-hant` → `zh-Hant`. */
function canonicalCode(code: string): string {
  const [primary, sub] = code.split('-');
  const head = primary!.toLowerCase();
  if (!sub) return head;
  if (sub.length === 2) return `${head}-${sub.toUpperCase()}`;
  if (sub.length === 4 && /^[a-z]+$/i.test(sub)) {
    return `${head}-${sub[0]!.toUpperCase()}${sub.slice(1).toLowerCase()}`;
  }
  return `${head}-${sub.toLowerCase()}`;
}

/**
 * Check what a person or an agent sets (pure): a list of codes, at most
 * `SEARCH_LANGUAGES_MAX`, each a real code. `[]` clears the setting.
 * Duplicates collapse. Returns the list to store, or the error to show.
 */
export function parseSearchLanguages(
  input: unknown,
): { ok: true; languages: string[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) {
    return {
      ok: false,
      error: '`languages` is a list of language codes, for example ["es"]; [] turns it off.',
    };
  }
  const out: string[] = [];
  for (const raw of input) {
    const code = typeof raw === 'string' ? raw.trim() : '';
    if (!CODE_RE.test(code)) {
      return {
        ok: false,
        error: `'${String(raw).slice(0, 40)}' is not a language code. Use a code such as "es", "fr" or "pt-BR".`,
      };
    }
    const c = canonicalCode(code);
    if (!out.includes(c)) out.push(c);
  }
  if (out.length > SEARCH_LANGUAGES_MAX) {
    return {
      ok: false,
      error: `At most ${SEARCH_LANGUAGES_MAX} search languages (got ${out.length}): each one is a model call on a new query. Keep the ones the brain's documents are written in.`,
    };
  }
  return { ok: true, languages: out };
}

/** The stored value as a clean list (pure): anything not a valid list
 *  reads as empty, so a bad hand write turns the feature off, never on. */
export function normalizeSearchLanguages(raw: unknown): string[] {
  const parsed = parseSearchLanguages(raw);
  return parsed.ok ? parsed.languages : [];
}

/**
 * The brain's search languages: `[]` when unset, or when the read fails
 * (search then runs as before). Read in the caller's scope: the brain's
 * profile row is readable in every scope (0266's own-login rule).
 */
export async function loadSearchLanguages(ownerId: string): Promise<string[]> {
  try {
    // The column as drizzle maps it (a raw jsonb expression comes back as
    // text from the driver).
    const [row] = await db
      .select({ preferences: profiles.preferences })
      .from(profiles)
      .where(eq(profiles.userId, ownerId))
      .limit(1);
    return row ? normalizeSearchLanguages(row.preferences?.[SEARCH_LANGUAGES_KEY]) : [];
  } catch (err) {
    console.warn(`[search] search languages not read (${errorMessage(err)}): English only`);
    return [];
  }
}
