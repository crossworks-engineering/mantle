/**
 * Backfill entity↔entity relations across already-ingested history.
 *
 * Relations were added to the extractor after most content was ingested, so
 * old nodes have entities + facts but no relation edges. This re-fires
 * `node_ingested` for nodes that have entity mentions but zero relations,
 * running them back through the (now relations-aware) extractor — the SAME
 * production path, so quality + dedup + provenance are identical to fresh
 * ingest. No separate, lower-quality triple extractor to maintain.
 *
 * COST: re-firing clears `data.summary` to pass the already-extracted guard,
 * which triggers a FULL re-extract per node (summary + embedding + facts +
 * relations). That's real LLM spend. Hence: DRY-RUN by default — it prints the
 * candidate count and exits. Pass --go to actually fire. Scope with --types /
 * --limit / --since to start small (e.g. cheap notes/contacts before 1000s of
 * emails) and --rate to pace the LLM load.
 *
 * Usage:
 *   tsx scripts/relations-backfill.ts                       # dry-run: count only
 *   tsx scripts/relations-backfill.ts --go --types=note,contact
 *   tsx scripts/relations-backfill.ts --go --limit=100 --rate=2
 *
 * The agent (server/api) must be running — it's the LISTENer that extracts.
 */
import postgres from 'postgres';
import { eq, sql as drizzleSql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { env } from '@mantle/config';
import { nodes } from '@mantle/db';

const DATABASE_URL = env('DATABASE_URL');
if (!DATABASE_URL) {
  console.error('relations-backfill: DATABASE_URL must be set');
  process.exit(1);
}

type Args = {
  go: boolean;
  types: string[] | null;
  since: Date | null;
  limit: number | null;
  rateSec: number;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { go: false, types: null, since: null, limit: null, rateSec: 1.5 };
  for (const arg of argv) {
    if (arg === '--go') out.go = true;
    else if (arg.startsWith('--types=')) {
      out.types = arg
        .slice('--types='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg.startsWith('--since=')) {
      const d = new Date(arg.slice('--since='.length));
      if (!isNaN(d.getTime())) out.since = d;
    } else if (arg.startsWith('--limit=')) {
      const n = parseInt(arg.slice('--limit='.length), 10);
      if (!Number.isNaN(n)) out.limit = n;
    } else if (arg.startsWith('--rate=')) {
      const n = parseFloat(arg.slice('--rate='.length));
      if (!Number.isNaN(n)) out.rateSec = n;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sql = postgres(DATABASE_URL!, { max: 2 });

  // Candidates: nodes with at least one `mentioned_in` edge (so the extractor
  // found entities) but no edge stamped with their source_node_id (no relation
  // pass has run on them).
  // --types, --since and --limit each add their clause only when given.
  const rows = await sql<Array<{ id: string; type: string; title: string }>>`
    select n.id, n.type, n.title from nodes n
     where n.id in (select target_id from entity_edges where target_kind='node' and relation='mentioned_in')
       and n.id not in (select (data->>'source_node_id')::uuid from entity_edges where data ? 'source_node_id')
       ${args.types && args.types.length > 0 ? sql`and n.type::text = any(${args.types})` : sql``}
       ${args.since ? sql`and n.created_at >= ${args.since}` : sql``}
     order by n.created_at desc
     ${args.limit ? sql`limit ${args.limit}` : sql``}`;
  console.log(
    `[relations-backfill] ${rows.length} candidate node(s)` +
      `${args.types ? ` (types: ${args.types.join(',')})` : ''}` +
      `${args.limit ? ` (limited to ${args.limit})` : ''}.`,
  );

  if (!args.go) {
    console.log(
      '[relations-backfill] DRY RUN — pass --go to clear summaries + re-fire. No changes made.',
    );
    await sql.end();
    return;
  }
  if (rows.length === 0) {
    await sql.end();
    return;
  }

  console.log(
    `[relations-backfill] firing at ${args.rateSec}s intervals — each is a full re-extract.`,
  );
  // A typed write on the same connection. drizzle sets the client's date
  // parsers to pass text through, so it is made after the read above.
  const db = drizzle(sql);
  let i = 0;
  for (const row of rows) {
    i++;
    // Clear summary so the extractor's already-extracted guard lets it re-run.
    await db
      .update(nodes)
      .set({ data: drizzleSql`${nodes.data} - 'summary'` })
      .where(eq(nodes.id, row.id));
    await sql`select pg_notify('node_ingested', ${row.id}::text)`;
    if (i % 25 === 0 || i === rows.length) {
      console.log(`[relations-backfill] (${i}/${rows.length}) fired`);
    }
    if (i < rows.length) await new Promise((r) => setTimeout(r, args.rateSec * 1000));
  }
  console.log(
    `[relations-backfill] done. ${rows.length} fired. Watch the agent logs / /debug/journey.`,
  );
  await sql.end();
}

main().catch((err) => {
  console.error('[relations-backfill] fatal:', err);
  process.exit(1);
});
