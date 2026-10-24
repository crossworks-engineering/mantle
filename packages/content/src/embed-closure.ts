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
import type { AccessLevel } from '@mantle/client-types';
import { EMBEDDING_KINDS as REGISTRY_EMBEDDING_KINDS } from '@mantle/client-types/kind-lists';
import { markdownToDoc } from '@mantle/content-core/markdown';
import { referencedDrawIds, referencedFileIds, referencedPresentIds } from './doc-assets';

/** The kinds that embed other items: the kind registry's `embeds` field
 *  (A10 #12). */
export const EMBEDDING_KINDS: readonly string[] = REGISTRY_EMBEDDING_KINDS;

/** What a note's markdown embeds: images, file embeds, drawings and
 *  canvases. (A
 *  `page:` link in a note is a link, not a child page.) */
export function noteEmbedIds(markdown: string): string[] {
  if (!markdown) return [];
  const doc = markdownToDoc(markdown);
  return [
    ...new Set([
      ...referencedFileIds(doc),
      ...referencedDrawIds(doc),
      ...referencedPresentIds(doc),
    ]),
  ];
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

// ── Deprecated type ──────────────────────────────────────────────────────────
// Removed in W5b2: the embed closure no longer lowers anything. The member
// review accept that used the other no-ops was removed in W5c; this type
// keeps the share tool's answer compiling.

/** @deprecated removed in W5b2; callers go in the writers/links helpers. */
export type LoweredItem = {
  id: string;
  type: string;
  title: string;
  from: AccessLevel;
  to: AccessLevel;
};
