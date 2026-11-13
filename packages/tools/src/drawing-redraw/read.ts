/**
 * The rows a redraw needs, read from one CAD file's own database: read only,
 * fixed statements over the tabs the drawing reader wrote (Symbols,
 * Placements, Segments, Texts, Inserts, Shapes). No caller SQL reaches it, so it
 * reads the file in this process (tabledb readTabColumns; the tabs are capped when built: at most
 * 60,000 segments, 40,000 placements, 20,000 texts). The caller has passed
 * the file's own read check first (readableFileDb).
 *
 * A column a database from before it does not have (Texts' Height,
 * Rotation, Width, the anchor columns and Block handle) reads as null, and a database with no Shapes tab gives
 * `shapes: null`; a row whose coordinates are not numbers is
 * left out.
 */
import { readTabColumns } from '@mantle/tabledb';
import type {
  RedrawInsert,
  RedrawPlacement,
  RedrawRows,
  RedrawSegment,
  RedrawShape,
  RedrawSymbol,
  RedrawText,
} from './build';

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

const ASKS = [
  { tab: 'Symbols', columns: ['Key', 'SVG', 'X0', 'Y0', 'Width', 'Height'] },
  {
    tab: 'Placements',
    columns: ['Key', 'X', 'Y', 'Rotation', 'Xscale', 'Yscale', 'Layer', 'Handle'],
  },
  { tab: 'Segments', columns: ['Layer', 'X1', 'Y1', 'X2', 'Y2', 'Handle'] },
  {
    tab: 'Texts',
    columns: [
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
    ],
  },
  { tab: 'Inserts', columns: ['Handle', 'Min X', 'Min Y', 'Max X', 'Max Y'] },
  {
    tab: 'Shapes',
    columns: ['Kind', 'Layer', 'Handle', 'Path', 'Min X', 'Min Y', 'Max X', 'Max Y'],
  },
] as const;

export type RedrawRead = { rows: RedrawRows; hasSymbols: boolean };

/** Read the rows. `hasSymbols` false: the database has no Symbols tab. */
export function readRedrawRows(abs: string): RedrawRead {
  const [symbolRows, placementRows, segmentRows, textRows, insertRows, shapeRows] = readTabColumns(
    abs,
    ASKS,
  );
  const symbols: RedrawSymbol[] = (symbolRows ?? []).map((r) => ({
    key: text(r.Key),
    svg: typeof r.SVG === 'string' && r.SVG ? r.SVG : null,
    x0: num(r.X0),
    y0: num(r.Y0),
    width: num(r.Width),
    height: num(r.Height),
  }));
  const placements: RedrawPlacement[] = [];
  for (const r of placementRows ?? []) {
    const x = num(r.X);
    const y = num(r.Y);
    if (x === null || y === null) continue;
    placements.push({
      key: text(r.Key),
      x,
      y,
      rotation: num(r.Rotation),
      xscale: num(r.Xscale),
      yscale: num(r.Yscale),
      layer: text(r.Layer),
      handle: text(r.Handle),
    });
  }
  const segments: RedrawSegment[] = [];
  for (const r of segmentRows ?? []) {
    const x1 = num(r.X1);
    const y1 = num(r.Y1);
    const x2 = num(r.X2);
    const y2 = num(r.Y2);
    if (x1 === null || y1 === null || x2 === null || y2 === null) continue;
    segments.push({ layer: text(r.Layer), x1, y1, x2, y2, handle: text(r.Handle) });
  }
  const texts: RedrawText[] = [];
  for (const r of textRows ?? []) {
    const x = num(r.X);
    const y = num(r.Y);
    const t = text(r.Text);
    if (x === null || y === null || !t) continue;
    texts.push({
      text: t,
      layer: text(r.Layer),
      x,
      y,
      height: num(r.Height),
      rotation: num(r.Rotation),
      width: num(r.Width),
      anchorX: num(r['Anchor X']),
      anchorY: num(r['Anchor Y']),
      align: text(r.Align) || null,
      lines: text(r['Text lines']) || null,
      lineGap: num(r['Line gap']),
      underline: num(r.Underline) === 1,
      block: text(r['Block handle']) || null,
    });
  }
  const inserts: RedrawInsert[] = [];
  for (const r of insertRows ?? []) {
    const minX = num(r['Min X']);
    const minY = num(r['Min Y']);
    const maxX = num(r['Max X']);
    const maxY = num(r['Max Y']);
    if (minX === null || minY === null || maxX === null || maxY === null) continue;
    inserts.push({ handle: text(r.Handle), minX, minY, maxX, maxY });
  }
  let shapes: RedrawShape[] | null = null;
  if (shapeRows) {
    shapes = [];
    for (const r of shapeRows) {
      const minX = num(r['Min X']);
      const minY = num(r['Min Y']);
      const maxX = num(r['Max X']);
      const maxY = num(r['Max Y']);
      const path = text(r.Path);
      if (minX === null || minY === null || maxX === null || maxY === null || !path) continue;
      const kind = text(r.Kind);
      shapes.push({
        layer: text(r.Layer),
        handle: text(r.Handle),
        path,
        minX,
        minY,
        maxX,
        maxY,
        // What the drawing fills: an arrow head, a filled bar.
        ...(kind === 'SOLID' || kind === 'TRACE' ? { fill: true } : {}),
      });
    }
  }
  return {
    rows: { symbols, placements, segments, texts, inserts, shapes },
    hasSymbols: symbolRows !== null,
  };
}
