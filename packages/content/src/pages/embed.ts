/**
 * Pages · embedded-asset text.
 *
 * `docToText` only surfaces an embed's FILENAME, so without this a page is
 * blind to what is inside its own images, document chips and drawings. The
 * commit path folds this text into `doc_text`, which both the extractor
 * (summary / embedding / facts) and FTS read.
 *
 * Pure fold + one bounded read. Depends on nothing else under pages/.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db, draws, nodes } from '@mantle/db';
import { referencedDrawIds, referencedFileIds } from '../doc-assets';

/** Max chars of a single embedded file's extracted text folded into a page. */
export const EMBED_TEXT_PER_FILE = 4000;
/** Max total chars of embedded-asset text appended to a page's doc_text. */
export const EMBED_TEXT_TOTAL = 16000;

/**
 * Fold an ordered list of embedded files' extracted text into one bounded
 * plaintext block. Pure (no DB) so the bounds/format are unit-testable: each
 * file is capped at `perFile`, the whole block at `total`, empty/whitespace
 * text is skipped, and order is preserved (diff-friendly).
 */
export function foldEmbeddedText(
  items: { title: string; text: string | null | undefined; label?: string }[],
  perFile = EMBED_TEXT_PER_FILE,
  total = EMBED_TEXT_TOTAL,
): string {
  const parts: string[] = [];
  let budget = total;
  for (const it of items) {
    const text = it.text?.trim();
    if (!text) continue;
    const slice = text.slice(0, Math.min(perFile, budget));
    if (!slice) break;
    parts.push(`[${it.label ?? 'Embedded file'}: ${it.title}]\n${slice}`);
    budget -= slice.length;
    if (budget <= 0) break;
  }
  return parts.join('\n\n');
}

/**
 * Plaintext of the files a page embeds — images (vision describe + OCR) and
 * document chips (parsed text). `docToText` only surfaces an embed's filename,
 * so without this the page is blind to what's *inside* its own images/docs.
 *
 * Each referenced `file` node's durable `data.text` (written once by the
 * universal file extractor — see extractor.ts §image/document ingest) is folded
 * into the page's `doc_text`, which both the extractor (summary/embedding/facts)
 * and FTS read. A referenced file whose own extraction hasn't landed yet is
 * simply skipped — the next commit picks it up; we deliberately do NOT add a
 * reactive re-extract trigger (keeps cost bounded, per the no-runaway rule).
 */
export async function embeddedAssetText(ownerId: string, doc: unknown): Promise<string> {
  const ids = referencedFileIds(doc);
  const drawIds = referencedDrawIds(doc);
  if (ids.length === 0 && drawIds.length === 0) return '';

  const rows = ids.length
    ? await db
        .select({ id: nodes.id, title: nodes.title, data: nodes.data })
        .from(nodes)
        .where(and(eq(nodes.ownerId, ownerId), inArray(nodes.id, ids), eq(nodes.type, 'file')))
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Embedded drawings fold their committed `scene_text` (which already carries
  // the drawing's own images' OCR — see draws.ts embeddedAssetText), so a term
  // that appears only inside an embedded diagram still finds the page. Drafts
  // never leak: scene_text is recomputed on commit only. Pure SQL, bounded by
  // the same fold budget — no extraction is triggered here.
  const drawRows = drawIds.length
    ? await db
        .select({ id: draws.nodeId, title: nodes.title, text: draws.sceneText })
        .from(draws)
        .innerJoin(nodes, eq(nodes.id, draws.nodeId))
        .where(and(eq(nodes.ownerId, ownerId), inArray(draws.nodeId, drawIds)))
    : [];
  const byDrawId = new Map(drawRows.map((r) => [r.id, r]));

  // Map doc embed-order → {title, text}, preserving order; skip unresolved ids.
  const items = [
    ...ids
      .map((id) => byId.get(id))
      .filter((r): r is NonNullable<typeof r> => !!r)
      .map((r) => ({
        title: r.title,
        text: (r.data as Record<string, unknown> | null)?.text as string | undefined,
      })),
    ...drawIds
      .map((id) => byDrawId.get(id))
      .filter((r): r is NonNullable<typeof r> => !!r)
      .map((r) => ({ title: r.title, text: r.text, label: 'Embedded drawing' })),
  ];
  return foldEmbeddedText(items);
}
