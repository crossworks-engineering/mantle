/**
 * Reindex files (docs/files.md, "Reindex and stale indexes"): read one file
 * or many again through the whole pipeline. One function for the route
 * POST /api/files/reindex and the tool `file_reindex`, so the two never
 * drift.
 *
 * What a queued file gets, through the existing extract queue and its caps
 * and budgets (nothing new that spends):
 *  - its text read again from the bytes: the keys the extractor derived
 *    from them are dropped (the cached text, the summary, the reader's
 *    stamp, a skip or parked verdict), as a content change does, and
 *    markContentChanged asks the extractor for its whole pass (text,
 *    chunks, vector, facts, mentions). Only for a file whose bytes are
 *    there (one look at each, before anything is dropped): a file with no
 *    bytes keeps all it has and is skipped `bytes-missing`. The cached text
 *    is what the extractor would read instead of the bytes, so it goes; it
 *    is made again from the bytes that were just found. But for a scanned
 *    drawing whose database holds its sketch read (`Vision read`): that read
 *    is paid for and runs one time for its bytes, so its text (`text`,
 *    `ocr`, `vision_model`) stays and the pass chunks, embeds and reads
 *    facts from it again (dropped, the extract would pay a whole-page OCR
 *    whose weaker text replaces it). A PDF whose database is there but
 *    whose File tab cannot be read now keeps it too (fail closed,
 *    pdfTextKeptOf). A PDF as the extractor tells one: the extension or
 *    the mimeType. The old chunks and facts stay until the new pass replaces them. The text of the Agents'
 *    tabs and the pipeline's stamp stay (no database is rebuilt by the
 *    extract);
 *  - when the file has a database (or a word) for its bytes, one run of the
 *    box's Reader of its type (notifyPipelineRun). The Reader asks no
 *    model; the `after` chain that follows it may ask one (as at upload),
 *    within the box's day cap. A file with none gets its database from the
 *    extract itself (auto-table: an extract pending and no name for the
 *    bytes), as an upload does. Not where the Reader is off in the file's
 *    home workspace.
 *
 * Two checks, and no third. Rights: the edit of each file (itemWriteVerdicts,
 * the one mapper's rule: whoever may change the file by hand may read it
 * again), asked once for all ids. Cost: the busy check of the queue
 * (extractQueueBusy, as pipeline_run) before anything is queued, and the
 * cap of FILE_REINDEX_MAX ids per call. A person asked, by hand or from
 * their own MCP connection: no trigger, no timer calls this, and no agent of
 * the brain holds the tool (mcpOnly, as pipeline_run).
 *
 * Every id is either queued or named in `skipped`, with its reason.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  db,
  extractJobsFor,
  extractQueueBusy,
  itemHomeSql,
  itemWriteVerdicts,
  markContentChanged,
  nodes,
  notifyPipelineRun,
  withDeadlockRetry,
  withHeads,
} from '@mantle/db';
import {
  BYTE_DERIVED_DATA_KEYS,
  emailAttachmentIds,
  extOf,
  fileDbNameExists,
  fileDbSqlitePath,
  keyWithoutSearch,
  loadFileHead,
} from '@mantle/files';
import { pdfTextKeptOf } from '@mantle/content/pdf-read';
import { boxPipelines } from '@mantle/content/pipeline-registry';
import { pipelineOffHere, pipelineStateOf } from '@mantle/content/pipeline-state';
import { log } from '@mantle/tracing';
import { defineDomainError, errorMessage, UUID_RE } from '@mantle/std';
import {
  FILE_REINDEX_MAX,
  type FileReindexAnswer,
  type FileReindexSkip,
} from '@mantle/client-types/dto/file-status';
import { CS } from '../client-sourced-rule';
import type { BuiltinToolDef } from '../types';

/** The keys a reindex drops: what the extractor derived from the bytes,
 *  but the Agents' text and the pipeline's stamp (no database is rebuilt by
 *  the extract), and a parked verdict, so the read runs again. */
const REINDEX_DROP_KEYS: readonly string[] = [
  ...BYTE_DERIVED_DATA_KEYS.filter((k) => k !== 'agent_text' && k !== 'pipeline_read'),
  'extract_parked',
];

/** The keys of a sketch read's text, kept for a file whose database holds
 *  it (the read is paid for and is not asked again for these bytes). */
const SKETCH_TEXT_KEYS: readonly string[] = ['text', 'ocr', 'vision_model'];
const SKETCH_DROP_KEYS = REINDEX_DROP_KEYS.filter((k) => !SKETCH_TEXT_KEYS.includes(k));

/** How many files' bytes (and PDF databases) are looked for at once. */
const BYTES_BATCH = 8;

/** The queue could not be read (a grant missing on a box, the database
 *  away): nothing was queued and nothing dropped. The caller hears it in
 *  plain words, never the SQL; the fault itself is logged. */
export class ReindexQueueUnreadError extends Error {
  constructor(cause: unknown) {
    super(
      'The extract queue could not be read now, so no file was queued and nothing was dropped. ' +
        'Try again later; if it stays, the box needs its setup run again (migrate, then pgboss:init).',
      { cause },
    );
    this.name = 'ReindexQueueUnreadError';
  }
}

defineDomainError(ReindexQueueUnreadError, {
  reason: 'the queue a reindex checks first could not be read: the caller is told nothing was done',
  status: 503,
});

/** The ids of a call, checked: 1 to FILE_REINDEX_MAX uuids, each once, or
 *  the refusal. */
export function reindexIdsOf(raw: unknown): { ids: string[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'ids must be a list of 1 to 200 file ids.' };
  }
  if (raw.length > FILE_REINDEX_MAX) {
    return {
      error: `At most ${FILE_REINDEX_MAX} files per call; send the rest in another call.`,
    };
  }
  const ids: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string' || !UUID_RE.test(v.trim())) {
      return { error: 'Every id must be a file id (a UUID).' };
    }
    const id = v.trim().toLowerCase();
    if (!ids.includes(id)) ids.push(id);
  }
  return { ids };
}

/** Read these files again (ids checked by reindexIdsOf), in the caller's
 *  scope. */
export async function reindexFiles(
  ownerId: string,
  ids: readonly string[],
): Promise<FileReindexAnswer> {
  const skipped: FileReindexAnswer['skipped'] = [];
  const skip = (id: string, reason: FileReindexSkip) => skipped.push({ id, reason });

  // The files the caller reads, in its scope, current ones only: one read.
  // `data` holds only what finding the bytes needs (loadFileHead).
  const rows = await db
    .select({
      id: nodes.id,
      title: nodes.title,
      path: nodes.path,
      home: itemHomeSql(),
      filename: sql<string | null>`${nodes.data}->>'filename'`,
      sha256: sql<string | null>`${nodes.data}->>'sha256'`,
      mimeType: sql<string | null>`${nodes.data}->>'mimeType'`,
      data: sql<Record<string, unknown>>`jsonb_build_object(
        'filename', ${nodes.data}->'filename',
        'sha256', ${nodes.data}->'sha256',
        'space_file', ${nodes.data}->'space_file')`,
    })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'file'),
        isNull(nodes.supersededBy),
        sql`${nodes.id} = any (${`{${ids.join(',')}}`}::uuid[])`,
      ),
    );
  // An API key without the Search area does not reach an email attachment
  // (access matrix M4), as on the file lists. On MCP the key's areas are in
  // the caller's facts; the HTTP route asks callerMayReadEmail itself.
  const hidden = keyWithoutSearch()
    ? await emailAttachmentIds(
        ownerId,
        rows.map((r) => r.id),
      )
    : new Set<string>();
  const byId = new Map(rows.filter((r) => !hidden.has(r.id)).map((r) => [r.id.toLowerCase(), r]));
  const found = ids.filter((id) => byId.has(id));
  for (const id of ids) if (!byId.has(id)) skip(id, 'not-found');

  // The one rights check: the edit of each file, for all at once.
  const verdicts = await itemWriteVerdicts(found, 'edit');
  const allowed: string[] = [];
  for (const id of found) {
    const v = verdicts.get(id);
    if (v === 'ok') allowed.push(id);
    else skip(id, v === 'no_read' ? 'not-found' : 'not-allowed');
  }

  // A read already queued or running is not queued twice. A queue that
  // cannot be read stops here, before anything is written.
  const jobs = await extractJobsFor(allowed).catch((err: unknown) => {
    log('files').warn(`reindex: the extract queue could not be read: ${errorMessage(err)}`);
    throw new ReindexQueueUnreadError(err);
  });
  const waiting: string[] = [];
  for (const id of allowed) {
    if (jobs.has(id)) skip(id, 'in-queue');
    else waiting.push(id);
  }
  if (waiting.length === 0) return { queued: 0, databases: 0, skipped };

  // The cost check: a busy queue takes nothing more now.
  if (await extractQueueBusy()) {
    for (const id of waiting) skip(id, 'busy');
    return { queued: 0, databases: 0, skipped };
  }

  // The bytes of each, before anything is dropped: with none there is
  // nothing to read again, and the file keeps all it has.
  const take: string[] = [];
  for (let i = 0; i < waiting.length; i += BYTES_BATCH) {
    const batch = waiting.slice(i, i + BYTES_BATCH);
    const heads = await Promise.all(
      batch.map((id) => loadFileHead(byId.get(id)!, 1).catch(() => null)),
    );
    batch.forEach((id, j) => {
      if (heads[j] === null) skip(id, 'bytes-missing');
      else take.push(id);
    });
  }
  if (take.length === 0) return { queued: 0, databases: 0, skipped };

  // A PDF whose database holds its sketch read (or whose File tab cannot be
  // read now) keeps that read's text. A PDF as the extractor tells one
  // (load-body.ts): the extension or the mimeType. Read in batches.
  const pdfs = take.filter((id) => {
    const row = byId.get(id)!;
    return extOf(row.filename ?? row.title) === 'pdf' || row.mimeType === 'application/pdf';
  });
  const sketched: string[] = [];
  for (let i = 0; i < pdfs.length; i += BYTES_BATCH) {
    const batch = pdfs.slice(i, i + BYTES_BATCH);
    const kept = await Promise.all(
      batch.map(async (id) => {
        const abs = await fileDbSqlitePath(id, byId.get(id)!.sha256);
        return abs !== null && (await pdfTextKeptOf(abs));
      }),
    );
    batch.forEach((id, j) => {
      if (kept[j]) sketched.push(id);
    });
  }

  // Drop what the extractor derived from the bytes (they are there) and ask
  // for its whole pass, in one transaction for all of them (the heads first, workspaces
  // plan U1). The announcements go out when it commits.
  const keys = (list: readonly string[]) =>
    sql`array[${sql.join(
      list.map((k) => sql`${k}`),
      sql`, `,
    )}]::text[]`;
  const drop = sql`case when ${nodes.id} = any (${`{${sketched.join(',')}}`}::uuid[])
    then ${keys(SKETCH_DROP_KEYS)} else ${keys(REINDEX_DROP_KEYS)} end`;
  await withDeadlockRetry(() =>
    withHeads(take, 'update', async (tx) => {
      await tx
        .update(nodes)
        .set({ data: sql`coalesce(${nodes.data}, '{}'::jsonb) - (${drop})` })
        .where(
          and(
            eq(nodes.type, 'file'),
            isNull(nodes.supersededBy),
            sql`${nodes.id} = any (${`{${take.join(',')}}`}::uuid[])`,
          ),
        );
      for (const id of take) await markContentChanged(tx, { id, type: 'file' }, ['content']);
    }),
  );

  // The database: one run of the box's Reader of the type, for a file that
  // has a database or a word for its bytes, where the Reader is on.
  const pipelines = await boxPipelines(ownerId);
  const offOf = new Map<string, readonly string[]>();
  let databases = 0;
  for (const id of take) {
    const row = byId.get(id)!;
    const reader = pipelines.readerFor(extOf(row.filename ?? row.title));
    if (!reader || !(await fileDbNameExists(id, row.sha256))) continue;
    if (!offOf.has(reader.id)) offOf.set(reader.id, (await pipelineStateOf(ownerId, reader)).offIn);
    if (pipelineOffHere({ offIn: offOf.get(reader.id)! }, row.home)) continue;
    try {
      await notifyPipelineRun(id, reader.id);
      databases += 1;
    } catch (err) {
      // The read of the text is queued; only the database run is not.
      log('files').warn(`reindex: the database run of ${id} was not queued: ${errorMessage(err)}`);
    }
  }
  return { queued: take.length, databases, skipped };
}

export const file_reindex: BuiltinToolDef = {
  slug: 'file_reindex',
  // A member's own client and MCP connection run it; no agent of the brain
  // is granted it (no tool group holds it), as pipeline_run. An in-brain
  // agent gets it only on the owner's word.
  mcpOnly: true,
  policy: {
    // Reading a file again spends model work on it: the edit of it, as
    // process_extraction asks.
    matrix: { action: 'edit', param: 'file_ids', kinds: ['file'] },
    effect: 'write',
    // The tool calls no model: it queues. The extract spends behind its own
    // gates and caps, as an upload's does (pipeline_run says the same), so
    // a member reindexes by MCP as by hand.
    spends: 'none',
    // Each queued read spends model work (summary, facts, embedding, and
    // the Reader's `after` chain), so an API key or a peer must have this
    // tool named, as pipeline_run. A member keeps what he may do by hand.
    peerRisky: true,
    scope: 'any',
    keyArea: 'files',
    itemArgs: [{ param: 'file_ids' }],
    // It reads the file's own bytes again; nothing new reaches anyone.
    clientSourced: CS.onNodes('file_ids'),
    recipe: { step: 'forbidden' },
  },
  name: 'Reindex files',
  description:
    "Read files again through the whole pipeline: text from the bytes, summary, chunks, embedding, facts, mentions, and the file database when it has one. Use it for a file whose `status.stale` is true (find them with `file_stale_list`) or whose read failed. Returns `queued`, `databases` (database runs queued) and `skipped`, a reason for each id not queued: `not-found`, `not-allowed` (you may not change it), `in-queue` (already being read), `busy` (queue full: try later), `bytes-missing` (the bytes could not be read now, gone or unreachable: nothing dropped). Each read spends model work, under the box caps. For one file's details use `file_processing`.",
  inputSchema: {
    type: 'object',
    properties: {
      file_ids: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        minItems: 1,
        maxItems: FILE_REINDEX_MAX,
        description: 'The files to read again (UUIDs, from `file_list` or `file_stale_list`).',
      },
    },
    required: ['file_ids'],
  },
  handler: async (input, ctx) => {
    const checked = reindexIdsOf(input.file_ids);
    if ('error' in checked) return { ok: false, error: checked.error };
    const answer = await reindexFiles(ctx.ownerId, checked.ids);
    return { ok: true, output: answer };
  },
};
