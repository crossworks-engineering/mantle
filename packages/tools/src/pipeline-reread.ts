/**
 * Read the older files of one pipeline again (docs/pipelines.md, "Read the
 * older files again"): the tool `pipeline_reread` and the route POST
 * /api/pipelines/:id/reread call one function, `rereadPipeline`.
 *
 * The files are the ones the list's `older` counts: pipelineReadOf
 * (@mantle/files, stamp.ts) is the one place that decides "older", and the
 * count and this list both ask it, on the stamp each file's database
 * carries, with the options in force. A file an `after` pipeline never
 * patched is not older; a member runs it with `pipeline_run`.
 *
 *  - The dry run is the default: the older files found in this page, with
 *    the skips, and nothing sent.
 *  - With `apply`: one `pipeline_run` notify for each file it takes
 *    (notifyPipelineRun, @mantle/db), M5's signal; the api sends M5's job,
 *    which builds a reader's database again with no model, or patches an
 *    `after` pipeline's tabs, and does nothing else.
 *
 * The walk: the file ids with a database, in id order, after `after`. One
 * call looks at no more than PIPELINE_SCAN_MAX ids and takes no more than
 * `limit` older files. When it stops at either while ids are left, `next` is
 * the last id it looked at, also when it found fewer than `limit`: so every
 * call is bounded, and the next call goes on. The rows are read on the
 * system pool after the settings area check (areaSystem), as the counts
 * are: a file of a workspace the caller is not in is the box's too.
 *
 * Two checks, and no third. Rights: the Admin check is the route's policy
 * and the tool's scope (area `settings`); nothing here asks again. Cost: the
 * busy check (extractQueueBusy) before any notify, and the cap (`limit`,
 * and the budget of ids). The reader of a PDF drawing is refused (`pdf`,
 * PIPELINE_RUN_REFUSED of M5): a model-free build would lose the rows a
 * model paid for.
 *
 * D7 and an agent: an agent may start a re-read, because every run of phase
 * 2 is model-free and capped, and the dry run comes first. If a later phase
 * adds a run that may spend, that parameter goes on
 * packages/tools/src/person-only-acts.ts in the same commit.
 *
 * Nothing starts by itself: a new version or a changed option starts no
 * re-read. Only a call with `apply` notifies.
 */
import { extractQueueBusy, notifyPipelineRun } from '@mantle/db';
import {
  BUILTIN_PIPELINES,
  fileDataRows,
  fileIdsWithDatabase,
  fileSha256Of,
  filesRootMounted,
  isFileSha256,
  pipelineReadOf,
  type FileDataRow,
} from '@mantle/files';
import { readFileRowNow } from '@mantle/content/file-database';
import { pipelineStateOf } from '@mantle/content/pipeline-state';
import { UUID_RE } from '@mantle/std';
import type { PipelineRunAnswer, PipelineRunSkip } from '@mantle/client-types';
import { areaSystem } from './admin-gate';
import { CS } from './client-sourced-rule';
import { PIPELINE_SCAN_MAX, seenOf } from './pipeline-look';
import { PIPELINE_RUN_REFUSED, RUN_DEFAULT_LIMIT, RUN_MAX_LIMIT } from './pipeline-run';
import type { BuiltinToolDef } from './types';

/** The ids one read of file rows asks for. */
const ROWS_AT_ONCE = 200;

export type PipelineRereadInput = { apply?: unknown; limit?: unknown; after?: unknown };

/** The older files of one page of the walk, and where the next goes on. */
async function olderPage(
  ownerId: string,
  p: (typeof BUILTIN_PIPELINES)[number],
  hash: string,
  after: string | undefined,
  limit: number,
): Promise<{ found: FileDataRow[]; next: string | null }> {
  const ids = (await fileIdsWithDatabase())
    .map((id) => id.toLowerCase())
    .filter((id) => after === undefined || id > after)
    .sort();
  const found: FileDataRow[] = [];
  let looked = 0;
  while (looked < ids.length && looked < PIPELINE_SCAN_MAX && found.length < limit) {
    const chunk = ids.slice(looked, Math.min(looked + ROWS_AT_ONCE, PIPELINE_SCAN_MAX));
    const rows = new Map(
      (await fileDataRows(ownerId, chunk, { full: false })).map((r) => [r.id, r]),
    );
    for (const id of chunk) {
      looked += 1;
      const row = rows.get(id);
      const seen = row ? await seenOf(row) : null;
      if (row && seen && pipelineReadOf(p, seen, hash)?.older) found.push(row);
      if (found.length >= limit) break;
    }
  }
  return { found, next: looked < ids.length ? ids[looked - 1]! : null };
}

/**
 * The dry run, or with `apply` the re-read, of the older files of pipeline
 * `id`. No rights check here: the route's policy and the tool's scope are
 * the check. The answer is M5's PipelineRunAnswer with one choice: its
 * `files` are the older files found in this page; `skipped` counts those it
 * does not take, by word; `queued` the files sent.
 */
export async function rereadPipeline(
  ownerId: string,
  id: string,
  input: PipelineRereadInput,
): Promise<{ ok: true; answer: PipelineRunAnswer } | { ok: false; error: string; missing?: true }> {
  const p = BUILTIN_PIPELINES.find((x) => x.id === id);
  if (!p) {
    return {
      ok: false,
      error: `There is no pipeline "${id.slice(0, 40)}". Find the id with pipeline_list.`,
      missing: true,
    };
  }
  const after = typeof input.after === 'string' ? input.after.toLowerCase() : undefined;
  if (input.after !== undefined && (!after || !UUID_RE.test(after))) {
    return { ok: false, error: 'after must be the file id a call before gave as `next`.' };
  }
  const limit = input.limit === undefined ? RUN_DEFAULT_LIMIT : input.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > RUN_MAX_LIMIT) {
    return { ok: false, error: `limit must be a whole number from 1 to ${RUN_MAX_LIMIT}.` };
  }
  const apply = input.apply === true;
  if (!(await filesRootMounted())) {
    return {
      ok: false,
      error: 'The files of this box are not reachable from here; try again on the web server.',
    };
  }
  const refused = PIPELINE_RUN_REFUSED[p.id] ?? null;

  // The box's older files, read on the system pool after the settings area
  // check, as the counts are; the skips with them.
  const { found, next, take, skipped } = await areaSystem('settings', async () => {
    const state = await pipelineStateOf(ownerId, p);
    const page = await olderPage(ownerId, p, state.optionsHash, after, limit);
    const skipped: Partial<Record<PipelineRunSkip, number>> = {};
    const take: string[] = [];
    for (const row of page.found) {
      let skip: PipelineRunSkip | null = refused;
      if (!skip && !isFileSha256(fileSha256Of(row))) skip = 'no-sha';
      if (!skip) {
        const now = await readFileRowNow(row.id, ownerId);
        if (!now || now.sha256 !== fileSha256Of(row)) skip = 'no-sha';
        else if (now.isPrivate) skip = 'private';
      }
      if (skip) skipped[skip] = (skipped[skip] ?? 0) + 1;
      else take.push(row.id);
    }
    return { ...page, take, skipped };
  });

  const busy = await extractQueueBusy();
  let queued = 0;
  if (apply && !busy) {
    for (const fileId of take) {
      await notifyPipelineRun(fileId, p.id);
      queued += 1;
    }
  }
  return {
    ok: true,
    answer: {
      apply,
      busy,
      choices: [{ pipeline: p.id, name: p.name, files: found.length, refused }],
      queued,
      skipped,
      next,
    },
  };
}

export const pipeline_reread: BuiltinToolDef = {
  slug: 'pipeline_reread',
  // An Admin user's own client runs it; no agent is granted it (no tool
  // group holds it in phase 2).
  mcpOnly: true,
  policy: {
    matrix: { none: 'a pipeline is not an item' },
    effect: 'write',
    spends: 'none',
    // The route's area (POST /api/pipelines/:id/reread). Not systemWhole:
    // it runs in the caller's scope, and only its walk of the file rows goes
    // to the system pool (areaSystem in rereadPipeline), as pipeline_list's
    // count does.
    scope: { area: 'settings' },
    recipe: { step: 'forbidden' },
    clientSourced: CS.always('reads the older files of this box again'),
  },
  name: 'Read the older files again',
  description:
    "Read again the files a pipeline read at an older version or with other options: the files `older` counts in `pipeline_list`, on the whole box. Without `apply` it is a dry run: `choices[0].files` is the older files found in this page, `refused` names why the pipeline may not run ('pdf'), and `skipped` counts the files it would not take, by word. With `apply: true` each file it takes is queued, and its database is built again from its bytes (a reader) or gets its tabs again (an `after` pipeline). No model is asked; nothing else of a file changes. `busy: true`: nothing was queued. When `next` is set, call again with `after: next`. To run a pipeline on one file or folder use `pipeline_run`.",
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        pattern: '^[a-z0-9][a-z0-9-]{0,39}$',
        description: "The pipeline's id from `pipeline_list`, e.g. 'site-tags'.",
      },
      apply: {
        type: 'boolean',
        default: false,
        description: 'Without it, the dry run: nothing is queued. true: queue the re-read.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: RUN_MAX_LIMIT,
        default: RUN_DEFAULT_LIMIT,
        description: 'The most older files this call takes.',
      },
      after: {
        type: 'string',
        format: 'uuid',
        description: 'Go on after this file id: the `next` of the call before.',
      },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const res = await rereadPipeline(ctx.ownerId, String(input.id ?? ''), {
      apply: input.apply,
      limit: input.limit,
      after: input.after,
    });
    return res.ok ? { ok: true, output: res.answer } : { ok: false, error: res.error };
  },
};
