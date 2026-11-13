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
 * The version pin (builtin.pins.json) fails when a manifest or one of its
 * shapes changes and the version did not; it cannot see a change deep in a
 * reader's code.
 */
import { CAD_EXTS } from '../slug';
import { PIPELINE_API, type PipelineManifest, type PipelineStamp } from './contract';
import { shapesOf } from './shapes';

const core = <Id extends string>(
  m: Pick<PipelineManifest, 'name' | 'version' | 'match' | 'produces' | 'needs'> & { id: Id },
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
    version: '1.0.1',
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

const BY_EXT: ReadonlyMap<string, BuiltinPipeline> = new Map(
  BUILTIN_PIPELINES.flatMap((p) => p.match.ext.map((ext) => [ext, p] as const)),
);

/** The built-in that makes a database of this extension, or null. */
export function builtinForExt(ext: string): BuiltinPipeline | null {
  return BY_EXT.get(ext) ?? null;
}

/** The four `_meta` keys of the stamp. */
export const PIPELINE_STAMP_KEYS = [
  'pipeline_id',
  'pipeline_version',
  'pipeline_api',
  'shapes',
] as const satisfies readonly (keyof PipelineStamp)[];

/** The stamp a database of these tabs gets: the shapes are the ones the
 *  pipeline promises that the tabs carry, so a stamp never names a shape
 *  the file does not have (an older reader's drawing, a DXF with no bones). */
export function pipelineStampOf(
  manifest: PipelineManifest,
  tabs: readonly { name: string; columns: readonly string[] }[],
): PipelineStamp {
  const promised = new Set(manifest.produces.shapes ?? []);
  return {
    pipeline_id: manifest.id,
    pipeline_version: manifest.version,
    pipeline_api: String(manifest.api),
    shapes: shapesOf(tabs)
      .filter((s) => promised.has(s))
      .join(','),
  };
}
