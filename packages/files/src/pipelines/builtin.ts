/**
 * The built-in pipelines: the readers in the core that make a file's
 * database. A pipeline is built in because it is in this list. Each is a
 * package in the image (./pkg/<id>/step.ts), run by the parser job
 * `pipelineRun`; since MV5 and MV6 no built-in runs in this process.
 *
 * The list is the input of the registry (boxPipelines,
 * packages/content/src/pipeline-registry.ts), the one place that gives the
 * pipelines of a box; every consumer asks it, and the helpers here take
 * the list it holds. Each extension has exactly one built-in
 * (builtin.test.ts holds it). The parser reads the list too: its index is
 * the image's (server/parser/src/pipeline-index.ts).
 *
 * Raise a version when the rows a reader writes change (docs/pipelines.md).
 * The version pin (builtin.pins.json) fails when what a version promises
 * changes and the version did not: match, produces, each option's name,
 * type and default, or a needed tab or column of a promised shape. An
 * optional column needs no new version. The pin cannot see a change deep in
 * a reader's code.
 *
 * A pipeline with `match.after` reads the tabs of another's database. It is
 * never the reader of an extension (readersByExt). Like a reader it is on
 * in every workspace until an Admin switches it off in one
 * (docs/pipelines.md, "Where a pipeline runs"). Its body is the tabs of the shape it
 * reads (afterSheetsOf, packages/content/src/file-database.ts), and it
 * writes only the tabs of its `produces.tabs`, through the patch.
 *
 * A router (`router: true`) names the kind of a file; the reader that
 * claims the kind (`match.kind`) reads it (readerFor). A router is no
 * reader either: it has no database, no options and no run of its own.
 * The PDF router is a package: one parser job names the kind, then the
 * reader's job reads the file (readSheets,
 * packages/content/src/file-database.ts).
 */
import { TITLE_BLOCK_MM } from '../pdf-rows';
import { CAD_EXTS } from '../slug';
import { PIPELINE_API, type PipelineManifest, type PipelineStamp, type ShapeId } from './contract';
import { shapesOf } from './shapes';

// The match keeps its own type, so an `after` built-in (one with
// `match.after`) is a type of its own: AfterPipeline below.
type BuiltinFields<Id extends string, Match extends PipelineManifest['match']> = Pick<
  PipelineManifest,
  'name' | 'description' | 'version' | 'produces' | 'needs' | 'options'
> & {
  id: Id;
  match: Match;
};

// A router: `router: true` as a literal, so RouterPipeline below is its own
// type, apart from the readers. A package in the image
// (./pkg/<id>/step.ts), as pkg() below.
const pkgRouter = <Id extends string, Match extends PipelineManifest['match']>(
  m: Pick<PipelineManifest, 'name' | 'description' | 'version' | 'produces' | 'needs'> & {
    id: Id;
    match: Match;
  },
): PipelineManifest & { id: Id; match: Match; router: true; runtime: 'bun'; entry: 'step.ts' } => ({
  ...m,
  api: PIPELINE_API,
  runtime: 'bun',
  entry: 'step.ts',
  start: 'upload',
  router: true,
});

// A package in the image (./pkg/<id>/step.ts), run by
// the parser job `pipelineRun`. Its id must be a key of ./pkg/index.ts
// (builtin.test.ts holds it). `runtime` and `entry` are not in the version pin.
export const pkg = <Id extends string, Match extends PipelineManifest['match']>(
  m: BuiltinFields<Id, Match>,
): PipelineManifest & { id: Id; match: Match; runtime: 'bun'; entry: 'step.ts' } => ({
  ...m,
  api: PIPELINE_API,
  runtime: 'bun',
  entry: 'step.ts',
  start: 'upload',
});

// A Python package in the image: its entry is a file of the CAD tier
// (server/parser/cad/<entry>), run with the tier's venv by the parser job
// `pipelineRun` as a child (pythonStep), as an own Python step is. It has no
// key in ./pkg/index.ts, which holds Bun loaders (builtin.test.ts holds the
// file). `runtime` and `entry` are not in the version pin.
const pkgPython = <
  Id extends string,
  Entry extends string,
  Match extends PipelineManifest['match'],
>(
  m: BuiltinFields<Id, Match> & { entry: Entry },
): PipelineManifest & { id: Id; match: Match; runtime: 'python'; entry: Entry } => ({
  ...m,
  api: PIPELINE_API,
  runtime: 'python',
  start: 'upload',
});

export const BUILTIN_PIPELINES = [
  pkg({
    id: 'sheet',
    name: 'Spreadsheet',
    description:
      'Reads an Excel workbook or a CSV file and writes one tab for each sheet, with its rows and columns as they are in the file.',
    version: '1.0.0',
    match: { ext: ['xlsx', 'xls', 'csv'] },
    produces: {},
    // The deadline the old grid job had (PARSER_JOB_TIMEOUT_MS.grid). A CSV,
    // read in the brain's process before the move, gets the same.
    needs: { weight: 'light', timeMs: 120_000 },
  }),
  pkg({
    id: 'plan-mspdi',
    name: 'Microsoft Project plan',
    description:
      'Reads a Microsoft Project plan saved as XML and writes its tasks, resources and assignments as tabs.',
    version: '1.0.0',
    match: { ext: ['xml'] },
    produces: {},
    // The deadline of the job it ran in before the move (the grid job): the
    // parser server kills its pipelineRun job at this time.
    needs: { weight: 'light', timeMs: 120_000 },
  }),
  // The PDF router: the kind rules of ../pdf-kind.ts, and for an unsure file
  // the decider's answer (at most one ask). A package (./pkg/pdf-router):
  // one parser job, then the reader that claims the kind reads the file.
  pkgRouter({
    id: 'pdf-router',
    name: 'PDF router',
    description:
      'Names the kind of a PDF from its pages: a P&ID, an isometric, a scan, another drawing or a document. When its rules are unsure it asks the decider once, at most. The reader that claims the kind reads the file. It writes no tabs.',
    version: '1.0.0',
    match: { ext: ['pdf'] },
    // The ten kinds of PDF_KINDS (../pdf-kind.ts). The rules name six; the
    // decider may also answer the four marked, for an unsure file.
    produces: {
      kinds: [
        { kind: 'pid' },
        { kind: 'pfd', decider: true },
        { kind: 'isometric' },
        { kind: 'equipment_drawing', decider: true },
        { kind: 'datasheet', decider: true },
        { kind: 'table', decider: true },
        { kind: 'scan' },
        { kind: 'other_drawing' },
        { kind: 'document' },
        { kind: 'unsure' },
      ],
    },
    // The deadline of the old path's job (PARSER_JOB_TIMEOUT_MS.pdfDrawing).
    needs: { weight: 'light', timeMs: 240_000, workers: { decider: 1 } },
  }),
  pkg({
    id: 'drawing-pdf',
    name: 'PDF drawing',
    description:
      'Reads the words of a PDF drawing with their place on each page, and writes them with their region (such as the title block), its pages, and a File tab with the kind of the file.',
    version: '1.0.0',
    // Every kind the router names but `document`: a document gets no
    // database. An unsure PDF gets one, as before the router. A new claim
    // changes the pin and no row, so the version stays (docs/pipelines.md,
    // "The router").
    match: {
      ext: ['pdf'],
      kind: [
        'pid',
        'pfd',
        'isometric',
        'equipment_drawing',
        'datasheet',
        'table',
        'scan',
        'other_drawing',
        'unsure',
      ],
    },
    produces: { shapes: ['pdf-file-v1'] },
    // The deadline of the old path's job (pdfDrawing: 240 s). It asks no
    // model: the sketch read of a scan is a core path (pdf-sketch.ts).
    needs: { weight: 'light', timeMs: 240_000 },
    // The title block box (../pdf-rows.ts). The defaults are today's box, so
    // with them no row changes and the version stays.
    options: {
      title_block_width_mm: {
        type: 'number',
        label: 'Title block width (mm)',
        help:
          'Words in the lower right corner, this wide on paper, are flagged as title block. ' +
          'For new uploads; a file read before keeps its rows until it is read again. The kind of a file does not change with it.',
        default: TITLE_BLOCK_MM.width,
        min: 50,
        max: 420,
      },
      title_block_height_mm: {
        type: 'number',
        label: 'Title block height (mm)',
        help: 'Words in the lower right corner, this high on paper, are flagged as title block.',
        default: TITLE_BLOCK_MM.height,
        min: 20,
        max: 300,
      },
    },
  }),
  pkg({
    id: 'plot-dwf',
    name: 'DWF plot set',
    description:
      'Reads a DWF plot set and writes its sheets, their layers and their labels as tabs.',
    version: '1.0.0',
    match: { ext: ['dwf'] },
    produces: {},
    // The deadline of the old path's job for this read (the job `grid`,
    // PARSER_JOB_TIMEOUT_MS in ../parser-wire.ts), so a DWF that fit before
    // fits now and a slow one gets no more time than before.
    needs: { weight: 'heavy', timeMs: 120_000 },
  }),
  pkg({
    id: 'drawing-cad',
    name: 'CAD drawing',
    description:
      'Reads a DWG, DXF or DGN drawing and writes its texts, blocks, layers and lines as tabs, with the circuit tabs when the drawing has circuit layers.',
    version: '1.0.0',
    // The CAD list of ../slug.ts, so a new CAD format is still one line there.
    match: { ext: [...CAD_EXTS] },
    produces: { shapes: ['drawing-v1', 'circuit-v1'] },
    // The deadline of the old path's job for this read (the job `dwgRender`,
    // 240 s), so a drawing that fit before fits now. One step gives the
    // tabs, the text and the picture (./pkg/drawing-cad/step.ts).
    needs: { weight: 'heavy', timeMs: 240_000 },
  }),
  // Raster and plot drawings: a 1-bit scan (TIF), an Imagenation SMF raster,
  // an HP-GL/2 plot (.000). Model-free, in Python (server/parser/cad/
  // iso_raster.py). Anything else of these types is `not_mine`: a photo
  // TIFF keeps the core's raw image read (docs/pipelines.md, "The raster
  // drawing reader").
  pkgPython({
    id: 'iso-raster',
    entry: 'iso_raster.py',
    name: 'Raster and plot drawing',
    description:
      'Reads a 1-bit scanned TIF drawing, an Imagenation SMF raster or an HP-GL/2 plot (.000): its size and the title the file names, as the tab Drawing, with pictures of the sheet. It asks no model. A photo TIF is left as it was.',
    version: '1.0.0',
    match: { ext: ['tif', 'tiff', 'smf', '000'] },
    produces: { text: true, pictures: true, table: false },
    // The lane comes from the extension (extractWeightOfExt): light. The
    // largest plot (1.36 gigapixels) peaked at 336 MB and took 16 s.
    needs: { weight: 'light', timeMs: 120_000 },
    options: {
      page_px: {
        type: 'number',
        label: 'Sheet picture width (px)',
        help: 'The longest side of the picture of the whole sheet. For new uploads.',
        default: 2800,
        min: 1000,
        max: 5000,
      },
      crops: {
        type: 'bool',
        label: 'Pictures of the title block',
        help: 'Also give the bottom band and the right side of the sheet, sharper, where a title block is.',
        default: true,
      },
    },
  }),
  // An `after` pipeline: it reads the Texts tab of a drawing's database and
  // adds the tab `Site tags`. Model-free, a package (./pkg/site-tags), one
  // parser job a run. On in every workspace, as every pipeline is.
  pkg({
    id: 'site-tags',
    name: 'Site tags',
    description:
      "Reads the Texts tab of a drawing's database and adds the tab Site tags: one row for each instrument tag, line number or equipment tag it finds. It never reads the file again and asks no model.",
    version: '1.0.0',
    match: { ext: [...CAD_EXTS, 'pdf'], after: 'texts-v1' },
    produces: { tabs: ['Site tags'] },
    // The time of the light parser jobs (text, grid). One run on the
    // largest made-up tab took about a second.
    needs: { weight: 'light', timeMs: 120_000 },
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

/** The ids of the built-ins, as literals. */
export type BuiltinId = BuiltinPipeline['id'];

/** The built-ins that read a file: no `match.after`, and not a router. */
export type ReaderPipeline = Exclude<
  BuiltinPipeline,
  { match: { after: string } } | { router: true }
>;
export type ReaderId = ReaderPipeline['id'];
/** The built-in routers: each names the kind of a file of its extensions. */
export type RouterPipeline = Extract<BuiltinPipeline, { router: true }>;
/** The `after` built-ins: they read the tabs of a reader's database. */
export type AfterPipeline = Extract<BuiltinPipeline, { match: { after: string } }>;
export type AfterId = AfterPipeline['id'];

/** Whether a pipeline reads the tabs of another's database: it is not a
 *  reader of files. */
export function isAfterPipeline(manifest: Pick<PipelineManifest, 'match'>): boolean {
  return manifest.match.after !== undefined;
}

/** Whether a manifest is a router: it names the kind of a file. */
export function isRouter(manifest: Pick<PipelineManifest, 'router'>): boolean {
  return manifest.router === true;
}

/** Whether a pipeline reads files: not an `after` pipeline, not a router. */
export function isReader(manifest: Pick<PipelineManifest, 'match' | 'router'>): boolean {
  return !isAfterPipeline(manifest) && !isRouter(manifest);
}

/** Extension -> its reader. An `after` pipeline or a router is never one. */
export function readersByExt<P extends PipelineManifest>(
  pipelines: readonly P[],
): ReadonlyMap<string, P> {
  return new Map(
    pipelines.filter(isReader).flatMap((p) => p.match.ext.map((ext) => [ext, p] as const)),
  );
}

/** The extensions the readers of this list read: the file types that get a
 *  database (the registry's `dbExts`, packages/content/src/pipeline-registry.ts),
 *  in the order of the list. An `after` pipeline reads a database and a
 *  router names a kind: neither is a file type of its own. */
export function dbExtsOf(pipelines: readonly PipelineManifest[]): ReadonlySet<string> {
  return new Set(pipelines.filter(isReader).flatMap((p) => p.match.ext));
}

/** The router of this file type in the list, or null: no router, the
 *  ranked list. */
export function routerFor<P extends PipelineManifest>(
  pipelines: readonly P[],
  ext: string,
): P | null {
  return pipelines.find((p) => isRouter(p) && p.match.ext.includes(ext)) ?? null;
}

/**
 * The reader in the list of a file of this extension whose router named
 * `kind`: the first reader that claims the kind (`match.kind`), else the
 * ranked list of the readers that claim no kind. Null: no reader takes the
 * file, and nothing runs (a PDF document). With no kind (no router, or none
 * named), the ranked list: the reader of the extension (readersByExt).
 */
export function readerFor<P extends PipelineManifest>(
  pipelines: readonly P[],
  ext: string,
  kind?: string,
): P | null {
  if (kind === undefined) return readersByExt(pipelines).get(ext) ?? null;
  const readers = pipelines.filter((p) => isReader(p) && p.match.ext.includes(ext));
  return (
    readers.find((p) => p.match.kind?.includes(kind)) ??
    readers.find((p) => p.match.kind === undefined) ??
    null
  );
}

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
 *  Every pipeline is on in every workspace: its off list is empty. An
 *  Admin can switch one off in a workspace (docs/pipelines.md, "Where a
 *  pipeline runs"); a router has no switch. */
export function defaultState(): { offIn: readonly string[] } {
  return { offIn: [] };
}
