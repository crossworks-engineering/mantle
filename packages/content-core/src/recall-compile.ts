/**
 * Recall — the shared constants and the slug rule, read by the brain's native
 * write path (packages/content/src/recall-native.ts) and by clients, so the
 * editor's counter and the brain's write check always agree.
 *
 * The file name is historical: it held the v1 page compiler (parseRecallDoc,
 * assignRecallSlugs and the lint types) until R5 retired page-built maps.
 * The subpath `@mantle/content-core/recall-compile` stays, because clients
 * import these constants from it.
 */

/** Body budget per card, in characters of markdown (~1.5k tokens).
 *  Character-based on purpose: it matches `EMBED_TEXT_*`'s convention and
 *  keeps this package dependency-free. */
export const RECALL_BODY_CHAR_BUDGET = 6000;

/** Hard cap on cards per map. A map this big has stopped being a map. */
export const RECALL_MAX_MAP_NODES = 100;

/** Kebab-case a title into a stable slug ('Fleet, access & MCP' → 'fleet-access-mcp').
 *  Cut at 60 characters; `recallNativeSlug` backs that cut up to a word. */
export function recallSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'node';
}
