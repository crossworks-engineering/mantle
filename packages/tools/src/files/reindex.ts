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
 *    chunks, vector, facts, mentions). The old chunks and facts stay until
 *    the new pass replaces them: nothing is thrown away before it is
 *    rebuilt. The text of the Agents' tabs and the pipeline's stamp stay
 *    (no database is rebuilt by the extract);
 *  - when the file has a database (or a word) for its bytes, one run of the
 *    box's Reader of its type (notifyPipelineRun, model free), which
 *    builds it again and runs the `after` chain. A file with none gets its
 *    database from the extract itself (auto-table: an extract pending and
 *    no name for the bytes), as an upload does. Not where the Reader is off
 *    in the file's home workspace.
 *
 * Two checks, and no third. Rights: the edit of each file (itemWriteVerdicts,
 * the one mapper's rule: whoever may change the file by hand may read it
 * again), asked once for all ids. Cost: the busy check of the queue
 * (extractQueueBusy, as pipeline_run) before anything is queued, and the
 * cap of FILE_REINDEX_MAX ids per call. A person or an agent asked: no
 * trigger, no timer calls this.
 *
 * Every id is either queued or named in `skipped`, with its reason.
 */
import { and, eq, sql } from 'drizzle-orm';
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
import { BYTE_DERIVED_DATA_KEYS, extOf, fileDbNameExists } from '@mantle/files';
import { boxPipelines } from '@mantle/content/pipeline-registry';
import { pipelineOffHere, pipelineStateOf } from '@mantle/content/pipeline-state';
import { log } from '@mantle/tracing';
import { errorMessage, UUID_RE } from '@mantle/std';
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

  // The files the caller reads, in its scope: one read.
  const rows = await db
    .select({
      id: nodes.id,
      title: nodes.title,
      home: itemHomeSql(),
      filename: sql<string | null>`${nodes.data}->>'filename'`,
      sha256: sql<string | null>`${nodes.data}->>'sha256'`,
    })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'file'),
        sql`${nodes.id} = any (${`{${ids.join(',')}}`}::uuid[])`,
      ),
    );
  const byId = new Map(rows.map((r) => [r.id.toLowerCase(), r]));
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

  // A read already queued or running is not queued twice.
  const jobs = await extractJobsFor(allowed);
  const take: string[] = [];
  for (const id of allowed) {
    if (jobs.has(id)) skip(id, 'in-queue');
    else take.push(id);
  }
  if (take.length === 0) return { queued: 0, databases: 0, skipped };

  // The cost check: a busy queue takes nothing more now.
  if (await extractQueueBusy()) {
    for (const id of take) skip(id, 'busy');
    return { queued: 0, databases: 0, skipped };
  }

  // Drop what the extractor derived from the bytes and ask for its whole
  // pass, in one transaction for all of them (the heads first, workspaces
  // plan U1). The announcements go out when it commits.
  const drop = sql`array[${sql.join(
    REINDEX_DROP_KEYS.map((k) => sql`${k}`),
    sql`, `,
  )}]::text[]`;
  await withDeadlockRetry(() =>
    withHeads(take, 'update', async (tx) => {
      await tx
        .update(nodes)
        .set({ data: sql`coalesce(${nodes.data}, '{}'::jsonb) - ${drop}` })
        .where(
          and(eq(nodes.type, 'file'), sql`${nodes.id} = any (${`{${take.join(',')}}`}::uuid[])`),
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
  policy: {
    // Reading a file again spends model work on it: the edit of it, as
    // process_extraction asks.
    matrix: { action: 'edit', param: 'file_ids', kinds: ['file'] },
    effect: 'write',
    // The tool calls no model: it queues. The extract spends behind its own
    // gates and caps, as an upload's does (pipeline_run says the same), so
    // a member reindexes by MCP as by hand.
    spends: 'none',
    scope: 'any',
    keyArea: 'files',
    itemArgs: [{ param: 'file_ids' }],
    // It reads the file's own bytes again; nothing new reaches anyone.
    clientSourced: CS.onNodes('file_ids'),
    idempotent: true,
  },
  name: 'Reindex files',
  description:
    "Read files again through the whole pipeline: text from the bytes, summary, chunks, embedding, facts, mentions, and the file database when it has one. Use it for a file whose `status.stale` is true (find them with `file_stale_list`) or whose read failed. Returns `queued`, `databases` (database runs queued) and `skipped`, a reason for each id not queued: `not-found`, `not-allowed` (you may not change it), `in-queue` (already being read), `busy` (queue full: try later). Each read spends model work, under the box caps. For one file's details use `file_processing`.",
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
