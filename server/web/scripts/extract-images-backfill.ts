/**
 * Backfill embedded-image extraction across documents already in the brain.
 *
 * Documents ingested before this feature existed kept their diagrams and
 * screenshots locked inside the binary. This re-fires `node_ingested` for
 * every document that could carry pictures and hasn't produced any yet; the
 * extractor's `maybeExtractEmbeddedImages` pass does the rest.
 *
 * Usage:
 *   pnpm -C server/web extract:images-backfill                # DRY RUN — counts only
 *   pnpm -C server/web extract:images-backfill --go           # actually fire
 *   pnpm -C server/web extract:images-backfill --go --limit=50
 *   pnpm -C server/web extract:images-backfill --go --rate=2  # seconds between notifies
 *   pnpm -C server/web extract:images-backfill --types=pdf,docx
 *
 * ## What this costs
 *
 * Re-notifying a document that is already indexed does NOT re-run its text
 * extraction: the image pass sits ahead of the extractor's
 * `already_extracted` guard, so the summary/embedding/facts work short-
 * circuits exactly as it does today. The parent documents are therefore free.
 *
 * The real spend is downstream and unavoidable: every image saved becomes an
 * image node the vision worker will describe — one call each. The gate in
 * `@mantle/files/embedded-images` (dimensions, byte floor, duplicate collapse)
 * and the 30-per-document cap bound it, but on a large corpus this is still
 * real money. That is why the script is dry-run by default and prints an
 * upper bound before you commit to it.
 *
 * The agent (server/api) must be running — it's the LISTENer that picks each
 * notification up. This script only feeds the queue, which is durable and
 * concurrency-capped, so a large backfill drains steadily rather than
 * stampeding the provider.
 *
 * Idempotent: a document that already produced images is skipped by the
 * candidate query AND again by the extractor's own `sourceFileId` dedupe, so
 * re-running never doubles.
 */

import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('extract-images-backfill: DATABASE_URL must be set');
  process.exit(1);
}

/** Must stay in step with IMAGE_BEARING_EXTS in the extractor — a doc listed
 *  here but not there just wastes a notify (harmless); the reverse means a
 *  format silently never gets backfilled. */
const DEFAULT_EXTS = [
  'docx',
  'pdf',
  'pptx',
  'xlsx',
  'xlsm',
  'odt',
  'ods',
  'odp',
  'doc',
  'ppt',
  'xls',
  'xlsb',
  'rtf',
];

/** Worst case per document, from MAX_EMBEDDED_IMAGES_PER_DOC. Used only for
 *  the upper-bound estimate printed in the dry run. */
const MAX_IMAGES_PER_DOC = 30;

type Args = { go: boolean; limit: number | null; rateSec: number; exts: string[] };

function parseArgs(argv: string[]): Args {
  const out: Args = { go: false, limit: null, rateSec: 1, exts: DEFAULT_EXTS };
  for (const arg of argv) {
    if (arg === '--go') out.go = true;
    else if (arg.startsWith('--limit=')) {
      const n = parseInt(arg.slice('--limit='.length), 10);
      if (!Number.isNaN(n)) out.limit = n;
    } else if (arg.startsWith('--rate=')) {
      const n = parseFloat(arg.slice('--rate='.length));
      if (!Number.isNaN(n)) out.rateSec = n;
    } else if (arg.startsWith('--types=')) {
      const list = arg
        .slice('--types='.length)
        .split(',')
        .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
        .filter(Boolean);
      if (list.length > 0) out.exts = list;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sql = postgres(DATABASE_URL!, { max: 2 });

  console.log('[images-backfill] settings:', {
    mode: args.go ? 'LIVE' : 'DRY RUN (pass --go to fire)',
    types: args.exts.join(','),
    limit: args.limit ?? '(none)',
    rate: `${args.rateSec}s between notifies`,
  });

  const extPattern = `\\.(${args.exts.join('|')})$`;
  const params: Array<string | number> = [extPattern];
  let q = `
    select n.id, n.title, coalesce(n.data->>'filename', n.title) as filename
    from nodes n
    where n.type = 'file'
      and lower(coalesce(n.data->>'filename', n.title)) ~ $1
      -- never re-open an image we ourselves extracted
      and n.data->>'sourceFileId' is null
      -- and skip anything that already yielded pictures
      and not exists (
        select 1 from nodes c
        where c.owner_id = n.owner_id
          and c.type = 'file'
          and c.data->>'sourceFileId' = n.id::text
      )
    order by n.created_at desc`;
  if (args.limit) {
    q += ` limit $2`;
    params.push(args.limit);
  }

  const rows = (await sql.unsafe(q, params)) as Array<{
    id: string;
    title: string;
    filename: string;
  }>;

  const byExt = new Map<string, number>();
  for (const r of rows) {
    const ext = (r.filename.split('.').pop() ?? '?').toLowerCase();
    byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
  }

  console.log(`[images-backfill] ${rows.length} documents have not been scanned for images`);
  for (const [ext, n] of [...byExt.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`[images-backfill]   ${ext.padEnd(6)} ${n}`);
  }

  if (rows.length === 0) {
    await sql.end();
    return;
  }

  if (!args.go) {
    console.log('');
    console.log('[images-backfill] DRY RUN — nothing fired.');
    console.log(
      `[images-backfill] Upper bound on vision calls: ${rows.length} docs × up to ${MAX_IMAGES_PER_DOC} kept images = ${rows.length * MAX_IMAGES_PER_DOC}.`,
    );
    console.log(
      '[images-backfill] The real number is far lower — most documents hold no qualifying picture at all, and icons, logos and duplicates are dropped before any model runs. Try --limit=20 --go first and read the actual yield off the extract_images trace steps.',
    );
    console.log('[images-backfill] Re-run with --go to proceed.');
    await sql.end();
    return;
  }

  let i = 0;
  for (const row of rows) {
    i++;
    await sql`select pg_notify('node_ingested', ${row.id}::text)`;
    console.log(
      `[images-backfill] (${i}/${rows.length}) ${row.id.slice(0, 8)} — ${row.title.slice(0, 60)}`,
    );
    if (i < rows.length) await new Promise((r) => setTimeout(r, args.rateSec * 1000));
  }

  console.log(
    `[images-backfill] done. ${rows.length} notifications fired. The extract queue drains at its own pace — watch the agent's logs, or the extract_images steps in /traces.`,
  );
  await sql.end();
}

main().catch((err) => {
  console.error('[images-backfill] fatal:', err);
  process.exit(1);
});
