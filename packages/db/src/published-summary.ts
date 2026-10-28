/**
 * The published summary of an app or a canvas (Journal v3, J9): what the
 * item is, who it is for and how to use it, in a few plain sentences, fixed
 * at the moment the item is published. It lives on `nodes.data` under one
 * key, written here and nowhere else:
 *
 *   { text, source: 'author' | 'publish', hash, at, model }
 *
 *  - 'author': the agent or client that built the item passed it (free).
 *  - 'publish': none was passed, so one summarizer call at the publish
 *    wrote it (@mantle/tools publish-summary.ts).
 *
 * `hash` names what the summary was made from (the published source, its
 * manifest), so a publish that changed neither makes no second call.
 *
 * It is not a derived key: the user's own publish sets it, so the edit check
 * lets it through (edit-check.ts GATEWAY_KEY_WRITERS). It is not one of the
 * SUMMARY_KEYS either, so a content reset never drops it: the extractor
 * indexes it as the item's summary (summaryToIndex) instead of its own, on
 * every pass, until a new publish replaces it.
 *
 * The rule of which one wins (planPublishedSummary): a summary the author
 * passes always replaces what is there; an author's summary is never replaced
 * by a generated one (the author knows what they made); a generated one is
 * made again only when what it was made from changed.
 */
import { createHash } from 'node:crypto';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { nodes } from './schema/nodes';
import type { ContentTx } from './content-changed';

/** The key of nodes.data. Spelled here only (edit-check.test.ts). */
const KEY = 'published_summary';

/** The longest summary kept, in characters. */
export const PUBLISHED_SUMMARY_MAX_CHARS = 600;

/** Who wrote a published summary. */
export type PublishedSummarySource = 'author' | 'publish';

export type PublishedSummary = {
  text: string;
  source: PublishedSummarySource;
  /** What it was made from (summaryHash of the published inputs). */
  hash: string;
  /** When it was written (ISO). */
  at: string;
  /** The model that wrote a 'publish' summary; null for an author's. */
  model: string | null;
};

/** A stable hash of the inputs a summary is made from. */
export function summaryHash(...parts: readonly string[]): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(p).update('\u0000');
  return h.digest('hex');
}

/**
 * A summary as kept: one line of plain text (control characters and runs of
 * white space folded to one space), cut at the last word that fits in
 * PUBLISHED_SUMMARY_MAX_CHARS. Empty when nothing is left.
 */
export function cleanSummaryText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const flat = raw.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
  if (flat.length <= PUBLISHED_SUMMARY_MAX_CHARS) return flat;
  const cut = flat.slice(0, PUBLISHED_SUMMARY_MAX_CHARS);
  const space = cut.lastIndexOf(' ');
  return (space > PUBLISHED_SUMMARY_MAX_CHARS * 0.6 ? cut.slice(0, space) : cut).trim();
}

/** A new published summary, or null when the text is empty once cleaned. */
export function newPublishedSummary(
  text: unknown,
  source: PublishedSummarySource,
  hash: string,
  model: string | null = null,
): PublishedSummary | null {
  const clean = cleanSummaryText(text);
  if (!clean) return null;
  return {
    text: clean,
    source,
    hash,
    at: new Date().toISOString(),
    model: source === 'author' ? null : model,
  };
}

/** The published summary `data` holds, or null (none, or not one). */
export function readPublishedSummary(data: unknown): PublishedSummary | null {
  const v = (data as Record<string, unknown> | null | undefined)?.[KEY];
  if (!v || typeof v !== 'object') return null;
  const s = v as Record<string, unknown>;
  const text = typeof s.text === 'string' ? s.text.trim() : '';
  if (!text || (s.source !== 'author' && s.source !== 'publish')) return null;
  return {
    text,
    source: s.source,
    hash: typeof s.hash === 'string' ? s.hash : '',
    at: typeof s.at === 'string' ? s.at : '',
    model: typeof s.model === 'string' ? s.model : null,
  };
}

/** What a publish does about the summary. */
export type PublishedSummaryPlan =
  { do: 'write'; summary: PublishedSummary } | { do: 'keep' } | { do: 'generate' };

/**
 * The one rule: `given` (the author's text, if any) always wins; an
 * author's summary already there is kept; a generated one is kept while its
 * hash is the inputs' `hash`; anything else asks for one summarizer call.
 */
export function planPublishedSummary(
  kept: PublishedSummary | null,
  given: unknown,
  hash: string,
): PublishedSummaryPlan {
  const author = newPublishedSummary(given, 'author', hash);
  if (author) {
    return kept?.source === 'author' && kept.text === author.text
      ? { do: 'keep' }
      : { do: 'write', summary: author };
  }
  if (kept?.source === 'author') return { do: 'keep' };
  if (kept?.source === 'publish' && kept.hash === hash) return { do: 'keep' };
  return { do: 'generate' };
}

/**
 * The summary the extractor indexes for an item: its published summary when
 * it has one, else the one its own model pass wrote. `model` is what
 * nodes.data.summary_model records: the summarizer's model, 'author' for an
 * author's summary, the extractor's own model otherwise.
 */
export function summaryToIndex(
  data: unknown,
  extracted: { text: string; model: string },
): { text: string; model: string; source: PublishedSummarySource | null } {
  const kept = readPublishedSummary(data);
  if (!kept) return { ...extracted, source: null };
  return {
    text: kept.text,
    model: kept.source === 'author' ? 'author' : (kept.model ?? extracted.model),
    source: kept.source,
  };
}

/**
 * Write `summary` as the item's published summary, on `tx`. A generated
 * one never lands over an author's (one the author passed while the
 * summarizer ran): the rule of planPublishedSummary, held in the write.
 * Returns whether it was written.
 */
export async function writePublishedSummary(
  tx: Pick<ContentTx, 'update'>,
  nodeId: string,
  summary: PublishedSummary,
): Promise<boolean> {
  const notOverAuthor =
    summary.source === 'author'
      ? sql`true`
      : sql`coalesce(${nodes.data}->${KEY}::text->>'source', '') <> 'author'`;
  const written = await tx
    .update(nodes)
    .set({
      data: sql`coalesce(${nodes.data}, '{}'::jsonb) || jsonb_build_object(${KEY}::text, ${JSON.stringify(summary)}::jsonb)`,
    })
    .where(and(eq(nodes.id, nodeId), notOverAuthor))
    .returning({ id: nodes.id });
  return written.length > 0;
}

/** The row still holds `text` as its published summary: the guard of a
 *  write made from it (the extractor's index of a kept summary). */
export function publishedSummaryIs(text: string): SQL {
  return sql`${nodes.data}->${KEY}::text->>'text' = ${text}`;
}
