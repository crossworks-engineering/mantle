/**
 * The pipelines of a brain (docs/pipelines.md): the list GET /api/pipelines
 * answers and `pipeline_list` gives, from one function; the change PATCH
 * /api/pipelines/:id makes and `pipeline_set` makes, from one function; and
 * the stamp line of the Data view. The re-read of the older files is
 * pipeline-reread.ts; it asks pipelineReadOf, as the counts here do.
 *
 * The rows are the built-ins (BUILTIN_PIPELINES), each with its state on
 * this box (pipelineStateOf: its options and its attach list). The counts
 * come from one look at the folder of file databases: the files with a
 * database, their rows, and each stamp. A file counts when its database at
 * its own bytes is there. Its reader is the stamp's, or for a database
 * built before stamps the built-in of its extension; an `after` pipeline
 * counts the databases with its entry in `pipelines_after`. `older` is
 * those not current with the options in force (readerIsCurrent,
 * afterIsCurrent). Numbers only: no file name, no id, and never a tab.
 *
 * The counts are the whole box's, as box_status and brain_capacity count:
 * the rows are read on the system pool after the settings area check
 * (areaSystem), so a file in a workspace the caller is not in counts too.
 * One look is kept for 30 seconds, as box_status keeps its answer. The
 * state is box-wide too, and is read on the system pool beside the counts,
 * on every call: it is never kept, and the look is compared with it on
 * every call, so a set is in the next list and in its counts.
 *
 * Only an Admin with the settings area reaches the list or the set: the
 * route's policy and the tool's scope are that check. setPipelineState has
 * no rights check of its own, by design.
 */
import {
  BUILTIN_PIPELINES,
  PIPELINE_API,
  fileDataRow,
  fileDataRows,
  fileIdsWithDatabase,
  fileSha256Of,
  filesRootMounted,
  isAfterPipeline,
  pipelineReadOf,
  versionBelow,
  type FileDbSeen,
  type PipelineManifest,
} from '@mantle/files';
import { readFileDbStamp } from '@mantle/content/file-database';
import {
  pipelineStateOf,
  setPipelineState,
  type PipelineState,
  type PipelineStateChange,
} from '@mantle/content/pipeline-state';
import { TtlCache } from '@mantle/std';
import type {
  FileDatabaseReadBy,
  PipelineList,
  PipelineOptionSpec,
  PipelineRow,
  PipelineVersionCount,
} from '@mantle/client-types';
import { areaSystem } from './admin-gate';
import { pipeline_test } from './pipeline-test';
import { CS } from './client-sourced-rule';
import { actingLoginId } from './surface';
import type { BuiltinToolDef } from './types';
import { pipeline_run } from './pipeline-run';
import { pipeline_reread } from './pipeline-reread';
import { PIPELINE_SCAN_MAX, seenOf } from './pipeline-look';

/** The most files one list looks at; past it the counts are partial. */
export { PIPELINE_SCAN_MAX };

/** The client's copy of the spec is the contract's type: this fails to
 *  compile when the two drift. */
const specOut = (spec: NonNullable<PipelineManifest['options']>[string]): PipelineOptionSpec =>
  spec;

/** One row of the list: the manifest, with its state on this box. No counts. */
function rowOf(p: PipelineManifest, state: PipelineState): PipelineRow {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    version: p.version,
    source: 'builtin',
    start: p.start,
    kind: isAfterPipeline(p) ? 'after' : 'reader',
    reads: [...p.match.ext],
    weight: p.needs.weight,
    shapes: [...(p.produces.shapes ?? [])],
    workers: Object.keys(p.needs.workers ?? {}),
    tools: [...(p.needs.tools ?? [])],
    workspaces: state.workspaces === 'all' ? 'all' : [...state.workspaces],
    after: p.match.after ?? null,
    tabs: [...(p.produces.tabs ?? [])],
    options: Object.entries(p.options ?? {}).map(([name, spec]) => ({
      name,
      spec: specOut(spec),
      value: state.options[name],
    })),
    files: null,
    older: null,
    versions: [],
    runs: state.runs,
    lastRunAt: state.lastRunAt ? state.lastRunAt.toISOString() : null,
  };
}

/** How long one count is served to every caller, as box_status's. */
export const PIPELINE_COUNTS_TTL_MS = 30_000;

/** One look at the folder of databases: what it saw of each file with a
 *  database at its own bytes (FileDbSeen: its extension and its stamp; no
 *  name, no id). The compare with the options in force is made on every
 *  call (countsOf), so a set is in the next list although the look is
 *  kept. */
type Look = { seen: FileDbSeen[]; partial: boolean };

async function lookAtFiles(ownerId: string, max: number): Promise<Look> {
  const ids = (await fileIdsWithDatabase()).sort();
  const seen: FileDbSeen[] = [];
  for (const row of await fileDataRows(ownerId, ids.slice(0, max), { full: false })) {
    const s = await seenOf(row);
    if (s) seen.push(s);
  }
  return { seen, partial: ids.length > max };
}

type Counts = { files: number; older: number; versions: PipelineVersionCount[] };

/** Versions, highest first; null (before stamps) last. */
function byVersion(a: PipelineVersionCount, b: PipelineVersionCount): number {
  if (a.version === b.version) return 0;
  if (a.version === null) return 1;
  if (b.version === null) return -1;
  if (versionBelow(a.version, b.version)) return 1;
  if (versionBelow(b.version, a.version)) return -1;
  return a.version < b.version ? 1 : -1;
}

/**
 * The counts of a look, with the options in force (`hashes`, by id), each
 * file asked through pipelineReadOf (@mantle/files), the one place that
 * decides "older", which the re-read asks too. `files` are the databases a
 * pipeline read, `older` those not current, and `versions` the files by the
 * version that read them. From the stamp only: no tab is read for a count.
 * No reader promises the shape an `after` pipeline reads, so a database it
 * never patched is not counted for it.
 */
function countsOf(look: Look, hashes: ReadonlyMap<string, string>): Map<string, Counts> {
  const out = new Map<string, Counts>();
  for (const p of BUILTIN_PIPELINES) {
    const hash = hashes.get(p.id) ?? '';
    let files = 0;
    let older = 0;
    const byV = new Map<string | null, number>();
    for (const s of look.seen) {
      const read = pipelineReadOf(p, s, hash);
      if (!read) continue;
      files += 1;
      if (read.older) older += 1;
      byV.set(read.version, (byV.get(read.version) ?? 0) + 1);
    }
    const versions = [...byV].map(([version, n]) => ({ version, files: n })).sort(byVersion);
    out.set(p.id, { files, older, versions });
  }
  return out;
}

/** The look, one at a time, served for PIPELINE_COUNTS_TTL_MS (a failed
 *  look is not kept). It is the box's, so one memo serves every Admin. It
 *  holds what was seen, not the counts: the options in force are compared
 *  on every call. */
const countsMemo = new TtlCache<string, Promise<Look>>({ ttlMs: PIPELINE_COUNTS_TTL_MS });

function lookCached(ownerId: string, max: number): Promise<Look> {
  const key = `${ownerId} ${max}`;
  const hit = countsMemo.get(key);
  if (hit) return hit;
  const pending = lookAtFiles(ownerId, max);
  countsMemo.set(key, pending);
  pending.catch(() => {
    if (countsMemo.get(key) === pending) countsMemo.delete(key);
  });
  return pending;
}

/** Tests: forget the kept counts. */
export function resetPipelineCounts(): void {
  countsMemo.clear();
}

/** The pipelines, each with its state on this box, how many files it read
 *  and how many of those at an older version. No files mount in this
 *  process: no counts, the state still. */
export async function listPipelines(
  ownerId: string,
  opts: { max?: number } = {},
): Promise<PipelineList> {
  const mounted = await filesRootMounted();
  // The whole box: the state and the file rows on the system pool after the
  // settings area check, numbers only (as brain_capacity's counts). The
  // check runs on every call. The state is read on every call and never
  // kept; only the counts are kept.
  const { pipelines, hashes, look } = await areaSystem('settings', async () => {
    const rows: PipelineRow[] = [];
    const hashes = new Map<string, string>();
    for (const p of BUILTIN_PIPELINES) {
      const state = await pipelineStateOf(ownerId, p);
      rows.push(rowOf(p, state));
      hashes.set(p.id, state.optionsHash);
    }
    return {
      pipelines: rows,
      hashes,
      look: mounted ? await lookCached(ownerId, opts.max ?? PIPELINE_SCAN_MAX) : null,
    };
  });
  if (!look) return { api: PIPELINE_API, pipelines, countsPartial: false };
  const counts = countsOf(look, hashes);
  for (const p of pipelines) {
    const c = counts.get(p.id)!;
    p.files = c.files;
    p.older = c.older;
    p.versions = c.versions;
  }
  return { api: PIPELINE_API, pipelines, countsPartial: look.partial };
}

/** What a set changes, as the route's body and the tool's input give it.
 *  Each value is checked by setPipelineState (checkOptions, the attach
 *  list), so it is passed on as it came. */
export type PipelineSetInput = { options?: unknown; workspaces?: unknown };

/**
 * Set the options or the attach list of one pipeline, then give its row
 * (no counts). The one function of PATCH /api/pipelines/:id and
 * `pipeline_set`. No rights check here: the route's policy and the tool's
 * scope (area `settings`) are the check. It stores only; it starts no run.
 */
export async function setPipeline(
  ownerId: string,
  loginId: string | null,
  id: string,
  input: PipelineSetInput,
): Promise<{ ok: true; row: PipelineRow } | { ok: false; error: string; missing?: true }> {
  const p = BUILTIN_PIPELINES.find((x) => x.id === id);
  if (!p) {
    return {
      ok: false,
      error: `There is no pipeline "${id.slice(0, 40)}". Find the id with pipeline_list.`,
      missing: true,
    };
  }
  const change = {
    ...(input.options !== undefined ? { options: input.options } : {}),
    ...(input.workspaces !== undefined ? { workspaces: input.workspaces } : {}),
  } as PipelineStateChange;
  const res = await setPipelineState(ownerId, loginId, p, change);
  return res.ok ? { ok: true, row: rowOf(p, res.state) } : res;
}

/** Which pipeline read a file's database, for the Data view: the file read
 *  in the caller's scope, then its stamp. Null with no database, or one
 *  built before stamps. */
export async function fileReadBy(
  ownerId: string,
  fileId: string,
): Promise<FileDatabaseReadBy | null> {
  const row = await fileDataRow(ownerId, fileId);
  const stamp = row ? await readFileDbStamp(row.id, fileSha256Of(row)) : null;
  return stamp ? { pipeline: stamp.pipeline_id, version: stamp.pipeline_version } : null;
}

export const pipeline_list: BuiltinToolDef = {
  slug: 'pipeline_list',
  // An Admin user's own client reads it; no agent is granted it (no tool
  // group holds it in phase 1).
  mcpOnly: true,
  policy: {
    effect: 'read',
    spends: 'none',
    // The route's area (GET /api/pipelines). Not systemWhole: the tool runs
    // in the caller's scope, and only its count of the file rows goes to
    // the system pool (areaSystem in listPipelines), as brain_capacity.
    scope: { area: 'settings' },
    recipe: { step: 'forbidden' },
  },
  name: 'List pipelines',
  description:
    "List the pipelines that read files into their databases: id, name, `description`, version, `kind` ('reader' or 'after'), the extensions each reads, weight, shapes, the tabs an `after` pipeline writes, its `options` (each with its spec and the value in force), its `workspaces` ('all' for a reader, else the ids it is attached to), how many files each read (`files`), how many of those are not current (`older`: an older version, before stamps, or other options), the files by version (`versions`), and its `runs` with `lastRunAt`. Numbers only, never a file. `countsPartial` says the count stopped at its cap. The same list as the Settings screen. Read-only. To change a pipeline use `pipeline_set`; to read the older files again use `pipeline_reread`. For the rows of one file use `file_sql`.",
  inputSchema: { type: 'object', properties: {} },
  handler: async (_input, ctx) => ({ ok: true, output: await listPipelines(ctx.ownerId) }),
};

export const pipeline_set: BuiltinToolDef = {
  slug: 'pipeline_set',
  // An Admin user's own client sets it; no agent is granted it (no tool
  // group holds it in phase 2).
  mcpOnly: true,
  policy: {
    matrix: { none: 'a pipeline is not an item' },
    effect: 'write',
    spends: 'none',
    // The route's area (PATCH /api/pipelines/:id). systemWhole: it reads and
    // writes pipeline_state and reads workspaces only, and takes no item id.
    scope: { area: 'settings', systemWhole: true },
    peerRisky: true,
    idempotent: true, // a set
    recipe: { step: 'forbidden' },
    clientSourced: CS.always('changes how files are read on this box'),
  },
  name: 'Set a pipeline',
  description:
    "Set the options of one pipeline, or the workspaces an `after` pipeline is attached to. `id` is a pipeline id from `pipeline_list`. `options` names only the options to change; the others keep their value. A value must fit its spec: a number in its range, yes or no, or a list of words. `workspaces` replaces the attach list of an `after` pipeline with these workspace ids; `[]` switches it off (it then does nothing). A reader is used in every workspace and refuses `workspaces`. It stores the change and gives the pipeline's row back. It starts no run and reads no file again: a new upload uses the change.",
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        pattern: '^[a-z0-9][a-z0-9-]{0,39}$',
        description: "The pipeline's id, e.g. 'site-tags'.",
      },
      options: {
        type: 'object',
        // The names are the pipeline's own: checkOptions refuses one it
        // does not declare.
        additionalProperties: true,
        description: 'Option names and their new values, e.g. {"not_tags": ["NOTE", "REV"]}.',
      },
      workspaces: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 200,
        description:
          'The workspace ids an `after` pipeline is attached to. Replaces the list. [] switches it off.',
      },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const res = await setPipeline(ctx.ownerId, actingLoginId(ctx.surface), String(input.id ?? ''), {
      options: input.options,
      workspaces: input.workspaces,
    });
    return res.ok ? { ok: true, output: res.row } : { ok: false, error: res.error };
  },
};

export const PIPELINE_TOOLS: readonly BuiltinToolDef[] = [
  pipeline_list,
  pipeline_set,
  pipeline_run,
  pipeline_test,
  pipeline_reread,
];
