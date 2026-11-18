/**
 * The files that need attention (docs/files.md, "Reindex and stale
 * indexes"): one page of the files read by an older reader or pipeline
 * (`stale`), not read (`failed`) or read in part (`partial`), newest first,
 * each with its status. One function for the route GET /api/files/stale and
 * the tool `file_stale_list`.
 *
 * Read only, in the caller's scope (listFilesNeedingAttention, @mantle/files):
 * a file the caller does not read is not listed and not counted.
 */
import {
  listFilesNeedingAttention,
  parseStaleCursor,
  STALE_LIST_DEFAULT,
  STALE_LIST_MAX,
  STALE_LIST_STATES,
  withFileStatus,
  type FileStatus,
  type StaleListState,
} from '@mantle/files';
import { fileStatusPipelines } from '@mantle/content/pipeline-registry';
import type { FileStaleAnswer } from '@mantle/client-types/dto/file-status';
import type { BuiltinToolDef } from '../types';

export type StaleQuery = { state?: unknown; cursor?: unknown; limit?: unknown };

/** One page of the list, or the refusal of a bad query. */
export async function fileStaleList(
  ownerId: string,
  q: StaleQuery,
): Promise<{ ok: true; answer: FileStaleAnswer } | { ok: false; error: string }> {
  const state = (q.state ?? 'stale') as StaleListState;
  if (!STALE_LIST_STATES.includes(state)) {
    return { ok: false, error: `state must be one of ${STALE_LIST_STATES.join(', ')}.` };
  }
  const limit = q.limit === undefined || q.limit === '' ? STALE_LIST_DEFAULT : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > STALE_LIST_MAX) {
    return { ok: false, error: `limit must be a whole number from 1 to ${STALE_LIST_MAX}.` };
  }
  let cursor: { us: string; id: string } | null = null;
  if (q.cursor !== undefined && q.cursor !== '') {
    cursor = typeof q.cursor === 'string' ? parseStaleCursor(q.cursor) : null;
    if (!cursor) return { ok: false, error: 'cursor must be the `next` of a page before.' };
  }
  const { dbExts, installed } = await fileStatusPipelines(ownerId);
  const page = await listFilesNeedingAttention({
    ownerId,
    state,
    installed,
    cursor,
    limit,
  });
  const files = await withFileStatus(page.files, dbExts, installed);
  return {
    ok: true,
    answer: {
      files: files as unknown as Array<{ id: string; status: FileStatus }>,
      next: page.next,
      total: page.total,
    },
  };
}

export const file_stale_list: BuiltinToolDef = {
  slug: 'file_stale_list',
  policy: {
    effect: 'read',
    spends: 'none',
    scope: 'any',
    keyArea: 'files',
  },
  name: 'List files that need attention',
  description:
    "One page of the files that need attention, newest first, each with its `status`: `stale` (read by an older reader or pipeline than the box has now), `failed` (could not be read) or `partial` (read in part). Returns `files`, `total` (all in that state you can read) and `next` (pass it as `cursor` for the next page; null on the last). Read only. To read them again use `file_reindex`; for one file's details, `file_processing`.",
  inputSchema: {
    type: 'object',
    properties: {
      state: {
        type: 'string',
        enum: [...STALE_LIST_STATES],
        default: 'stale',
        description: 'Which list.',
      },
      cursor: {
        type: 'string',
        description: 'The `next` of the page before.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: STALE_LIST_MAX,
        default: STALE_LIST_DEFAULT,
        description: 'Files in this page.',
      },
    },
  },
  handler: async (input, ctx) => {
    const res = await fileStaleList(ctx.ownerId, input);
    return res.ok ? { ok: true, output: res.answer } : { ok: false, error: res.error };
  },
};
