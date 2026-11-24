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
 * written). Set on the AI workers screen under the Translator (a System
 * Settings screen, the settings area) and over MCP (`search_languages`).
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
 * The languages Postgres ships a stop list for (its `*.stop` files), by
 * code, with their text search config. A translation's own stop words
 * ("de", "la", "der") are no stop words to the `english` rules, and a brain
 * with few documents in that language would count them rare: its words go
 * through its language's stop list before the lookup (keyword-query.ts).
 * So only a language with a stop list is a search language. A config with
 * no stop list (catalan, romanian, greek and more) is not enough;
 * search-languages.db.test.ts holds that each one here has stop words.
 */
const STOP_WORD_CONFIGS: Readonly<Record<string, string>> = {
  da: 'danish',
  de: 'german',
  en: 'english',
  es: 'spanish',
  fi: 'finnish',
  fr: 'french',
  hu: 'hungarian',
  it: 'italian',
  nb: 'norwegian',
  ne: 'nepali',
  nl: 'dutch',
  nn: 'norwegian',
  no: 'norwegian',
  pt: 'portuguese',
  ru: 'russian',
  sv: 'swedish',
  tr: 'turkish',
};

/** Every config in the list (for the DB test). */
export const STOP_WORD_CONFIG_NAMES: readonly string[] = [
  ...new Set(Object.values(STOP_WORD_CONFIGS)),
];

/** The stop-list config for a language code (`pt-BR` → portuguese), or
 *  null when Postgres has none (pure). */
export function stopWordConfig(lang: string): string | null {
  return STOP_WORD_CONFIGS[lang.split('-')[0]!.toLowerCase()] ?? null;
}

/** The languages a search language may be, for an error (pure). */
const SUPPORTED = Object.keys(STOP_WORD_CONFIGS).join(', ');

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
    if (!stopWordConfig(c)) {
      return {
        ok: false,
        error: `'${c}' is not a search language: word search needs the language's stop words, which this box has for ${SUPPORTED} (a region such as pt-BR is fine).`,
      };
    }
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

/** The stored value as a clean list (pure): the codes that pass, the rest
 *  dropped, so a bad hand write (or a code no longer one) turns that code
 *  off, never on, and leaves the others. */
export function normalizeSearchLanguages(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const code of raw) {
    const one = parseSearchLanguages([code]);
    if (one.ok && one.languages[0] && !out.includes(one.languages[0])) out.push(one.languages[0]);
  }
  return out.slice(0, SEARCH_LANGUAGES_MAX);
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
