/**
 * A file's processing, in full (docs/files.md, "Status and processing"):
 * what the brain did with it and where its content went. One answer for
 * the Details panel in Files (GET /api/files/files/:id/processing) and the
 * `file_processing` tool, so the two never drift.
 *
 * Rights: the file is read in the caller's scope (fileById); one it does
 * not read is not found, as on GET /api/files/files/:id. Every count and
 * the list of items made from it are read in the same scope, so a caller
 * sees only what it may read anyway. Only the queue is read on the system
 * pool, for this one id (extractJobsFor). Read only; it writes nothing.
 */
import { sql } from 'drizzle-orm';
import { db } from '@mantle/db';
import { fileById, fileDbStateOf, withFileStatus } from '@mantle/files';
import { readFileDbStamp } from '@mantle/content/file-database';
import { boxPipelines } from '@mantle/content/pipeline-registry';
import {
  FILE_DERIVED_MAX,
  type FileDerivedItem,
  type FileProcessing,
} from '@mantle/client-types/dto/file-status';
import { type BuiltinToolDef } from '../types';
import { str } from '../coerce';
import { FILE_ID_PRE } from '../builtins-common';
import { fileSqlAnswer } from '../builtins-file-sql';

type StatsRow = {
  embedded: boolean;
  text_chars: number | null;
  summarized: boolean;
  read_at: string | null;
  read_mode: string | null;
  ocr: unknown;
  images: unknown;
  chunks: number;
  facts: number;
  mentions: number;
};

/** A count the reader wrote, or null: `{ kept, found }` of images (read
 *  as it comes: a reader may not write it). */
function imagesOf(raw: unknown): { kept: number; found: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const { kept, found } = raw as { kept?: unknown; found?: unknown };
  return typeof kept === 'number' && typeof found === 'number' ? { kept, found } : null;
}

function pagesOf(ocr: unknown): number | null {
  const total = (ocr as { pages_total?: unknown } | null)?.pages_total;
  return typeof total === 'number' ? total : null;
}

/** What a pipeline extracted into the file's database: its tabs and their
 *  rows, the Data view's own describe (file_sql with no `sql`: the same
 *  rights). Undefined when it is refused or cannot be read: the rest of the
 *  answer stands. One file only; never a list. */
async function tablesOf(
  ownerId: string,
  fileId: string,
): Promise<Array<{ name: string; rows: number }> | undefined> {
  try {
    const got = await fileSqlAnswer(
      ownerId,
      { fileId, sql: '', cap: undefined },
      { tableHint: false },
    );
    return got.kind === 'describe'
      ? got.output.tabs.map((t) => ({ name: t.name, rows: t.row_count }))
      : undefined;
  } catch {
    return undefined;
  }
}

function readModeOf(raw: string | null): FileProcessing['readMode'] {
  return raw === 'full' || raw === 'metadata' || raw === 'local' ? raw : null;
}

/** The processing answer of one file, or null when the caller's scope does
 *  not read it (or it is no file). */
export async function fileProcessing(
  ownerId: string,
  fileId: string,
): Promise<FileProcessing | null> {
  const row = await fileById({ ownerId, fileId });
  if (!row) return null;
  const { dbExts } = await boxPipelines(ownerId);
  const [[file], statsRows, derivedRows] = await Promise.all([
    withFileStatus([row], dbExts),
    db.execute(sql`
      select n.embedding is not null as embedded,
             length(n.data->>'text') as text_chars,
             coalesce(n.data->>'summary', '') <> '' as summarized,
             n.data->>'extract_completed_at' as read_at,
             n.data->>'indexing_applied' as read_mode,
             n.data->'ocr' as ocr,
             n.data->'images' as images,
             (select count(*)::int from content_chunks c where c.node_id = n.id) as chunks,
             (select count(*)::int from facts f where f.source_node_id = n.id) as facts,
             (select count(*)::int from entity_edges e
               where e.target_id = n.id and e.target_kind = 'node'
                 and e.relation = 'mentioned_in') as mentions
        from nodes n
       where n.id = ${row.id}::uuid and n.owner_id = ${ownerId}::uuid`),
    db.execute(sql`
      select n.id, n.type::text as kind, n.title, n.path::text as path
        from nodes n
       where n.owner_id = ${ownerId}::uuid and n.data->>'sourceFileId' = ${row.id}
       order by n.type, lower(n.title), n.id
       limit ${FILE_DERIVED_MAX + 1}`),
  ]);
  const stats = (statsRows as unknown as StatsRow[])[0];
  const derived = derivedRows as unknown as FileDerivedItem[];
  const dbState = file!.dataView ? await fileDbStateOf(row.id, row.sha256) : null;
  const ready = dbState?.state === 'ready';
  const [stamp, tables] = ready
    ? await Promise.all([readFileDbStamp(row.id, row.sha256), tablesOf(ownerId, row.id)])
    : [null, undefined];
  const ex = row.extraction;
  const failed = ex.state === 'failed' || ex.state === 'skipped';
  return {
    file: {
      id: row.id,
      filename: row.filename,
      extension: row.extension,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      parentPath: row.parentPath,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    status: file!.status,
    extraction: ex,
    readAt: stats?.read_at ?? null,
    readMode: readModeOf(stats?.read_mode ?? null),
    pages: pagesOf(stats?.ocr) ?? ex.pages?.total ?? null,
    textChars: Number(stats?.text_chars ?? 0),
    summarized: stats?.summarized === true,
    embedded: stats?.embedded === true,
    chunks: Number(stats?.chunks ?? 0),
    facts: Number(stats?.facts ?? 0),
    mentions: Number(stats?.mentions ?? 0),
    database: dbState
      ? {
          state: dbState.state,
          bytes: dbState.bytes,
          readBy: stamp ? { pipeline: stamp.pipeline_id, version: stamp.pipeline_version } : null,
          ...(tables ? { tables } : {}),
        }
      : null,
    job: file!.status.job ?? null,
    // Reserved for P5: no extractor version is kept per file yet.
    stale: null,
    error: failed && ex.reason ? { reason: ex.reason, hint: ex.hint ?? null } : null,
    images: imagesOf(stats?.images),
    derived: {
      items: derived.slice(0, FILE_DERIVED_MAX).map((d) => ({
        id: d.id,
        kind: d.kind,
        title: d.title,
        path: d.path,
      })),
      truncated: derived.length > FILE_DERIVED_MAX,
    },
  };
}

export const file_processing: BuiltinToolDef = {
  slug: 'file_processing',
  usageTier: 4,
  policy: {
    matrix: { action: 'read', param: 'file_id', kinds: ['file'] },
    effect: 'read',
    spends: 'none',
    scope: 'any',
    keyArea: 'files',
  },
  name: "Show a file's processing",
  description:
    'What the brain did with one file and where its content went: `status` (ingest done, partial, waiting, failed or none; a `job` in the queue; its database state), size, pages, whether it was embedded, the counts of text chunks, facts and mentions, its database (state, size, the pipeline that read it), the last error, and `derived`: the items made from it (extracted images, auto Tables, pages and notes) with id, kind and title. Read only. For its text use `file_read`; for its rows, `file_sql`.',
  preconditions: FILE_ID_PRE,
  inputSchema: {
    type: 'object',
    properties: {
      file_id: {
        type: 'string',
        format: 'uuid',
        description: "The file's id (UUID), from `file_list` or `search_nodes`.",
      },
    },
    required: ['file_id'],
  },
  handler: async (input, ctx) => {
    const fileId = str(input.file_id);
    if (!fileId) return { ok: false, error: 'file_id required' };
    const answer = await fileProcessing(ctx.ownerId, fileId);
    if (!answer) {
      return {
        ok: false,
        error: 'file not found: find the right id with file_list or search_nodes, then re-issue.',
      };
    }
    return { ok: true, output: answer };
  },
};
