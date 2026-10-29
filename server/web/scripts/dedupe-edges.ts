/**
 * Collapse duplicate entity edges left by an older, non-idempotent
 * extractor, which APPENDED a `mentioned_in` edge on every (re)extract, so re-edited content piled up duplicate
 * `entity --mentioned_in--> node` rows. Going forward the extractor rebuilds
 * them (delete-then-insert) so no new dupes appear; this script cleans the
 * historical ones in a single pass — no LLM calls, just SQL.
 *
 * It keeps the EARLIEST row per logical edge and deletes the rest. Scoped to
 * `mentioned_in` by design: that's the relation the extractor appends, and one
 * where the duplicate rows differ only by their `valid_from` timestamp (a
 * mention is a mention). Other relations (married_to, works_at, …) can carry
 * MEANINGFUL temporal duplicates — same source/target over different validity
 * periods — so they are NOT touched unless you explicitly pass --relation.
 *
 * Usage:
 *   pnpm dedupe:edges                 # DRY RUN — report only, deletes nothing
 *   pnpm dedupe:edges --apply         # actually delete the duplicates
 *   pnpm dedupe:edges --relation=foo  # a different relation (understand the
 *                                     # temporal caveat above first)
 *
 * Idempotent: once clean, it's a no-op.
 */

import postgres from 'postgres';
import { sql as drizzleSql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { env } from '@mantle/config';
import { entityEdges } from '@mantle/db';

const DATABASE_URL = env('DATABASE_URL');
if (!DATABASE_URL) {
  console.error('dedupe-edges: DATABASE_URL must be set');
  process.exit(1);
}

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const relationArg = argv.find((a) => a.startsWith('--relation='));
const relation = relationArg ? relationArg.slice('--relation='.length) : 'mentioned_in';

// The grouping that defines "the same edge" is the `partition by` list of
// both statements below (owner_id, source_id, source_kind, target_id,
// target_kind, relation). valid_from / valid_to are deliberately excluded so
// re-extract artifacts (which differ only by valid_from) collapse (see the
// temporal caveat in the header). Keep the two lists the same.

async function main() {
  const sql = postgres(DATABASE_URL!, { max: 1 });

  if (relation !== 'mentioned_in') {
    console.warn(
      `[dedupe] ⚠ relation='${relation}' is not 'mentioned_in'. If this relation uses\n` +
        `         valid_from/valid_to to model distinct time periods, collapsing rows\n` +
        `         will DESTROY that history. Make sure you understand the data first.`,
    );
  }

  const total = await sql`
    select count(*)::int as n from entity_edges where relation = ${relation}
  `;
  const totalRows = total[0]?.n ?? 0;

  // Rows that would be deleted = every row beyond the earliest in each group.
  const dupRows = await sql`
    select count(*)::int as n
    from (
      select id,
             row_number() over (
               partition by owner_id, source_id, source_kind, target_id, target_kind, relation
               order by created_at asc, id asc
             ) as rn
      from entity_edges
      where relation = ${relation}
    ) ranked
    where rn > 1
  `;
  const toDelete = dupRows[0]?.n ?? 0;

  console.log(
    `[dedupe] relation='${relation}': ${totalRows} edges, ${toDelete} duplicate(s) to remove`,
  );

  if (toDelete === 0) {
    console.log('[dedupe] nothing to do — already clean.');
    await sql.end();
    return;
  }

  if (!apply) {
    console.log('[dedupe] DRY RUN — pass --apply to delete the duplicates above.');
    await sql.end();
    return;
  }

  // The delete is a typed write on a client of its own: drizzle sets its
  // client's date parsers to pass text through, which would change a read
  // on the script's client.
  const writer = postgres(DATABASE_URL!, { max: 1 });
  const db = drizzle(writer);
  const deleted = await db
    .delete(entityEdges)
    .where(
      drizzleSql`${entityEdges.id} in (
      select id from (
        select id,
               row_number() over (
                 partition by owner_id, source_id, source_kind, target_id, target_kind, relation
                 order by created_at asc, id asc
               ) as rn
        from entity_edges
        where relation = ${relation}
      ) ranked
      where rn > 1
    )`,
    )
    .returning({ id: entityEdges.id });
  console.log(`[dedupe] deleted ${deleted.length} duplicate edge(s); kept the earliest of each.`);
  await writer.end();
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
