/**
 * The run on demand (docs/pipelines.md, "Run on demand"): a member picks a
 * file or a folder and a built-in pipeline, and the api runs it on each
 * file. The tool `pipeline_run` and the two routes POST
 * /api/files/files/:id/run and POST /api/files/folders/:id/run call one
 * function, `runPipelines`.
 *
 *  - The dry run is the default, for one file too: the pipelines that can
 *    run on the files, each with the count it would take. Nothing is sent.
 *  - With `apply` and a `pipeline`: one `pipeline_run` notify for each file
 *    it takes (notifyPipelineRun, @mantle/db). The api sends one job for each
 *    on the extract queue, and the job builds or patches the file's database
 *    and does nothing else (server/api/src/agent/extract/pipeline-run.ts).
 *
 * A reader's run builds the file's database again from its bytes, with no
 * model; the `after` chain then runs as at upload. An `after` pipeline's run
 * is the patch, and needs the file's home workspace in its attach list
 * (else `not-attached`): the Admin decided where it is used, a member runs
 * it there. The reader of a PDF drawing is refused (`pdf`), as
 * `pipeline-reread` refuses it: a PDF's database can hold rows a model paid
 * for, and a read with no model would lose them.
 *
 * Two checks, and no third. Rights: the edit of the named file or folder,
 * asked once, here, before anything (assertItemRight), for the routes and
 * the tool alike. Neither a route's item policy nor a tool's itemArgs is a
 * check at run time (docs/actors.md, sections 10 and 11): a write asks it
 * itself before its side effect, as process_extraction does. A member who
 * may put new bytes into the folder by hand may run its reader again.
 * again. Cost: the busy check (extractQueueBusy, the
 * rule of scripts/box-maintain.sh) before any notify, and the cap: one call
 * looks at most `limit` files (100, at most 1000), in id order, and `next`
 * is where the next call goes on. Model spend has no check because there is
 * none: no run passes a decider.
 *
 * D7 and an agent: an agent may start a run, because every run of phase 2
 * is model-free and capped, and the dry run comes first. If a later phase
 * adds a run that may spend, that parameter goes on
 * packages/tools/src/person-only-acts.ts in the same commit.
 *
 * Nothing starts by itself: only this function notifies, and only when a
 * person or an agent called it with `apply`. The files of a folder are read
 * in the caller's scope, so a file the caller cannot see is not there.
 */
import { assertItemRight, extractQueueBusy, notifyPipelineRun } from '@mantle/db';
import {
  BUILTIN_PIPELINES,
  afterMatches,
  builtinForExt,
  fileDataExt,
  fileDataRows,
  fileDataRowsIn,
  fileDbSqlitePath,
  fileSha256Of,
  folderById,
  isAfterPipeline,
  isFileSha256,
  type FileDataRow,
  type PipelineManifest,
} from '@mantle/files';
import { readFileRowNow } from '@mantle/content/file-database';
import { pipelineStateOf } from '@mantle/content/pipeline-state';
import { describeWorkbook } from '@mantle/tabledb';
import { UUID_RE } from '@mantle/std';
import type { PipelineRunAnswer, PipelineRunSkip } from '@mantle/client-types';
import { FILE_ID_PRE, FOLDER_ID_PRE } from './builtins-common';
import { CS } from './client-sourced-rule';
import type { BuiltinToolDef } from './types';

/** The files one call looks at, by default and at most: the rebuild's
 *  (REBUILD_DEFAULT_LIMIT and REBUILD_MAX_LIMIT,
 *  server/web/lib/maintenance/dwg-reindex.ts). */
export const RUN_DEFAULT_LIMIT = 100;
export const RUN_MAX_LIMIT = 1000;

/** The pipelines a run refuses, with the word. The reader of a PDF drawing
 *  until the owner decides how a PDF is read again (the design's question
 *  1); the job refuses it too. */
export const PIPELINE_RUN_REFUSED: Readonly<Record<string, 'pdf'>> = { 'drawing-pdf': 'pdf' };

export type PipelineRunInput = {
  file_id?: unknown;
  folder_id?: unknown;
  pipeline?: unknown;
  apply?: unknown;
  limit?: unknown;
  after?: unknown;
};

type Page = { rows: FileDataRow[]; next: string | null };

/** The files of the call, in the caller's scope: the one file, or a page of
 *  the folder and its sub-folders by id. */
async function filesOf(
  ownerId: string,
  input: { fileId?: string; folderId?: string; after?: string; limit: number },
): Promise<Page | { error: string }> {
  if (input.fileId) {
    const rows = await fileDataRows(ownerId, [input.fileId], { full: false });
    return rows.length ? { rows, next: null } : { error: 'No file has that id.' };
  }
  const folder = await folderById({ ownerId, folderId: input.folderId! });
  if (!folder) return { error: 'No folder has that id.' };
  const got = await fileDataRowsIn(ownerId, folder.path, {
    below: true,
    ...(input.after ? { after: input.after } : {}),
    limit: input.limit,
  });
  const total = got[0]?.total ?? 0;
  return { rows: got, next: total > got.length ? got[got.length - 1]!.id : null };
}

/** One file, looked at once for every pipeline: its row as it stands now,
 *  and the tabs of its database. */
type Look = {
  now: () => ReturnType<typeof readFileRowNow>;
  tabs: () => Promise<{ name: string; columns: string[] }[] | null>;
};

function lookAt(ownerId: string, row: FileDataRow): Look {
  let now: ReturnType<typeof readFileRowNow> | undefined;
  let tabs: Promise<{ name: string; columns: string[] }[] | null> | undefined;
  return {
    now: () => (now ??= readFileRowNow(row.id, ownerId)),
    tabs: () =>
      (tabs ??= (async () => {
        const abs = await fileDbSqlitePath(row.id, fileSha256Of(row));
        if (!abs) return null;
        try {
          return describeWorkbook(abs).map((t) => ({
            name: t.name,
            columns: t.columns.map((c) => c.name),
          }));
        } catch {
          return null;
        }
      })()),
  };
}

/** Why this pipeline does not take this file, or null when it does. */
async function skipOf(
  p: PipelineManifest,
  workspaces: 'all' | readonly string[],
  row: FileDataRow,
  look: Look,
): Promise<PipelineRunSkip | null> {
  const ext = fileDataExt(row);
  const after = isAfterPipeline(p);
  if (after ? !p.match.ext.includes(ext) : builtinForExt(ext)?.id !== p.id) return 'no-match';
  const refused = PIPELINE_RUN_REFUSED[p.id];
  if (refused) return refused;
  if (!isFileSha256(fileSha256Of(row))) return 'no-sha';
  const now = await look.now();
  if (!now) return 'no-sha';
  if (now.isPrivate) return 'private';
  if (!after) return null;
  if (workspaces !== 'all' && (now.home === null || !workspaces.includes(now.home))) {
    return 'not-attached';
  }
  const tabs = await look.tabs();
  if (!tabs) return 'no-database';
  return afterMatches(p, ext, tabs) ? null : 'no-match';
}

/**
 * The dry run, or with `apply` the run, of the pipelines on one file or a
 * folder. The one rights check is the first thing it does: the edit of the
 * file or folder (a refusal throws, and the one mapper words it). The busy
 * check and the cap are the cost checks.
 */
export async function runPipelines(
  ownerId: string,
  input: PipelineRunInput,
): Promise<{ ok: true; answer: PipelineRunAnswer } | { ok: false; error: string }> {
  const fileId = typeof input.file_id === 'string' ? input.file_id : undefined;
  const folderId = typeof input.folder_id === 'string' ? input.folder_id : undefined;
  if (!fileId === !folderId)
    return {
      ok: false,
      error:
        'Pass one of file_id and folder_id, not both: a file, or a folder and its sub-folders.',
    };
  const id = (fileId ?? folderId)!;
  if (!UUID_RE.test(id)) return { ok: false, error: 'file_id or folder_id must be an id.' };
  // The one rights check: edit of the file or folder, before anything.
  await assertItemRight(id, 'edit');
  const after = typeof input.after === 'string' ? input.after : undefined;
  if (input.after !== undefined && (!after || !UUID_RE.test(after))) {
    return { ok: false, error: 'after must be the file id a cut run gave as `next`.' };
  }
  const limit = input.limit === undefined ? RUN_DEFAULT_LIMIT : input.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
    return { ok: false, error: `limit must be a whole number from 1 to ${RUN_MAX_LIMIT}.` };
  }
  const apply = input.apply === true;
  const named = typeof input.pipeline === 'string' ? input.pipeline : undefined;
  if (input.pipeline !== undefined && named === undefined) {
    return { ok: false, error: 'pipeline must be a pipeline id.' };
  }
  const one = named === undefined ? null : BUILTIN_PIPELINES.find((p) => p.id === named);
  if (named !== undefined && !one) {
    const ids = BUILTIN_PIPELINES.map((p) => p.id).join(', ');
    return { ok: false, error: `There is no pipeline "${named.slice(0, 40)}": one of ${ids}.` };
  }
  if (apply && !one) {
    return {
      ok: false,
      error: 'apply needs a pipeline: run without apply first, and name one of its choices.',
    };
  }

  const page = await filesOf(ownerId, {
    ...(fileId ? { fileId } : { folderId: folderId! }),
    ...(after ? { after } : {}),
    limit: Math.min(RUN_MAX_LIMIT, limit),
  });
  if ('error' in page) return { ok: false, error: page.error };
  const busy = await extractQueueBusy();
  const looks = page.rows.map((row) => lookAt(ownerId, row));

  const choices: PipelineRunAnswer['choices'] = [];
  let skipped: Record<string, number> = {};
  let take: string[] = [];
  for (const p of one ? [one] : BUILTIN_PIPELINES) {
    const workspaces = isAfterPipeline(p) ? (await pipelineStateOf(ownerId, p)).workspaces : 'all';
    const mine: string[] = [];
    const skips: Record<string, number> = {};
    for (const [i, row] of page.rows.entries()) {
      const skip = await skipOf(p, workspaces, row, looks[i]!);
      if (skip === null) mine.push(row.id);
      else skips[skip] = (skips[skip] ?? 0) + 1;
    }
    if (one || mine.length > 0 || Object.keys(skips).some((w) => w !== 'no-match')) {
      choices.push({
        pipeline: p.id,
        name: p.name,
        files: mine.length,
        refused: PIPELINE_RUN_REFUSED[p.id] ?? null,
      });
    }
    if (one) {
      skipped = skips;
      take = mine;
    }
  }

  let queued = 0;
  if (apply && one && !busy) {
    for (const fid of take) {
      await notifyPipelineRun(fid, one.id);
      queued += 1;
    }
  }
  return { ok: true, answer: { apply, busy, choices, queued, skipped, next: page.next } };
}

export const pipeline_run: BuiltinToolDef = {
  slug: 'pipeline_run',
  // A member's own client runs it; no agent is granted it (no tool group
  // holds it in phase 2).
  mcpOnly: true,
  policy: {
    // The owner's rule: building an item's database again is an edit of it,
    // as its itemArgs ask (the form of process_extraction).
    matrix: { action: 'edit', param: 'file_id', kinds: ['file'] },
    effect: 'write',
    spends: 'none',
    scope: 'any',
    // The queue-time check and the audit's targets; the run's check is
    // runPipelines' assertItemRight.
    itemArgs: [{ param: 'file_id' }, { param: 'folder_id' }],
    clientSourced: CS.onNodes('file_id', 'folder_id'),
    recipe: { step: 'forbidden' },
  },
  preconditions: [...FILE_ID_PRE, ...FOLDER_ID_PRE],
  name: 'Run a pipeline',
  description:
    "Run a built-in pipeline again on one file or a folder and its sub-folders. Without `apply` it is a dry run: `choices` lists the pipelines that can run here, each with the files it would take; `refused` names why one may not. Then call with `apply: true` and one `pipeline` from the choices: each file is queued, and its database is built again from its bytes (a reader) or gets its tabs again (an `after` pipeline such as 'site-tags'). No model is asked; nothing else of the file changes. `skipped` counts the files left, by word. `busy: true`: nothing was queued. When `next` is set, call again with `after: next`. To read the result use `file_sql`.",
  inputSchema: {
    type: 'object',
    properties: {
      file_id: { type: 'string', format: 'uuid', description: 'One file. Or folder_id.' },
      folder_id: {
        type: 'string',
        format: 'uuid',
        description: 'A folder: its files and those of its sub-folders. Or file_id.',
      },
      pipeline: {
        type: 'string',
        pattern: '^[a-z0-9][a-z0-9-]{0,39}$',
        description: "A pipeline id from the dry run's choices. Needed with apply.",
      },
      apply: {
        type: 'boolean',
        default: false,
        description: 'Without it, the dry run: nothing is queued. true: queue the run.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: RUN_MAX_LIMIT,
        default: RUN_DEFAULT_LIMIT,
        description: 'The most files this call looks at.',
      },
      after: {
        type: 'string',
        format: 'uuid',
        description: 'Go on after this file id: the `next` of the call before.',
      },
    },
  },
  handler: async (input, ctx) => {
    const res = await runPipelines(ctx.ownerId, input);
    return res.ok ? { ok: true, output: res.answer } : { ok: false, error: res.error };
  },
};
