/**
 * Canonical slug normaliser for the web app.
 *
 * ── Divergence history (audit item #5a) ──────────────────────────────────────
 * Roughly ten screens each grew their own private `slugify` by copy-paste, and
 * they drifted apart into subtly incompatible rules:
 *   - agents / ai-workers / docs / export: strip `_` (alnum + `-` only)
 *   - skills / heartbeats / tool-groups / tools: KEEP `_` (it's a legal char in
 *     those slug namespaces)
 *   - save-tool: KEEP `_` AND join with `_` instead of `-` (tool slugs like
 *     `web_search` read as underscore-cased)
 *   - length caps ranged over {none, 60, 64, 80}
 *   - the export route adds a `'export'` fallback for empty titles
 * So the "same" typed name produced different slugs on different screens.
 *
 * These differences are NOT all accidental: an agent slug and a skill slug obey
 * different server-side validation, so unifying them to one fixed behaviour
 * would seed values the API then rejects. The options below exist precisely to
 * preserve each call site's *legal* slug shape while sharing one implementation.
 * DO NOT "simplify" them away — a stored slug that no longer round-trips orphans
 * existing rows (agents, skills, tool groups, workers, folders keyed by slug).
 *
 * NOTE: the folder-slug helper in `files-client.tsx` intentionally does NOT use
 * this — it *deletes* punctuation instead of turning it into a separator (a
 * genuinely different normalisation for on-disk folder paths), so it stays
 * separate and documented at its call site.
 */

export interface SlugifyOptions {
  /** Keep `_` as a legal slug character instead of treating it as a separator.
   *  Default `false` (underscores collapse into the separator). */
  allowUnderscore?: boolean;
  /** Hard cap on length, applied AFTER trimming separators (so, like the
   *  originals, a cut can land mid-word and leave a trailing separator). Omit
   *  for no cap. */
  maxLength?: number;
  /** Character that runs of illegal chars collapse into, and that is trimmed
   *  from the ends. Default `'-'`; `save-tool` uses `'_'`. */
  separator?: string;
  /** Returned when normalisation yields an empty string (e.g. an all-unicode
   *  title). Default `''`. */
  fallback?: string;
}

function escapeForCharClassOrEnd(ch: string): string {
  // Only `-` and `_` are ever passed as separators today; escape defensively so
  // a future caller can't smuggle a regex metacharacter into the built pattern.
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalise free-form text into a URL/identifier-safe slug: lower-cased, with
 * runs of illegal characters collapsed to a single separator and separators
 * trimmed from both ends.
 */
export function slugify(input: string, opts: SlugifyOptions = {}): string {
  const { allowUnderscore = false, maxLength, separator = '-', fallback = '' } = opts;

  // Illegal chars = anything outside the keep-set. With underscores allowed we
  // also keep `-`, mirroring the legacy `[^a-z0-9_-]` class; without, just alnum.
  const keepClass = allowUnderscore ? 'a-z0-9_-' : 'a-z0-9';
  const sep = escapeForCharClassOrEnd(separator);

  let out = input
    .toLowerCase()
    .replace(new RegExp(`[^${keepClass}]+`, 'g'), separator)
    .replace(new RegExp(`^${sep}+|${sep}+$`, 'g'), '');

  if (maxLength != null) out = out.slice(0, maxLength);
  return out || fallback;
}
