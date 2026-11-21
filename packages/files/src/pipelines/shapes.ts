/**
 * The known tab shapes of a file database: the tabs and columns a tool reads.
 * A shape is additive: new tabs and columns are fine. A tab or column is
 * `needed` only when its consumer fails without it today; everything else is
 * read when it is there (an older file may lack it). Pure.
 *
 * The lists live here, and the consumers take them from here:
 *   drawing-v1   packages/tools/src/drawing-redraw/read.ts (ASKS)
 *   circuit-v1   packages/tools/src/circuit-trace/read.ts
 *   pdf-file-v1  packages/files/src/pdf-drawing-sheets.ts (pdfFileTabOf)
 *   texts-v1     the `after` pipeline Site tags (./pkg/site-tags/site-tags.ts)
 *   pages-v1     the `after` pipeline Links (./pkg/links/step.ts)
 *
 * The body of an `after` pipeline (afterBodyOf, packages/content) holds each
 * tab of its shape the file has, needed or not, and, for a shape with
 * `listedIn`, every tab named in that column of that tab, with all its
 * columns (a book's table tabs, named by the Reader).
 */
import type { ShapeId } from './contract';

export type ShapeTab = {
  name: string;
  /** The shape is not there without this tab. */
  needed: boolean;
  /** The columns a consumer reads. */
  columns: readonly string[];
  /** Of those, the ones it fails without. */
  neededColumns: readonly string[];
};

export type Shape = {
  id: ShapeId;
  tabs: readonly ShapeTab[];
  /** The tabs named in this column of this tab are read too, each with all
   *  its columns: tabs a Reader names itself, as a book's table tabs. */
  listedIn?: { tab: string; column: string };
};

/** The longest cell an `after` pipeline reads from the tabs of a shape: a
 *  drawing's text is a label or a note line, and a longer cell is cut. The
 *  core cuts the body to it (afterBodyOf), and Site tags cuts a text to it. */
export const AFTER_CELL_MAX_CHARS = 4_096;

const tab = (
  name: string,
  needed: boolean,
  columns: readonly string[],
  neededColumns: readonly string[] = [],
): ShapeTab => ({ name, needed, columns, neededColumns });

const SEGMENT_COLUMNS = ['Layer', 'Handle', 'X1', 'Y1', 'X2', 'Y2', 'Length', 'Node 1', 'Node 2'];
const NODE_COLUMNS = ['Node', 'X', 'Y', 'Degree', 'Kind', 'Block', 'Block handle', 'Layers'];

export const SHAPES: Readonly<Record<ShapeId, Shape>> = {
  // drawing_redraw: no Symbols tab is an error; any other tab reads as
  // empty, and a missing column as NULL.
  'drawing-v1': {
    id: 'drawing-v1',
    tabs: [
      tab('Symbols', true, ['Key', 'SVG', 'X0', 'Y0', 'Width', 'Height']),
      tab('Placements', false, [
        'Key',
        'X',
        'Y',
        'Rotation',
        'Xscale',
        'Yscale',
        'Layer',
        'Handle',
      ]),
      tab('Segments', false, ['Layer', 'X1', 'Y1', 'X2', 'Y2', 'Handle']),
      tab('Texts', false, [
        'Text',
        'Layer',
        'X',
        'Y',
        'Height',
        'Rotation',
        'Width',
        'Anchor X',
        'Anchor Y',
        'Align',
        'Text lines',
        'Line gap',
        'Underline',
        'Block handle',
        'Length',
      ]),
      tab('Inserts', false, ['Handle', 'Min X', 'Min Y', 'Max X', 'Max Y']),
      tab('Shapes', false, [
        'Kind',
        'Layer',
        'Handle',
        'Path',
        'Min X',
        'Min Y',
        'Max X',
        'Max Y',
        'Dash',
      ]),
    ],
  },
  // circuit_trace: no Segments or no Nodes tab is "no bones"; their columns
  // are read by fixed statements that fail without them. `Part` is asked
  // for with hasColumn. The other tabs are read when they are there.
  'circuit-v1': {
    id: 'circuit-v1',
    tabs: [
      tab('Segments', true, [...SEGMENT_COLUMNS, 'Part'], SEGMENT_COLUMNS),
      tab('Nodes', true, NODE_COLUMNS, NODE_COLUMNS),
      tab('Layers', false, ['Layer']),
      tab('Circuits', false, ['Circuit', 'Parent', 'Layers', 'Line numbers']),
      tab('Inserts', false, [
        'Block',
        'Layer',
        'Handle',
        'X',
        'Y',
        'Min X',
        'Min Y',
        'Max X',
        'Max Y',
      ]),
      tab('Texts', false, ['Text', 'Layer', 'X', 'Y']),
      // Read with SELECT *: these five are its fixed columns, the rest are
      // attribute tags.
      tab('Blocks', false, ['Block', 'Layer', 'Handle', 'X', 'Y']),
    ],
  },
  // pdfFileTabOf: no Kind or Rules kind is no File row.
  'pdf-file-v1': {
    id: 'pdf-file-v1',
    tabs: [
      tab(
        'File',
        true,
        [
          'Kind',
          'Rules kind',
          'Decider answer',
          'Decider confidence',
          'Decider model',
          'Decider mode',
          'Kind source',
          'Vision read',
          'Pages not read whole',
        ],
        ['Kind', 'Rules kind'],
      ),
    ],
  },
  // Site tags reads Text, and Page, Layer, X, Y and Region when they are
  // there (Region: a PDF drawing's; a word in a `table` gives no tag). A
  // CAD drawing's Texts tab and a PDF drawing's both carry it. No reader
  // promises it, so no reader's stamp names it.
  'texts-v1': {
    id: 'texts-v1',
    tabs: [tab('Texts', true, ['Text', 'Page', 'Layer', 'X', 'Y', 'Region'], ['Text'])],
  },
  // Links reads a file of pages: the Pages tab of the PDF book reader (Page,
  // Text, Method, Why) or of the PDF drawing reader (Page); the Agent's Page
  // text (Key `page-N`, Text) when it ran; a book's Tables index and every
  // table tab it names; a drawing's Tags and Lines.
  'pages-v1': {
    id: 'pages-v1',
    tabs: [
      tab('Pages', true, ['Page', 'Text', 'Method', 'Why'], ['Page']),
      tab('Page text', false, ['Key', 'Text']),
      tab('Tables', false, ['Tab', 'Title', 'Pages']),
      tab('Tags', false, ['Page', 'Tag', 'Type', 'Region']),
      tab('Lines', false, ['Page', 'Line number', 'Region']),
    ],
    listedIn: { tab: 'Tables', column: 'Tab' },
  },
};

/** The shapes whose needed tabs, with their needed columns, are all there. */
export function shapesOf(tabs: readonly { name: string; columns: readonly string[] }[]): ShapeId[] {
  const byName = new Map(tabs.map((t) => [t.name, new Set(t.columns)]));
  return Object.values(SHAPES)
    .filter((shape) =>
      shape.tabs.every((t) => {
        if (!t.needed) return true;
        const columns = byName.get(t.name);
        return columns !== undefined && t.neededColumns.every((c) => columns.has(c));
      }),
    )
    .map((shape) => shape.id);
}
