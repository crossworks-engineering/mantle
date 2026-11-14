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

export type Shape = { id: ShapeId; tabs: readonly ShapeTab[] };

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
