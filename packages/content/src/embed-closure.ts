/**
 * What an item embeds (workspaces W5b2: embeds no longer change who reads
 * anything). Grants alone decide who reads an item: an image, file or drawing
 * a page embeds is read where its own grants say, and "Grant these too" in
 * the item's Grant Access panel (/api/grants/:id/embeds) is the only way an
 * embed gains readers (plan 21.8 row 12). Nothing here writes a row.
 *
 * What counts as an embed:
 *  - a page: its images and file embeds, its embedded drawings, its child
 *    page cards (`referencedEmbedIds` in doc-assets.ts);
 *  - a drawing: its images (`draws.file_refs`);
 *  - a note: the images, file embeds and drawings in its markdown.
 * Links are not embeds (a link mark, a mention chip, a drawing element's
 * link). The database keeps the edges (node_embeds, migration 0208); the
 * Grant Access panel and the share pages read them.
 */
import { db, type ViewerLevel } from '@mantle/db';
import { markdownToDoc } from '@mantle/content-core/markdown';
import { referencedDrawIds, referencedFileIds } from './doc-assets';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** The pool, or a caller's transaction. */
export type ClosureDb = typeof db | Tx;

/** The kinds that embed other items. */
export const EMBEDDING_KINDS: readonly string[] = ['page', 'draw', 'note'];

/** What a note's markdown embeds: images, file embeds and drawings. (A
 *  `page:` link in a note is a link, not a child page.) */
export function noteEmbedIds(markdown: string): string[] {
  if (!markdown) return [];
  const doc = markdownToDoc(markdown);
  return [...new Set([...referencedFileIds(doc), ...referencedDrawIds(doc)])];
}

/** What a drawing embeds: the file of every image in its file map. */
export function drawEmbedIds(fileRefs: unknown): string[] {
  if (!fileRefs || typeof fileRefs !== 'object') return [];
  return [
    ...new Set(Object.values(fileRefs).filter((v): v is string => typeof v === 'string' && !!v)),
  ];
}

/** The file ids of the images a scene PLACES (live image elements), through
 *  its file map: the images a drawing's snapshot carries. */
export function drawPlacedFileIds(scene: unknown, fileRefs: unknown): string[] {
  const refs = (fileRefs && typeof fileRefs === 'object' ? fileRefs : {}) as Record<
    string,
    unknown
  >;
  const elements = (scene as { elements?: unknown } | null)?.elements;
  if (!Array.isArray(elements)) return [];
  const out = new Set<string>();
  for (const el of elements) {
    if (!el || typeof el !== 'object') continue;
    const e = el as { type?: unknown; fileId?: unknown; isDeleted?: unknown };
    if (e.type !== 'image' || e.isDeleted === true || typeof e.fileId !== 'string') continue;
    const id = refs[e.fileId];
    if (typeof id === 'string' && id) out.add(id);
  }
  return [...out];
}

// ── Deprecated no-ops ────────────────────────────────────────────────────────
// Removed in W5b2; callers go in the writers/links helpers. The embed closure
// no longer lowers anything: these keep access.ts, shares.ts, member-review.ts
// and access-shadow.ts compiling until their own level engine goes, and do
// nothing.

/** @deprecated removed in W5b2; callers go in the writers/links helpers. */
export type EmbedItem = { id: string; type: string; title: string; audience: ViewerLevel };

/** @deprecated removed in W5b2; callers go in the writers/links helpers. */
export type LoweredItem = {
  id: string;
  type: string;
  title: string;
  from: ViewerLevel;
  to: ViewerLevel;
};

/** @deprecated removed in W5b2; callers go in the writers/links helpers. */
export type LowerEmbedsResult = { lowered: LoweredItem[]; ceiling: EmbedItem[] };

/** @deprecated removed in W5b2; callers go in the writers/links helpers. */
export type EmbedClosureGap = EmbedItem & { above: EmbedItem[] };

const RANK: Record<ViewerLevel, number> = { public: 0, client: 1, team: 2, admin: 3 };

/** @deprecated removed in W5b2; callers go in the writers/links helpers. */
export function levelAbove(a: ViewerLevel, b: ViewerLevel): boolean {
  return RANK[a] > RANK[b];
}

/** @deprecated removed in W5b2 (no-op: nothing follows an item any more);
 *  callers go in the writers/links helpers. */
export async function embedClosure(
  _ownerId: string,
  _nodeId: string,
  _q: ClosureDb = db,
): Promise<EmbedItem[]> {
  return [];
}

/** @deprecated removed in W5b2 (no-op); callers go in the writers/links helpers. */
export async function brainEmbedsOf(
  _brainId: string,
  _fromOwnerId: string,
  _items: readonly { id: string; type: string }[],
  _q: ClosureDb = db,
  _exclude: readonly string[] = [],
): Promise<EmbedItem[]> {
  return [];
}

/** @deprecated removed in W5b2 (no-op: an embed keeps its grants); callers go
 *  in the writers/links helpers. */
export async function lowerEmbedClosure(
  _ownerId: string,
  _nodeId: string,
  _level: ViewerLevel,
  _q: ClosureDb = db,
): Promise<LowerEmbedsResult> {
  return { lowered: [], ceiling: [] };
}

/** @deprecated removed in W5b2 (no-op: there is no closure to close); callers
 *  go in the writers/links helpers. */
export async function findEmbedClosureGaps(
  _ownerId: string,
  _q: ClosureDb = db,
): Promise<EmbedClosureGap[]> {
  return [];
}
