/**
 * Tables v2 — merge legacy "(part N/M)" tables (plan §7's cleanup utility).
 *
 * Pre-v2 imports split big sheets into sibling tables titled
 * "<name> (part 1/M)" … "(part M/M)". Part-splitting is dead; this merges
 * each family back into ONE table: rows of parts 2..M append to part 1 (in
 * part order), part 1 is renamed to the bare name and committed (file-backed,
 * FTS, re-indexed), and parts 2..M are DELETED.
 *
 * DRY-RUN BY DEFAULT — prints the families it found. --apply to merge.
 * Requires identical column names/types across a family; mismatches skip.
 *
 *   pnpm -C apps/web exec tsx scripts/merge-part-tables.ts [--apply]
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import { applyTableOps, commitTable, deleteTable, getTable, updateTable } from '@mantle/content';
import type { TableOp } from '@mantle/tabledb';

const PART_RE = /^(.*) \(part (\d+)\/(\d+)\)$/;

async function main() {
  const apply = process.argv.includes('--apply');
  const rows = await db
    .select({ id: nodes.id, ownerId: nodes.ownerId, title: nodes.title })
    .from(nodes)
    .where(and(eq(nodes.type, 'table'), sql`${nodes.title} ~ ' \\(part \\d+/\\d+\\)$'`));

  const families = new Map<
    string,
    { base: string; total: number; parts: { id: string; ownerId: string; part: number }[] }
  >();
  for (const r of rows) {
    const m = PART_RE.exec(r.title);
    if (!m) continue;
    const key = `${r.ownerId}:${m[1]}:${m[3]}`;
    const fam = families.get(key) ?? { base: m[1]!, total: Number(m[3]), parts: [] };
    fam.parts.push({ id: r.id, ownerId: r.ownerId, part: Number(m[2]) });
    families.set(key, fam);
  }

  for (const fam of families.values()) {
    fam.parts.sort((a, b) => a.part - b.part);
    const complete = fam.parts.length === fam.total && fam.parts[0]!.part === 1;
    console.log(
      `\nfamily "${fam.base}": ${fam.parts.length}/${fam.total} parts${complete ? '' : ' (INCOMPLETE — skipped)'}`,
    );
    if (!complete) continue;

    const head = await getTable(fam.parts[0]!.ownerId, fam.parts[0]!.id);
    if (!head) continue;
    const headCols = head.data.columns.map((c) => `${c.name}:${c.type}`).join('|');
    let merged = head.rowCount;
    let mismatch = false;
    for (const part of fam.parts.slice(1)) {
      const t = await getTable(part.ownerId, part.id);
      if (!t || t.data.columns.map((c) => `${c.name}:${c.type}`).join('|') !== headCols) {
        console.log(`  ✗ part ${part.part} column mismatch — family skipped`);
        mismatch = true;
        break;
      }
      merged += t.rowCount;
      if (!apply) continue;
      // Append this part's rows to the head table's draft, mapping cells by
      // COLUMN POSITION (ids differ across parts; names/types verified equal).
      const colMap = new Map(t.data.columns.map((c, i) => [c.id, head.data.columns[i]!.id]));
      const ops: TableOp[] = t.data.rows.map((r) => ({
        op: 'row_add',
        cells: Object.fromEntries(
          Object.entries(r.cells).flatMap(([cid, v]) =>
            colMap.has(cid) ? [[colMap.get(cid)!, v]] : [],
          ),
        ),
      }));
      for (let i = 0; i < ops.length; i += 500) {
        const res = await applyTableOps(part.ownerId, fam.parts[0]!.id, ops.slice(i, i + 500));
        if (!res || !res.ok)
          throw new Error(`append failed for part ${part.part} of "${fam.base}"`);
      }
    }
    if (mismatch) continue;
    if (!apply) {
      console.log(
        `  · would merge into one ${merged}-row table "${fam.base}" and delete ${fam.parts.length - 1} part(s)`,
      );
      continue;
    }
    await commitTable(fam.parts[0]!.ownerId, fam.parts[0]!.id);
    await updateTable(fam.parts[0]!.ownerId, fam.parts[0]!.id, { title: fam.base });
    for (const part of fam.parts.slice(1)) await deleteTable(part.ownerId, part.id);
    console.log(
      `  ✓ merged ${merged} rows into "${fam.base}"; deleted ${fam.parts.length - 1} part table(s)`,
    );
  }
  if (families.size === 0) console.log('No "(part N/M)" tables found — nothing to merge.');
  if (!apply && families.size > 0) console.log('\nDry run. Re-run with --apply to merge.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
