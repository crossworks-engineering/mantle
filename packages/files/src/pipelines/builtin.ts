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
 * in no workspace (docs/pipelines.md). Its adapter is in AFTER_ADAPTERS
 * (packages/content/src/file-database.ts), and it writes only the tabs of
 * its `produces.tabs`, through the patch.
 */
import { CAD_EXTS } from '../slug';
import {
  PIPELINE_API,
  type PipelineManifest,
  type PipelineStamp,
  type ShapeId,
} from './contract';
import { shapesOf } from './shapes';

// The match keeps its own type, so an `after` built-in (one with
// `match.after`) is a type of its own: AfterPipeline below.
const core = <Id extends string, Match extends PipelineManifest['match']>(
  m: Pick<PipelineManifest, 'name' | 'version' | 'produces' | 'needs' | 'options'> & {
    id: Id;
    match: Match;
  },
): PipelineManifest & { id: Id; match: Match } => ({
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
  // An `after` pipeline: it reads the Texts tab of a drawing's database and
  // adds the tab `Site tags`. Model-free, in this process. Attached to no
  // workspace until an Admin attaches it.
  core({
    id: 'site-tags',
    name: 'Site tags',
    version: '1.0.0',
    match: { ext: [...CAD_EXTS, 'pdf'], after: 'texts-v1' },
    produces: { tabs: ['Site tags'] },
    needs: { weight: 'light' },
    options: {
      equipment_types: {
        type: 'words',
        label: 'Equipment type letters',
        help: 'Type letters that are always equipment, also when they read as an instrument code (EA, HX).',
        default: [],
        maxItems: 200,
        maxChars: 8,
      },
      instrument_codes: {
        type: 'words',
        label: 'More instrument codes',
        help: 'Device codes of this site that are instruments, beside the ISA letters (SDV, MOV).',
        default: [],
        maxItems: 200,
        maxChars: 8,
      },
      not_tags: {
        type: 'words',
        label: 'Words that are never a tag',
        help: 'Words of this site that look like the letters of a tag and are not one.',
        default: [],
        maxItems: 200,
        maxChars: 16,
      },
      line_services: {
        type: 'words',
        label: 'Line service codes',
        help: 'Service codes of line numbers written with no size part (P in P-1001-A1A).',
        default: [],
        maxItems: 200,
        maxChars: 8,
      },
    },
  }),
] as const;

/** A built-in, with its id as a literal. */
export type BuiltinPipeline = (typeof BUILTIN_PIPELINES)[number];

/** The ids of the built-ins. The adapters are keyed by it, so a built-in
 *  with no adapter, or an adapter of no built-in, does not compile. */
export type BuiltinId = BuiltinPipeline['id'];

/** The built-ins that read a file: the ones with no `match.after`. */
export type ReaderPipeline = Exclude<BuiltinPipeline, { match: { after: string } }>;
export type ReaderId = ReaderPipeline['id'];
/** The `after` built-ins: they read the tabs of a reader's database. */
export type AfterPipeline = Extract<BuiltinPipeline, { match: { after: string } }>;
export type AfterId = AfterPipeline['id'];

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

const BY_EXT = readersByExt<BuiltinPipeline>(BUILTIN_PIPELINES) as ReadonlyMap<
  string,
  ReaderPipeline
>;

/** The built-in that makes a database of this extension, or null. */
export function builtinForExt(ext: string): ReaderPipeline | null {
  return BY_EXT.get(ext) ?? null;
}

/** The `after` built-ins, in the order of BUILTIN_PIPELINES: the order the
 *  chain runs them in. */
export const AFTER_PIPELINES: readonly AfterPipeline[] = BUILTIN_PIPELINES.filter(
  (p): p is AfterPipeline => isAfterPipeline(p),
);

/**
 * The one match rule of an `after` pipeline: the file's extension is in
 * `match.ext`, and the real tabs of its database carry the shape
 * `match.after` (shapesOf on the tabs, never the stamp, so a database with
 * no stamp matches too).
 */
export function afterMatches(
  manifest: Pick<PipelineManifest, 'match'>,
  ext: string,
  tabs: readonly { name: string; columns: readonly string[] }[],
): boolean {
  const after = manifest.match.after;
  return (
    after !== undefined &&
    manifest.match.ext.includes(ext) &&
    shapesOf(tabs).includes(after as ShapeId)
  );
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
