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
 *   pnpm -C server/web extract:images-backfill --upgrade-dwf        # DRY RUN
 *   pnpm -C server/web extract:images-backfill --upgrade-dwf --go
 *   pnpm -C server/web extract:images-backfill --upgrade-dwg        # DRY RUN
 *   pnpm -C server/web extract:images-backfill --upgrade-dwg --go
 *
 * `--upgrade-dwf` / `--upgrade-dwg` target the OPPOSITE cohort of the normal
 * mode: CAD files that already produced images, but on the wrong tier (no
 * child carries `provenance: 'sidecar_render'` — files ingested before the
 * media sidecar's CAD/DWG tier, or while it was down/busy). In live mode it
 * deletes those image children and re-notifies the parent so the extractor
 * re-renders through the sidecar. Deleting children breaks links to the OLD
 * image node ids (Page embeds, chat citations) — the dry run says how many.
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
  'dwf',
  'dwg',
];

/** Fallback worst case per document, mirroring MAX_EMBEDDED_IMAGES_PER_DOC in
 *  `@mantle/files/embedded-images`. Used only when the extractor worker has no
 *  explicit `max_embedded_images_per_doc` set. */
const DEFAULT_MAX_IMAGES_PER_DOC = 30;

/** The cap the extractor will actually apply, read from the same worker param
 *  the Settings → AI workers form writes. The backfill only fires
 *  `node_ingested`; the extractor does the keeping, so this is a read for the
 *  estimate's sake and never an instruction. */
async function effectiveImageCap(sql: postgres.Sql): Promise<number> {
  const [row] = await sql<Array<{ cap: number | null }>>`
    select (params->>'max_embedded_images_per_doc')::int as cap
    from ai_workers
    where kind = 'extractor' and enabled = true
    order by created_at
    limit 1`;
  const cap = row?.cap;
  return cap && cap > 0 ? cap : DEFAULT_MAX_IMAGES_PER_DOC;
}

type Args = {
  go: boolean;
  limit: number | null;
  rateSec: number;
  exts: string[];
  /** CAD upgrade cohort: re-render existing image children through the
   *  sidecar for this extension (see the header). */
  upgradeExt: 'dwf' | 'dwg' | null;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { go: false, limit: null, rateSec: 1, exts: DEFAULT_EXTS, upgradeExt: null };
  for (const arg of argv) {
    if (arg === '--go') out.go = true;
    else if (arg === '--upgrade-dwf') out.upgradeExt = 'dwf';
    else if (arg === '--upgrade-dwg') out.upgradeExt = 'dwg';
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

  if (args.upgradeExt) {
    const upExt = args.upgradeExt;
    // The upgrade cohort: CAD files whose extracted images exist but none of
    // them came from the sidecar render tier.
    const rows = (await sql.unsafe(
      `select n.id, n.title,
              (select count(*) from nodes c
                 where c.owner_id = n.owner_id and c.type = 'file'
                   and c.data->>'sourceFileId' = n.id::text
                   and 'extracted-image' = any(c.tags)) as children
         from nodes n
        where n.type = 'file'
          and lower(coalesce(n.data->>'filename', n.title)) ~ '\\.${upExt}$'
          and n.data->>'sourceFileId' is null
          and exists (
            select 1 from nodes c
             where c.owner_id = n.owner_id and c.type = 'file'
               and c.data->>'sourceFileId' = n.id::text
               and 'extracted-image' = any(c.tags))
          and not exists (
            select 1 from nodes c
             where c.owner_id = n.owner_id and c.type = 'file'
               and c.data->>'sourceFileId' = n.id::text
               and c.data->>'provenance' = 'sidecar_render')
        order by n.created_at desc` + (args.limit ? ` limit ${args.limit}` : ''),
      [],
    )) as Array<{ id: string; title: string; children: number }>;

    console.log(`[images-backfill] ${rows.length} ${upExt.toUpperCase()}(s) lack a sidecar render`);
    for (const r of rows) {
      console.log(
        `[images-backfill]   ${r.id.slice(0, 8)} — ${r.title.slice(0, 60)} (${r.children} images to replace)`,
      );
    }
    if (!args.go) {
      console.log('');
      console.log('[images-backfill] DRY RUN — nothing deleted, nothing fired.');
      console.log(
        `[images-backfill] Live mode DELETES the listed image nodes (links to their ids dangle) and re-notifies each ${upExt.toUpperCase()} so the extractor re-renders through the media sidecar. Make sure the sidecar is up with the CAD tier (check /healthz for ${upExt === 'dwf' ? 'ezdwf' : 'dwg2dxf + ezdxf'}) or the re-run ${upExt === 'dwf' ? 'just recreates thumbnails' : 'yields no image at all'}.`,
      );
      console.log('[images-backfill] Re-run with --go to proceed.');
      await sql.end();
      return;
    }
    let i = 0;
    for (const row of rows) {
      i++;
      await sql.begin(async (tx) => {
        await tx.unsafe(
          `delete from nodes c
            where c.type = 'file'
              and c.data->>'sourceFileId' = $1
              and 'extracted-image' = any(c.tags)`,
          [row.id],
        );
        await tx.unsafe(`select pg_notify('node_ingested', $1)`, [row.id]);
      });
      console.log(
        `[images-backfill] (${i}/${rows.length}) upgraded ${row.id.slice(0, 8)} — ${row.title.slice(0, 60)}`,
      );
      if (i < rows.length) await new Promise((r) => setTimeout(r, args.rateSec * 1000));
    }
    console.log(
      `[images-backfill] done. ${rows.length} ${upExt.toUpperCase()}s re-queued for sidecar renders.`,
    );
    await sql.end();
    return;
  }

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
    const cap = await effectiveImageCap(sql);
    console.log('');
    console.log('[images-backfill] DRY RUN — nothing fired.');
    console.log(
      `[images-backfill] Upper bound on vision calls: ${rows.length} docs × up to ${cap} kept images = ${rows.length * cap}.`,
    );
    console.log(
      `[images-backfill] Cap of ${cap}/doc comes from the extractor worker's "Embedded images per document" setting (Settings → AI workers). Raise it there BEFORE backfilling a screenshot-heavy corpus — a document that already produced images is skipped on a re-run, so a low first pass is not automatically corrected by a second one.`,
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
