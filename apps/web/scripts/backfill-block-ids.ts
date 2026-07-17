/**
 * One-shot backfill: persist stable per-block ids on every existing page.
 *
 * Phase 2b shipped lazy-backfill in `getPage` (in-memory enrichment that
 * persists on the next read, see pages.ts), but pages never read since
 * the rollout still carry no ids in the DB. This script forces the issue
 * — walk every page, enrich, write back — so the page_blocks_list tool
 * returns stable ids on every call from the first turn the agent makes,
 * even on pages the user hasn't opened.
 *
 * Idempotent: ensureBlockIds returns the SAME doc reference when nothing
 * needs adding, so a second run is free (no writes, no LLM activity, no
 * notifyNodeIngested). Reports per-page progress + final summary.
 *
 * Usage:
 *   pnpm -C apps/web backfill:block-ids
 *   pnpm -C apps/web backfill:block-ids --dry      (count only, no writes)
 */

import { eq } from 'drizzle-orm';
import { db, nodes, pages } from '@mantle/db';
import { ensureBlockIds } from '@mantle/content/block-ids';

const DRY = process.argv.includes('--dry');

async function main() {
  const rows = await db
    .select({
      nodeId: nodes.id,
      title: nodes.title,
      doc: pages.doc,
      draftDoc: pages.draftDoc,
    })
    .from(nodes)
    .innerJoin(pages, eq(pages.nodeId, nodes.id))
    .where(eq(nodes.type, 'page'));

  let scanned = 0;
  let docsEnriched = 0;
  let draftsEnriched = 0;
  let wrote = 0;

  for (const row of rows) {
    scanned++;
    const rawDoc = (row.doc as Record<string, unknown> | null) ?? null;
    const rawDraft = (row.draftDoc as Record<string, unknown> | null) ?? null;
    if (!rawDoc) {
      // Page row with no doc (shouldn't happen — pages.doc is NOT NULL —
      // but defensive: skip rather than insert a bogus empty doc).
      continue;
    }
    const newDoc = ensureBlockIds(rawDoc);
    const newDraft = rawDraft ? ensureBlockIds(rawDraft) : null;
    const docChanged = newDoc !== rawDoc;
    const draftChanged = newDraft !== rawDraft && rawDraft !== null;
    if (!docChanged && !draftChanged) {
      continue;
    }
    if (docChanged) docsEnriched++;
    if (draftChanged) draftsEnriched++;

    const flags = `${docChanged ? 'doc' : ''}${docChanged && draftChanged ? '+' : ''}${draftChanged ? 'draft' : ''}`;
    console.log(`  [${scanned}/${rows.length}] +${flags}  ${row.title.slice(0, 60)}`);

    if (!DRY) {
      const patch: Record<string, unknown> = {};
      if (docChanged) patch.doc = newDoc;
      if (draftChanged) patch.draftDoc = newDraft;
      // Note: deliberately NO updatedAt bump and NO notifyNodeIngested.
      // This is maintenance — same content, just addressable. The extractor
      // doesn't need to re-run; the brain index is unaffected.
      await db.update(pages).set(patch).where(eq(pages.nodeId, row.nodeId));
      wrote++;
    }
  }

  console.log('');
  console.log(`[backfill] scanned ${scanned} pages`);
  console.log(`[backfill]   docs needing ids: ${docsEnriched}`);
  console.log(`[backfill]   drafts needing ids: ${draftsEnriched}`);
  console.log(`[backfill]   wrote: ${wrote}${DRY ? ' (dry run — no writes)' : ''}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[backfill] failed:', err);
  process.exit(1);
});
