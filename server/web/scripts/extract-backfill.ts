/**
 * Backfill the content_index by re-firing `node_ingested` notifications
 * for existing nodes that don't have a summary or embedding yet.
 *
 * Usage:
 *   pnpm extract:backfill                        # all nodes missing index
 *   pnpm extract:backfill --types=note,file      # restrict by type
 *   pnpm extract:backfill --since=2025-01-01     # restrict by created_at
 *   pnpm extract:backfill --limit=100            # cap total per run
 *   pnpm extract:backfill --rate=2               # seconds between notifies
 *
 * The agent (server/api) must be running — it's the LISTENer that picks
 * up each notify and runs the extractor. This script just feeds the queue.
 *
 * Idempotent: nodes that already have data.summary + embedding are
 * skipped by the extractor itself (it short-circuits on existing state).
 */

import postgres from 'postgres';
import { env } from '@mantle/config';

const DATABASE_URL = env('DATABASE_URL');
if (!DATABASE_URL) {
  console.error('extract-backfill: DATABASE_URL must be set');
  process.exit(1);
}

type Args = {
  types: string[] | null;
  since: Date | null;
  limit: number | null;
  rateSec: number;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { types: null, since: null, limit: null, rateSec: 1 };
  for (const arg of argv) {
    if (arg.startsWith('--types=')) {
      out.types = arg
        .slice('--types='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg.startsWith('--since=')) {
      const v = arg.slice('--since='.length);
      const d = new Date(v);
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

  console.log('[backfill] settings:', {
    types: args.types ?? '(all)',
    since: args.since?.toISOString() ?? '(any)',
    limit: args.limit ?? '(none)',
    rate: `${args.rateSec}s between notifies`,
  });

  // Find candidates. "Missing index" means either data.summary is absent OR
  // embedding is NULL. Exclude branch + secret (HARD_SKIP in the extractor).
  // --types, --since and --limit each add their clause only when given.
  const rows = await sql<Array<{ id: string; type: string; title: string }>>`
    select id, type, title from nodes
     where type <> 'branch' and type <> 'secret'
       and (data->>'summary' is null or embedding is null)
       ${args.types && args.types.length > 0 ? sql`and type::text = any(${args.types})` : sql``}
       ${args.since ? sql`and created_at >= ${args.since}` : sql``}
     order by created_at desc
     ${args.limit ? sql`limit ${args.limit}` : sql``}`;
  console.log(`[backfill] found ${rows.length} candidate nodes`);

  if (rows.length === 0) {
    await sql.end();
    return;
  }

  let i = 0;
  for (const row of rows) {
    i++;
    await sql`select pg_notify('node_ingested', ${row.id}::text)`;
    console.log(
      `[backfill] (${i}/${rows.length}) ${row.type} ${row.id.slice(0, 8)} — ${row.title.slice(0, 60)}`,
    );
    if (i < rows.length) {
      await new Promise((r) => setTimeout(r, args.rateSec * 1000));
    }
  }

  console.log(
    `[backfill] done. ${rows.length} notifications fired. The agent is now processing them — watch its logs.`,
  );

  await sql.end();
}

main().catch((err) => {
  console.error('[backfill] fatal:', err);
  process.exit(1);
});
