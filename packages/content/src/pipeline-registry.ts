/**
 * The pipelines of a box: the ONE place that gives them (docs/pipelines.md,
 * "The registry"). Every consumer asks boxPipelines for the box it works
 * for and reads the list, the reader of an extension, the router of a file
 * type, the `after` pipelines, the ids a person acts on and the file types
 * that get a database from the answer. A consumer with no owner in hand
 * gets the answer (or the part of it it needs) from its caller, as a
 * parameter: it has no second way to the list.
 *
 * The list is the built-ins (BUILTIN_PIPELINES, @mantle/files), in their
 * order, then the own pipelines of the box (docs/pipelines.md, "Own
 * pipelines"), by id. A built-in is taken as it is: builtin.test.ts runs
 * the one manifest check (checkManifest) on each, so a release holds it.
 * An own row is checked on every read with the same check and the rules of
 * an own pipeline. A built-in always wins an id or an extension. An own row
 * that fails the check, clashes, sits on a box that runs curated
 * pipelines only (ownPipelinesAllowed), or whose files are not on disk
 * (when the caller asks the disk) is in `problems` with its sentence:
 * it is in `all` and `byId` (so the list shows it and the Admin can remove
 * it), and in nothing that runs (`readerFor`, `dbExts`, `acted`).
 *
 * The registry reads only `pipeline.json` of a package (ownManifests),
 * never the rest. The disk is asked only when the caller gives its answer
 * (`onDisk`, diskAnswer in pipeline-folder.ts): web, the one process with
 * the folder, gives it; a row whose files are not there is in `problems`
 * (NOT_ON_DISK). Every other process, which has no folder, gives none, and
 * a job there fails as `bad_request` at the parser. No cache: the answer is built on every call, as the state
 * of a pipeline is read fresh on every call (live-derived over stored); the
 * maps are built once for each answer.
 *
 * The parser is not a consumer: its index is the image's
 * (server/parser/src/pipeline-index.ts), and it reads an own package from
 * its read-only mount by the checked id and version (pipeline-job.ts).
 */
import { CURATED_ONLY, ownPipelinesAllowed } from '@mantle/config';
import {
  BUILTIN_PIPELINES,
  PIPELINE_API,
  checkManifest,
  dbExtsOf,
  isAgent,
  roleOf,
  isRouter,
  readerFor,
  readersByExt,
  routerFor,
  type PipelineManifest,
  type PipelineSource,
} from '@mantle/files';
import type { PipelineProblemCode } from '@mantle/client-types';
import { ownManifests } from './pipeline-state';

/** One pipeline of a box, with where it comes from. `draft`: the word of
 *  the draft folder a test runs a package from (pipeline_test with
 *  `files`); the registry of a box never holds one, and an own manifest may
 *  not carry the key (checkManifest). */
export type BoxPipeline = PipelineManifest & { source: PipelineSource; draft?: string };

export type BoxPipelines = {
  /** Built-ins in their order, then own pipelines by id, a row with a
   *  problem too. */
  all: readonly BoxPipeline[];
  byId(id: string): BoxPipeline | null;
  /** The reader of a file of this extension whose router named `kind`
   *  (readerFor, @mantle/files); with no kind, the reader of the
   *  extension. Null: no reader takes the file. */
  readerFor(ext: string, kind?: string): BoxPipeline | null;
  /** The router of this file type, or null. */
  routerFor(ext: string): BoxPipeline | null;
  /** The `after` pipelines, in the order of `all`: the order the chain
   *  runs them in. Built-ins only in phase 3. */
  after: readonly BoxPipeline[];
  /** The Agents: they ask an AI worker, in a run of their own, never in the
   *  upload's chain (docs/pipelines.md, "Agents"). Built-ins only. */
  agents: readonly BoxPipeline[];
  /** The pipelines a person acts on by id (set, run, re-read, test, the
   *  `pipeline-reread` task): all that run but the routers, which run
   *  nothing by themselves. */
  acted: readonly BoxPipeline[];
  /** The file types that get a database: the readers' extensions. */
  dbExts: ReadonlySet<string>;
  /** The own pipelines of the box that do not run, by id, with a plain
   *  sentence. A row whose id a built-in has now is here only, not in
   *  `all`: its id is the built-in's. */
  problems: ReadonlyMap<string, string>;
  /** The same rows, by id, with a short fixed word for the problem
   *  (PipelineProblemCode), so a client need not read the sentence. */
  problemCodes: ReadonlyMap<string, PipelineProblemCode>;
};

/** An own row as the registry reads it: its id and the text of its
 *  manifest (null: none, or not text). */
export type OwnRow = { id: string; manifest: string | null };

/** The sentence of an own row whose files are not on disk (a restore of
 *  Postgres alone). */
export const NOT_ON_DISK =
  'The files of this package are not on disk. Install it again with the same files.';

/** Whether the files of an own package are on disk (packageOnDisk). */
export type OnDisk = (id: string, version: string) => Promise<boolean>;

/** The sentence of an own row whose id a built-in has now. */
export const BUILTIN_HAS_ID =
  'A built-in now has this id. Remove it, and install it with another id.';

/** A stand-in manifest for a row whose own manifest cannot be used: its
 *  name and version when they are text, so the list can show the row and
 *  its problem. It runs nothing (it is in `problems`). */
function placeholderOf(id: string, raw: unknown): PipelineManifest {
  const m = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    id,
    name: typeof m.name === 'string' && m.name.trim() ? m.name.slice(0, 80) : id,
    description: typeof m.description === 'string' ? m.description.slice(0, 300) : '',
    version: typeof m.version === 'string' ? m.version.slice(0, 40) : '',
    api: PIPELINE_API,
    runtime: m.runtime === 'python' ? 'python' : 'bun',
    start: 'upload',
    match: { ext: [] },
    produces: {},
    needs: { weight: 'light' },
  };
}

/** The first rule of the box an own row breaks, or null. `taken`: the
 *  extensions the readers before it read. */
function ownProblem(
  row: OwnRow,
  parsed: unknown,
  taken: ReadonlyMap<string, BoxPipeline>,
): { problem: string; code: PipelineProblemCode } | { manifest: PipelineManifest } {
  if (!ownPipelinesAllowed()) return { problem: CURATED_ONLY, code: 'curated-only' };
  if (BUILTIN_PIPELINES.some((b) => b.id === row.id)) {
    return { problem: BUILTIN_HAS_ID, code: 'builtin-id' };
  }
  if (parsed === undefined) {
    return { problem: 'Its pipeline.json is not JSON. Install it again.', code: 'manifest' };
  }
  const checked = checkManifest(parsed, 'own');
  if (!checked.ok) {
    return { problem: `Its manifest no longer passes: ${checked.error}`, code: 'manifest' };
  }
  if (checked.manifest.id !== row.id) {
    return { problem: 'Its manifest names another id. Install it again.', code: 'manifest' };
  }
  const clash = checked.manifest.match.ext.find((e) => taken.has(e));
  if (clash) {
    const by = taken.get(clash)!;
    return {
      problem: `${by.source === 'builtin' ? 'A built-in' : `The pipeline ${by.id}`} now reads .${clash}. Remove this one, or install it for another extension.`,
      code: 'ext-taken',
    };
  }
  return { manifest: checked.manifest };
}

/** The pipelines of a box from its own rows: the built-ins, then each own
 *  row by id, checked. Pure but for the curated switch. The one builder:
 *  boxPipelines gives it the rows of the box (and `gone`, the ids whose
 *  files are not on disk); a draft test (pipeline_test with `files`) adds
 *  its draft in place of the row of its id. */
export function pipelinesOf(
  rows: readonly OwnRow[],
  draft?: BoxPipeline,
  gone?: ReadonlySet<string>,
): BoxPipelines {
  const builtins: BoxPipeline[] = BUILTIN_PIPELINES.map((p) => ({ ...p, source: 'builtin' }));
  const runs: BoxPipeline[] = [...builtins];
  const all: BoxPipeline[] = [...builtins];
  const problems = new Map<string, string>();
  const problemCodes = new Map<string, PipelineProblemCode>();
  const taken = new Map<string, BoxPipeline>(readersByExt(builtins));
  const own = [...rows]
    .filter((r) => r.id !== draft?.id)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const row of own) {
    let parsed: unknown;
    try {
      parsed = row.manifest === null ? undefined : (JSON.parse(row.manifest) as unknown);
    } catch {
      parsed = undefined;
    }
    const got = ownProblem(row, parsed, taken);
    if ('problem' in got) {
      problems.set(row.id, got.problem);
      problemCodes.set(row.id, got.code);
      // A row whose id a built-in has now is not listed beside it: the id
      // is the built-in's. pipeline_remove still removes it.
      if (got.problem !== BUILTIN_HAS_ID)
        all.push({ ...placeholderOf(row.id, parsed), source: 'own' });
      continue;
    }
    const p: BoxPipeline = { ...got.manifest, source: 'own' };
    all.push(p);
    // Its extensions stay its own while its files are gone.
    for (const e of p.match.ext) taken.set(e, p);
    if (gone?.has(p.id)) {
      problems.set(p.id, NOT_ON_DISK);
      problemCodes.set(p.id, 'not-on-disk');
    } else runs.push(p);
  }
  // A draft is checked by its test before it gets here (installCheck).
  if (draft) {
    all.push(draft);
    runs.push(draft);
  }
  const byId = new Map(all.map((p) => [p.id, p]));
  const readers = readersByExt(runs);
  return {
    all,
    byId: (id) => byId.get(id) ?? null,
    readerFor: (ext, kind) =>
      kind === undefined ? (readers.get(ext) ?? null) : readerFor(runs, ext, kind),
    routerFor: (ext) => routerFor(runs, ext),
    after: runs.filter((p) => roleOf(p) === 'after'),
    agents: runs.filter(isAgent),
    acted: runs.filter((p) => !isRouter(p)),
    dbExts: dbExtsOf(runs),
    problems,
    problemCodes,
  };
}

/** The pipelines of the box of this owner. `db`: a transaction the caller
 *  holds, for its one read of the own rows (the corpus audit's read-only
 *  one); the system pool by default. `onDisk`: the disk's answer
 *  (diskAnswer), asked of each own row that runs. */
export async function boxPipelines(
  ownerId: string,
  db?: Parameters<typeof ownManifests>[1],
  onDisk?: OnDisk,
): Promise<BoxPipelines> {
  const rows = await ownManifests(ownerId, db);
  const box = pipelinesOf(rows);
  if (!onDisk) return box;
  const gone = new Set<string>();
  for (const p of box.all) {
    if (p.source === 'own' && !box.problems.has(p.id) && !(await onDisk(p.id, p.version))) {
      gone.add(p.id);
    }
  }
  return gone.size ? pipelinesOf(rows, undefined, gone) : box;
}
