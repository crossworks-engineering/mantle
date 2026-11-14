/**
 * The built-in pipelines: the readers in the core that make a file's
 * database. A pipeline is built in because it is in this list. Each one runs
 * in this process behind its adapter (ADAPTERS in
 * packages/content/src/file-database.ts); its code did not move.
 *
 * builtinForExt is the one place that picks a database reader. Each
 * extension has exactly one built-in (builtin.test.ts holds it), and
 * FILE_DB_EXTS (../file-dbs.ts) is the union of their extensions, in this
 * order.
 *
 * Raise a version when the rows a reader writes change (docs/pipelines.md).
 * The version pin (builtin.pins.json) fails when what a version promises
 * changes and the version did not: match, produces, each option's name,
 * type and default, or a needed tab or column of a promised shape. An
 * optional column needs no new version. The pin cannot see a change deep in
 * a reader's code.
 *
 * A pipeline with `match.after` reads the tabs of another's database. It is
 * never the reader of an extension (readersByExt), and defaultState puts it
 * in no workspace (docs/pipelines.md).
 */
import { CAD_EXTS } from '../slug';
import { PIPELINE_API, type PipelineManifest, type PipelineStamp } from './contract';
import { shapesOf } from './shapes';

const core = <Id extends string>(
  m: Pick<PipelineManifest, 'name' | 'version' | 'match' | 'produces' | 'needs' | 'options'> & {
    id: Id;
  },
): PipelineManifest & { id: Id } => ({
  ...m,
  api: PIPELINE_API,
  runtime: 'core',
  start: 'upload',
});

export const BUILTIN_PIPELINES = [
  core({
    id: 'sheet',
    name: 'Spreadsheet',
    version: '1.0.0',
    match: { ext: ['xlsx', 'xls', 'csv'] },
    produces: {},
    needs: { weight: 'light' },
  }),
  core({
    id: 'plan-mspdi',
    name: 'Microsoft Project plan',
    version: '1.0.0',
    match: { ext: ['xml'] },
    produces: {},
    needs: { weight: 'light' },
  }),
  core({
    id: 'drawing-pdf',
    name: 'PDF drawing',
    version: '1.0.0',
    match: { ext: ['pdf'] },
    produces: { shapes: ['pdf-file-v1'] },
    needs: { weight: 'light' },
  }),
  core({
    id: 'plot-dwf',
    name: 'DWF plot set',
    version: '1.0.0',
    match: { ext: ['dwf'] },
    produces: {},
    needs: { weight: 'heavy' },
  }),
  core({
    id: 'drawing-cad',
    name: 'CAD drawing',
    version: '1.0.0',
    // The CAD list of ../slug.ts, so a new CAD format is still one line there.
    match: { ext: [...CAD_EXTS] },
    produces: { shapes: ['drawing-v1', 'circuit-v1'] },
    needs: { weight: 'heavy' },
  }),
] as const;

/** A built-in, with its id as a literal. */
export type BuiltinPipeline = (typeof BUILTIN_PIPELINES)[number];

/** The ids of the built-ins. The adapters are keyed by it, so a built-in
 *  with no adapter, or an adapter of no built-in, does not compile. */
export type BuiltinId = BuiltinPipeline['id'];

/** Whether a pipeline reads the tabs of another's database: it is not a
 *  reader of files. */
export function isAfterPipeline(manifest: Pick<PipelineManifest, 'match'>): boolean {
  return manifest.match.after !== undefined;
}

/** Extension -> its reader. A pipeline with `match.after` is never one. */
export function readersByExt<P extends PipelineManifest>(
  pipelines: readonly P[],
): ReadonlyMap<string, P> {
  return new Map(
    pipelines
      .filter((p) => !isAfterPipeline(p))
      .flatMap((p) => p.match.ext.map((ext) => [ext, p] as const)),
  );
}

const BY_EXT: ReadonlyMap<string, BuiltinPipeline> =
  readersByExt<BuiltinPipeline>(BUILTIN_PIPELINES);

/** The built-in that makes a database of this extension, or null. */
export function builtinForExt(ext: string): BuiltinPipeline | null {
  return BY_EXT.get(ext) ?? null;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** Whether version `a` is lower than `b`, as numbers: "1.9.0" is lower than
 *  "1.10.0". A version that is not `x.y.z` counts as lower, so a file with a
 *  stamp nothing can read gets a good one. If `b` is not `x.y.z`, the
 *  answer is false. */
export function versionBelow(a: string, b: string): boolean {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (!y) return false;
  if (!x) return true;
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return d < 0;
  }
  return false;
}

/** The `_meta` keys of the stamp, for a read: the four of phase 1 first,
 *  then the two that are written only when not ''. A write gets only the
 *  keys that are there. */
export const PIPELINE_STAMP_KEYS = [
  'pipeline_id',
  'pipeline_version',
  'pipeline_api',
  'shapes',
  'pipeline_options',
  'pipelines_after',
] as const satisfies readonly (keyof PipelineStamp)[];

/** The stamp a database of these tabs gets: the shapes are the ones the
 *  pipeline promises that the tabs carry, so a stamp never names a shape
 *  the file does not have (an older reader's drawing, a DXF with no bones).
 *  `optionsHash` (optionsHash in ./options.ts): '' for all defaults, and
 *  then there is no `pipeline_options` key, as in phase 1. */
export function pipelineStampOf(
  manifest: PipelineManifest,
  tabs: readonly { name: string; columns: readonly string[] }[],
  optionsHash = '',
): PipelineStamp {
  const promised = new Set(manifest.produces.shapes ?? []);
  return {
    pipeline_id: manifest.id,
    pipeline_version: manifest.version,
    pipeline_api: String(manifest.api),
    shapes: shapesOf(tabs)
      .filter((s) => promised.has(s))
      .join(','),
    ...(optionsHash !== '' ? { pipeline_options: optionsHash } : {}),
  };
}

/** Where a pipeline runs when a box set nothing: the defaults of the code.
 *  A reader is used in every workspace. An `after` pipeline is attached to
 *  no workspace, so it does nothing until an Admin attaches it. Off is
 *  attached to no workspace: there is no switch. */
export function defaultState(manifest: Pick<PipelineManifest, 'match'>): {
  workspaces: 'all' | readonly string[];
} {
  return isAfterPipeline(manifest) ? { workspaces: [] } : { workspaces: 'all' };
}
