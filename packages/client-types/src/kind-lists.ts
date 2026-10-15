/**
 * The kind lists that were written by hand across the repo (arch plan A10
 * #12), each now a filter over one field of the kind registry (./kinds).
 * Every list is in registry order (the Drizzle enum's) unless it says
 * otherwise; the code asks each one for membership only.
 *
 * kind-lists.test.ts pins every list to its value on main v0.300.46 and
 * names, cell by cell, the few that changed with the move.
 *
 * Pure and dependency free: the `@mantle/client-types/kind-lists` subpath.
 */
import {
  ITEM_KINDS,
  ITEM_KIND_NAMES,
  kindSpecOf,
  kindsWhere,
  type AcceptedKind,
  type ContextRefKind,
  type CorpusMapKind,
  type EmbeddingKind,
  type ExportKind,
  type ExtractKind,
  type ItemKind,
  type KindExportFormat,
  type LinkServeKind,
  type MentionTargetKind,
  type SearchToolKind,
} from './kinds';

/** The extractor's default allowlist (a worker's `target_types` replaces
 *  it), and the kinds the integrity view lists. */
export const EXTRACT_KINDS = kindsWhere<ExtractKind>((s) => s.extract);

/** The kinds the responder's corpus map lists by title. */
export const CORPUS_MAP_KINDS = kindsWhere<CorpusMapKind>((s) => s.corpusMap);

/** The kinds that embed other items (node_embeds). */
export const EMBEDDING_KINDS = kindsWhere<EmbeddingKind>((s) => s.embeds);

/** The kinds a mention chip may name. */
export const MENTION_TARGET_KINDS = kindsWhere<MentionTargetKind>((s) => s.mentionTarget);

/** The kinds whose public link may serve the items they name or embed. */
export const LINK_SERVE_KINDS = kindsWhere<LinkServeKind>((s) => s.linkServes);

/** The `type` values of the search tools (search_nodes, the MCP `search`). */
export const SEARCH_TOOL_KINDS = kindsWhere<SearchToolKind>((s) => s.searchTool);

/** The kinds the linked brain grant picker leaves out. */
export const PEER_PICK_EXCLUDED_KINDS = kindsWhere((s) => !s.peerPick);

/** The kinds whose title names a document, not a thing the user does. */
export const DOCUMENT_TITLE_KINDS = kindsWhere((s) => s.documentTitle);

// ── context refs ────────────────────────────────────────────────────────────

const contextRefs = ITEM_KIND_NAMES.flatMap((t) => {
  const ref: string | false = ITEM_KINDS[t].contextRef;
  return ref ? [[ref as ContextRefKind, t] as const] : [];
});

/** The kinds a context ref may name, in the client's vocabulary. */
export const CONTEXT_REF_KINDS = contextRefs.map(([ref]) => ref) as unknown as readonly [
  ContextRefKind,
  ...ContextRefKind[],
];

/** A context ref kind's node type (`folder` is a `branch`). */
export const NODE_TYPE_BY_CONTEXT_REF = Object.fromEntries(contextRefs) as Readonly<
  Record<ContextRefKind, ItemKind>
>;

// ── exports ─────────────────────────────────────────────────────────────────

/** The format each exportable kind downloads as by default. */
export const EXPORT_FORMAT_BY_KIND = Object.fromEntries(
  ITEM_KIND_NAMES.flatMap((t) => {
    const f: KindExportFormat | false = ITEM_KINDS[t].exportAs;
    return f ? [[t, f] as const] : [];
  }),
) as Readonly<Record<ExportKind, KindExportFormat>>;

// ── accepted items ──────────────────────────────────────────────────────────

/** The kinds of an accepted item (a snapshot on accept, the Library, a copy). */
export const ACCEPTED_KINDS = kindsWhere<AcceptedKind>((s) => s.accepted !== false);

export function isAcceptedKind(v: unknown): v is AcceptedKind {
  return typeof v === 'string' && (ACCEPTED_KINDS as readonly string[]).includes(v);
}

/** Which of a bundle's items names it: the lowest rank; a kind that is not
 *  accepted ranks after every accepted one. */
export function acceptedRank(type: string): number {
  const a = kindSpecOf(type)?.accepted;
  return a ? a.rank : ACCEPTED_KINDS.length;
}

/** `T` narrowed to kind `K` when `T` is a union over `type`, else `T`. */
type OfKind<T, K> = [Extract<T, { type: K }>] extends [never] ? T : Extract<T, { type: K }>;

/** One case per accepted kind: a kind that turns `accepted` on fails to
 *  compile at every call until it has its case. */
export type AcceptedCases<T extends { type: string }, R> = {
  readonly [K in AcceptedKind]: (item: OfKind<T, K>) => R;
};

/**
 * The ONE switch over an accepted item's kind (it was copied four times:
 * member-accepted.ts, member-library.ts, member-snapshots.ts and
 * server/web/lib/snapshot-copies.ts). Runs the case of `item.type`, or
 * answers null for a kind that is not accepted.
 */
export function forAcceptedKind<T extends { type: string }, R>(
  item: T,
  cases: AcceptedCases<T, R>,
): R | null {
  if (!isAcceptedKind(item.type)) return null;
  const run = cases[item.type] as (item: T) => R;
  return run(item);
}
