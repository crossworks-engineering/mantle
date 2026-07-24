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
 * The agent (apps/agent) must be running — it's the LISTENer that extracts.
 */
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
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
  const conds: string[] = [
    `n.id in (select target_id from entity_edges where target_kind='node' and relation='mentioned_in')`,
    `n.id not in (select (data->>'source_node_id')::uuid from entity_edges where data ? 'source_node_id')`,
  ];
  const params: Array<string | string[] | Date | number> = [];
  if (args.types && args.types.length > 0) {
    conds.push(`n.type::text = any($${params.length + 1})`);
    params.push(args.types);
  }
  if (args.since) {
    conds.push(`n.created_at >= $${params.length + 1}`);
    params.push(args.since);
  }
  let q = `select n.id, n.type, n.title from nodes n where ${conds.join(' and ')} order by n.created_at desc`;
  if (args.limit) {
    q += ` limit $${params.length + 1}`;
    params.push(args.limit);
  }

  const rows = (await sql.unsafe(q, params)) as Array<{ id: string; type: string; title: string }>;
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
  let i = 0;
  for (const row of rows) {
    i++;
    // Clear summary so the extractor's already-extracted guard lets it re-run.
    await sql`update nodes set data = data - 'summary' where id = ${row.id}`;
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
