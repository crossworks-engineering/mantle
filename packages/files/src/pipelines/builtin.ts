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
import {
  PIPELINE_API,
  PIPELINE_ASK_PAGE_MAX,
  PIPELINE_WINDOW_DEFAULT,
  type PipelineManifest,
  type PipelineStamp,
  type ShapeId,
} from './contract';
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

// An Agent: a package in the image that asks an AI worker of the box
// (docs/pipelines.md, "Agents"). Its step gets the file, and it runs as a
// job of its own after the build of an upload, or on demand.
// `input` is a literal, so AgentPipeline is a type of its own, apart from
// the readers.
const pkgAgent = <Id extends string, Match extends PipelineManifest['match']>(
  m: BuiltinFields<Id, Match>,
): PipelineManifest & {
  id: Id;
  match: Match;
  runtime: 'bun';
  entry: 'step.ts';
  input: 'file';
} => ({
  ...m,
  api: PIPELINE_API,
  runtime: 'bun',
  entry: 'step.ts',
  start: 'upload',
  input: 'file',
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
    // 1.0.1 (2026-11-17): the kind rules of PDF_KIND_RULES_VERSION 2.
    // 1.1.0 (2026-11-18): the kind `book` (PDF_KIND_RULES_VERSION 3).
    // 1.2.0 (2026-11-19): every office PDF is a book, whatever its size
    // (PDF_KIND_RULES_VERSION 4); the rules name `document` no more.
    // 1.2.1 (2026-11-20): a long file is a book by all its pages too
    // (PDF_KIND_RULES_VERSION 5).
    // 1.3.0 (2026-11-21): page types in shadow (plan page c607711a, M3):
    // part 2, one decider ask a page with its picture, in page windows,
    // where page asks are on (../../pdf-page-kinds.ts). The route does not
    // change. 1.4.0 (2026-11-23): page types live (M4) where pdf_kind is
    // live: the lanes of the pages name the file's Reader (pdfFrameKindOf);
    // a page is blank only when its picture is white and no image covers
    // it, and every page is drawn with large images.
    version: '1.4.0',
    match: { ext: ['pdf'] },
    // The eleven kinds of PDF_KINDS (../pdf-kind.ts). The rules name seven
    // (`book` by its own rule, bookOf); the decider may also answer the four
    // marked, for an unsure file.
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
        { kind: 'book' },
      ],
    },
    // The deadline of the old path's job (PARSER_JOB_TIMEOUT_MS.pdfDrawing),
    // a page window's job too. The decider: one ask a file (part 1, its step
    // gives one at most) and one a page (part 2), to the page cap of a file.
    needs: {
      weight: 'light',
      timeMs: 240_000,
      workers: { decider: PIPELINE_ASK_PAGE_MAX },
    },
  }),
  pkg({
    id: 'drawing-pdf',
    name: 'PDF drawing',
    description:
      'Reads the words of a PDF drawing with their place on each page, and writes them with their region (such as the title block or a table), its pages, the lines of a page whose text is drawn as strokes, and a File tab with the kind of the file.',
    // 1.1.0 (2026-11-17): a code in a table is no tag (column In a table),
    // the words of every page, the tab Segments, the column Vision text,
    // and the kind rules of PDF_KIND_RULES_VERSION 2.
    // 1.1.1 (2026-11-18): the kind rules of PDF_KIND_RULES_VERSION 3 (the
    // File tab's Rules version).
    // 1.1.2 (2026-11-19): the kind rules of PDF_KIND_RULES_VERSION 4.
    // 1.1.3 (2026-11-20): the kind rules of PDF_KIND_RULES_VERSION 5.
    // 1.1.4 (2026-11-21): the tab Pages may hold the page types (Kind from
    // `rules: ...`, Decider kind, Decider confidence), put in by the core
    // (../../pdf-page-kinds.ts). 1.1.5 (2026-11-23): Kind from may say
    // `decider` (M4, live), and Kind is then the answer's kind.
    // 1.1.6 (2026-11-24): the File tab's `Scan pages not read` and why (the
    // sketch read reads every scan page; a page it did not read is stated).
    version: '1.1.6',
    // Every kind the router names but `document` and `book`: a document gets
    // no database, and a book is the book reader's (`pdf-pages`). An unsure
    // PDF gets one, as before the router. A new claim changes the pin and
    // no row, so the version stays (docs/pipelines.md, "The router").
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
  // drawing_raster.py). Anything else of these types is `not_mine`: a photo
  // TIFF keeps the core's raw image read (docs/pipelines.md, "The raster
  // drawing reader").
  pkgPython({
    id: 'drawing-raster',
    entry: 'drawing_raster.py',
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
    // 1.0.1 (2026-11-17): a word of a PDF in a table (Region table) gives no tag.
    version: '1.0.1',
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
  // An `after` pipeline: the links between the things of a file of pages
  // (a PDF book's pages, tables and rows, or a PDF drawing's pages, tags and
  // lines), written as the tabs Links and Link nodes. Model-free, a package
  // (./pkg/links), one parser job a run. Its body is the shape pages-v1,
  // with every table tab the Tables index names (docs/pipelines.md,
  // "Links").
  pkg({
    id: 'links',
    name: 'Links',
    description:
      "Reads the pages, tables and rows of a PDF's database and adds the tabs Links and Link nodes: which page holds which table, which row names which code, tag or line number, and, for a piping specification, which class a page, row, code and material belong to. It asks no model.",
    version: '1.0.0',
    match: { ext: ['pdf'], after: 'pages-v1' },
    produces: { tabs: ['Links', 'Link nodes'] },
    // The time of the light parser jobs. A book of 1,000 pages and 2,436
    // tables took about a second of rules.
    needs: { weight: 'light', timeMs: 120_000 },
  }),
  // The first Agent: it reads the title block of a raster or plot
  // isometric. A package (./pkg/iso-title-block): its one step cuts two
  // pictures in the parser and asks the vision worker for each. It is no
  // reader of these extensions: the built-in Reader `drawing-raster` above
  // makes the file's database, and the Agent adds its tab to it. A file
  // that Reader does not take (a photo TIF) has no database, and the
  // Agent's run is skipped `no-database` (docs/pipelines.md).
  pkgAgent({
    id: 'iso-title-block',
    name: 'Isometric title block',
    description:
      'Reads the title block of a piping isometric that is a TIF scan, an SMF raster or an HP-GL plot, into the tab Title block. It runs after an upload and on demand, and asks a vision model at most two times for a file. It reads the files the built-in Reader drawing-raster read.',
    version: '1.0.0',
    match: { ext: ['tif', 'tiff', 'smf', '000'] },
    produces: { tabs: ['Title block'] },
    // One step and no model in it: the time of the other heavy jobs of
    // one sheet (plot-dwf). The two asks are the cap of a file.
    needs: { weight: 'heavy', timeMs: 120_000, workers: { vision: 2 } },
  }),
  // The PDF Agent: it reads a PDF drawing the router called a scan, an
  // isometric, an other drawing or unsure, page by page, into the tabs
  // Title block and Sheet list (./pkg/pdf-sheet-read). The Reader
  // `drawing-pdf` makes the file's database; the core gives the step the
  // kind stored in it, and the Reader's options for the title block box.
  // 1.2.0 (2026-11-23, M4): it reads the drawing-lane pages the core
  // names (by the page types), a book's drawing pages too; its kinds are
  // the core's check, so a file of another kind runs no job.
  pkgAgent({
    id: 'pdf-sheet-read',
    name: 'PDF sheet read',
    description:
      "Reads the title block and the tags, line numbers and sheet numbers of a PDF drawing (a scan, an isometric, another drawing or unsure) and of a book's drawing pages into the tabs Title block and Sheet list. Runs after an upload and on demand; at most 31 vision asks a file.",
    version: '1.2.0',
    match: { ext: ['pdf'], kind: ['scan', 'isometric', 'unsure', 'other_drawing', 'book'] },
    options: {
      more_fields: {
        type: 'words',
        label: 'More title block fields',
        help: 'Fields of this site to read from the title block, one word each; an underscore is a space (PAINT_SYSTEM).',
        default: [],
        maxItems: 14,
        maxChars: 16,
      },
      pages: {
        type: 'number',
        label: 'Pages to read',
        help: 'The pages of a file to read, from page 1. Each page has three asks (the whole page and its two halves), page 1 one more for its title block.',
        default: 10,
        min: 1,
        max: 10,
      },
    },
    produces: { tabs: ['Title block', 'Sheet list'] },
    // One step and no model in it: the pictures of up to 10 pages and
    // their halves, drawn in the parser's pdfjs child. The 31 asks are the
    // cap of a file.
    needs: { weight: 'heavy', timeMs: 240_000, workers: { vision: 31 } },
  }),
  // The book reader (the large-PDF plan, page 4ff4d4e5, sections 3.2 and
  // 4): a PDF the router named a `book`, read in page windows of 50 pages
  // or 50 MB (Jason's word, 2026-11-18). Model-free, in Python
  // (server/parser/cad/pdf_pages.py): the text layer (pdfplumber) and the
  // tables of typed pages into tabs of their own; a scanned page is marked
  // in its tab Pages for the Agent pdf-page-read (the Scan reader reads it;
  // no local OCR in a book, owner decision 2026-11-19). It writes no page
  // picture: the Agent draws each marked page and saves its picture with the
  // text it read (G1). Its text stands over the core's PDF read (P2: it
  // claims a kind and gives text).
  pkgPython({
    id: 'pdf-pages',
    entry: 'pdf_pages.py',
    name: 'PDF book',
    description:
      'Reads every office PDF (the router names it a book), of any length, page by page: the text layer and its tables; a scanned page is marked for the Scan reader. It writes the tabs Pages and Tables, one tab a table with the page of each row, and the text by page. It asks no model.',
    // 1.1.0 (2026-11-19): every office PDF, whatever its size (the kind
    // rules 4). 1.2.0 (2026-11-19): no page pictures (the Agent pdf-page-read
    // owns them). 1.3.0 (2026-11-19): no local OCR (owner decision): every
    // scanned page is marked for the Agent with Why `scan` (the Scan reader
    // reads it) and its Lines (the check's evidence, counted from its
    // picture); the options of OCR are gone. 1.3.1 (2026-11-20): the File
    // tab's Rules version 5. 1.3.2 (2026-11-21): the tab Pages may hold the
    // page types (Kind, Kind from, Decider kind, Decider confidence), put in
    // by the core (../../pdf-page-kinds.ts). 1.3.3 (2026-11-23): Kind from
    // may say `decider` (M4, live), and Kind is then the answer's kind.
    version: '1.3.3',
    match: { ext: ['pdf'], kind: ['book'] },
    produces: { text: true, table: false, pages: true },
    // The lane: a PDF of BOOK_HEAVY_MIN_BYTES or more is heavy
    // (extractWeightOfFile, ../slug.ts), with an extract time that grows
    // with its page windows. One window a job: a scanned page is only drawn
    // at 150 dpi to see its lines (no OCR), a fraction of a second.
    needs: { weight: 'light', timeMs: 240_000, window: { ...PIPELINE_WINDOW_DEFAULT } },
    options: {
      text_min_chars: {
        type: 'number',
        label: 'Characters of a text page',
        help: 'A page whose text layer holds this many characters (spaces left out) is read from it, with no OCR.',
        default: 40,
        min: 1,
        max: 10_000,
      },
      tables: {
        type: 'bool',
        label: 'Tables',
        help: 'Find the tables of the pages and write each into a tab of its own, with the tab Tables.',
        default: true,
      },
    },
  }),
  // The book's Agent: the pages the book reader marked (a scanned page, read
  // by the Scan reader; a figure, by vision), one ask a page, keyed
  // `page-<N>` (./pkg/pdf-page-read). Its text of a page stands over the
  // Reader's (P3, `produces.pages`). It reads in the same page windows.
  pkgAgent({
    id: 'pdf-page-read',
    name: 'PDF page read',
    description:
      "Reads the scanned pages of a PDF book with the Scan reader (mistral-ocr), its figures and its pages of unsure type with vision, into the tab Page text, and saves each page picture with its text; a drawing's office scan pages too. Runs after an upload and on demand.",
    // 1.1.0 (2026-11-19): every marked page by default (option pages
    // 10,000, from 2,000), and only the windows that hold a marked page.
    // 1.2.0 (2026-11-19): a scanned page goes as a one-page PDF too, for the
    // Scan reader (docs/ai-workers.md). 1.3.0 (2026-11-23, M4): the
    // office-lane pages of a PDF of any kind (the core names them by the
    // page types), and a page of a live read under PDF_PAGE_PICTURE_BELOW,
    // whose picture is kept.
    version: '1.3.0',
    // The kinds it reads: no window is cut and no job runs on a PDF of
    // another kind, nor on one with no page to read (runAgentOnFile).
    match: {
      ext: ['pdf'],
      kind: [
        'book',
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
    options: {
      pages: {
        type: 'number',
        label: 'Pages to read',
        help: 'The most marked pages of a file to read, from its first marked page. One ask a page. Every marked page by default: a page left out stays unread.',
        default: PIPELINE_ASK_PAGE_MAX,
        min: 1,
        max: 10_000,
      },
    },
    produces: { tabs: ['Page text'], pages: true },
    // One step a window and no model in it: the pictures of the window's
    // marked pages, drawn in the parser's pdfjs child. A window of 15 pages:
    // 15 pictures of 4 MB at most stay under the 64 MB of one answer
    // (PIPELINE_PICTURES_MAX_BYTES), so no marked page is left out. The cap
    // of a file is the page cap of an ask (PIPELINE_ASK_PAGE_MAX); the
    // option and the box's day cap bound a run.
    needs: {
      weight: 'heavy',
      timeMs: 240_000,
      workers: { vision: PIPELINE_ASK_PAGE_MAX },
      window: { pages: 15, mb: PIPELINE_WINDOW_DEFAULT.mb },
    },
  }),
] as const;

/** A built-in, with its id as a literal. */
export type BuiltinPipeline = (typeof BUILTIN_PIPELINES)[number];

/** The ids of the built-ins, as literals. */
export type BuiltinId = BuiltinPipeline['id'];

/** The built-ins that read a file: no `match.after`, not a router, and not
 *  an Agent. */
export type ReaderPipeline = Exclude<
  BuiltinPipeline,
  { match: { after: string } } | { router: true } | { input: 'file' }
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

/** The four roles (docs/pipelines.md, "The contract"). `after` is the code
 *  name of a Transformer. */
export type PipelineRole = 'router' | 'reader' | 'after' | 'agent';

/**
 * The role of a pipeline: the one place that derives it. A router says so
 * (`router: true`). An Agent is any other pipeline that may ask an AI
 * worker (an own key in `needs.workers`). A Transformer has `match.after`.
 * The rest is a Reader. There is no `role` field: it would say the same
 * thing a second time.
 */
export function roleOf(
  manifest: Pick<PipelineManifest, 'match' | 'router' | 'needs'>,
): PipelineRole {
  if (manifest.router === true) return 'router';
  if (Object.keys(manifest.needs?.workers ?? {}).length > 0) return 'agent';
  return manifest.match.after !== undefined ? 'after' : 'reader';
}

/** Whether a pipeline is an Agent: it asks an AI worker, in a
 *  run of its own, and the core writes its rows. */
export function isAgent(manifest: Pick<PipelineManifest, 'match' | 'router' | 'needs'>): boolean {
  return roleOf(manifest) === 'agent';
}

/** The most asks of one file an Agent's manifest allows: the sum of its
 *  `needs.workers`. 0 for a pipeline that asks nothing. */
export function asksMaxOf(manifest: Pick<PipelineManifest, 'needs'>): number {
  return Object.values(manifest.needs?.workers ?? {}).reduce((n, v) => n + v, 0);
}

/** Whether a pipeline reads files into a database: a Reader, by its role. */
export function isReader(manifest: Pick<PipelineManifest, 'match' | 'router' | 'needs'>): boolean {
  return roleOf(manifest) === 'reader';
}

/** Extension -> its reader. An `after` pipeline or a router is never one.
 *  The first reader of an extension in the list is its reader: a second
 *  one of a routed type claims only a kind its router names (`pdf-pages`
 *  claims `book`), and is found by readerFor with that kind. */
export function readersByExt<P extends PipelineManifest>(
  pipelines: readonly P[],
): ReadonlyMap<string, P> {
  const out = new Map<string, P>();
  for (const p of pipelines.filter(isReader)) {
    for (const ext of p.match.ext) if (!out.has(ext)) out.set(ext, p);
  }
  return out;
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
