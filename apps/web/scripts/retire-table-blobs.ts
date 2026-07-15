/**
 * Tables v2 release N+1 — retire the legacy JSONB blobs (plan §9).
 *
 * For every FILE-BACKED table, verify the workbook file against the registry
 * (file present, row count matches stats), then null out `data`/`draft_data`
 * and truncate `data_text`? NO — data_text stays (list ILIKE + extractor read
 * it). Only the doc blobs (`data`, `draft_data`) are nulled; they have been
 * dual-written mirrors since P1 and list/search stopped reading them.
 *
 * DRY-RUN BY DEFAULT — prints what it would do. Run with --apply to write.
 * Never touches legacy tables (storage_path IS NULL) — the sweep converts
 * those first. Reversible until run: rollback = clear storage_path.
 *
 *   pnpm -C apps/web exec tsx scripts/retire-table-blobs.ts [--apply]
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { db, nodes, tables } from '@mantle/db';
import { fileStats, resolveStoragePath } from '@mantle/tabledb';
import { existsSync } from 'node:fs';

async function main() {
  const apply = process.argv.includes('--apply');
  const rows = await db
    .select({ nodeId: tables.nodeId, storagePath: tables.storagePath, stats: tables.stats, title: nodes.title })
    .from(tables)
    .innerJoin(nodes, eq(nodes.id, tables.nodeId))
    .where(and(eq(nodes.type, 'table'), isNotNull(tables.storagePath)));

  let ok = 0;
  let skipped = 0;
  for (const r of rows) {
    let verdict = '';
    try {
      const abs = resolveStoragePath(r.storagePath!);
      if (!existsSync(abs)) verdict = 'FILE MISSING — restore from backup first';
      else {
        const live = fileStats(abs);
        const reg = r.stats as { totalRows?: number } | null;
        if (reg?.totalRows !== undefined && reg.totalRows !== live.totalRows) {
          verdict = `stats mismatch (registry ${reg.totalRows} vs file ${live.totalRows}) — recommit to refresh`;
        }
      }
    } catch (err) {
      verdict = err instanceof Error ? err.message : String(err);
    }
    if (verdict) {
      skipped++;
      console.log(`  ✗ SKIP ${r.nodeId} (${r.title.slice(0, 40)}): ${verdict}`);
      continue;
    }
    ok++;
    if (apply) {
      await db
        .update(tables)
        .set({ data: {}, draftData: null })
        .where(eq(tables.nodeId, r.nodeId));
      console.log(`  ✓ retired blobs for ${r.nodeId} (${r.title.slice(0, 40)})`);
    } else {
      console.log(`  · would retire blobs for ${r.nodeId} (${r.title.slice(0, 40)})`);
    }
  }
  console.log(
    `\n${apply ? 'Retired' : 'Would retire'} ${ok} table(s); ${skipped} skipped (fix + re-run).` +
      (apply ? '' : ' Re-run with --apply to write.'),
  );
  await db.execute(sql`select 1`); // keep types happy about usage
  process.exit(skipped > 0 ? 2 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
