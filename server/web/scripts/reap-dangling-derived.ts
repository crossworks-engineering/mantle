/**
 * Operator backfill: reap DANGLING derived nodes — nodes whose
 * `data.sourceFileId` points at a node that no longer exists, i.e. the
 * sediment left by every file deleted before the reap-on-delete path shipped.
 * The `dangling_source_file` check at /debug/integrity counts the same rows
 * read-only; this script is the remedy.
 *
 * NEVER runs automatically, and dry-run by default: it prints per-source
 * bucket counts plus SAMPLE rows so the operator can tell true orphans from
 * nodes a user has since adopted (a page someone kept editing after deleting
 * its source ebook is real content — inspect the samples before applying).
 *
 *   ALLOWED_USER_ID=<uuid> pnpm -C server/web reap:dangling-derived
 *   ... --apply                     # actually delete
 *   ... --apply --keep-pages-notes  # only images + tables; pages/notes stay
 *
 * Apply routes through `reapDerivedFromFile` — the exact per-kind dispatch the
 * delete path uses (images via deleteFileById with their disk bytes, tables
 * via deleteTable with registry + workbook files, pages/notes via their own
 * delete functions, then the emptied per-document extracted-images folders).
 * The 0058/0059 reaper triggers fire per node as usual. No LLM call anywhere.
 */

import { db, closeDb } from '@mantle/db';
import { sql } from 'drizzle-orm';
import { reapDerivedFromFile } from '@mantle/content';
import { env } from '@mantle/config';

const OWNER_ID = env('ALLOWED_USER_ID');
if (!OWNER_ID) {
  console.error('reap-dangling-derived: ALLOWED_USER_ID must be set');
  process.exit(1);
}
const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const keepPagesNotes = argv.includes('--keep-pages-notes');

const SAMPLES_PER_SOURCE = 5;

type DanglingRow = {
  id: string;
  type: string;
  title: string;
  source_file_id: string;
  created_at: string;
};

async function main() {
  const rows = (await db.execute<DanglingRow>(sql`
      SELECT n.id, n.type::text AS type, coalesce(n.title, '') AS title,
             n.data->>'sourceFileId' AS source_file_id,
             n.created_at::date::text AS created_at
      FROM nodes n
      WHERE n.owner_id = ${OWNER_ID}
        AND nullif(n.data->>'sourceFileId', '') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM nodes s
          WHERE s.owner_id = ${OWNER_ID} AND s.id::text = n.data->>'sourceFileId'
        )
      ORDER BY n.data->>'sourceFileId', n.created_at
    `)) as unknown as DanglingRow[];

  if (rows.length === 0) {
    console.log('No dangling derived nodes — nothing to do.');
    return;
  }

  const bySource = new Map<string, DanglingRow[]>();
  for (const row of rows) {
    const list = bySource.get(row.source_file_id) ?? [];
    list.push(row);
    bySource.set(row.source_file_id, list);
  }

  console.log(
    `${rows.length} dangling derived node(s) across ${bySource.size} vanished source file(s)` +
      (keepPagesNotes ? ' (pages/notes will be KEPT)' : ''),
  );
  for (const [sourceId, list] of bySource) {
    const byType = new Map<string, number>();
    for (const r of list) byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
    const summary = [...byType.entries()].map(([t, n]) => `${n} ${t}`).join(', ');
    console.log(`\nsource ${sourceId} (gone): ${summary}`);
    for (const r of list.slice(0, SAMPLES_PER_SOURCE)) {
      console.log(`  SAMPLE ${r.type} ${r.id} ${r.created_at} ${r.title.slice(0, 60)}`);
    }
    if (list.length > SAMPLES_PER_SOURCE) {
      console.log(`  … and ${list.length - SAMPLES_PER_SOURCE} more`);
    }
  }

  if (!apply) {
    console.log(
      '\nDry run — nothing deleted. Inspect the samples (an adopted page or note is real content), then re-run with --apply.',
    );
    return;
  }

  let reapedTotal = 0;
  let skippedTotal = 0;
  for (const sourceId of bySource.keys()) {
    const { reaped, skipped } = await reapDerivedFromFile(OWNER_ID!, sourceId, {
      types: keepPagesNotes ? ['file', 'table'] : undefined,
    });
    reapedTotal += reaped.total;
    skippedTotal += skipped;
  }
  console.log(`\nDeleted ${reapedTotal} node(s); ${skippedTotal} skipped (still audit-visible).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
