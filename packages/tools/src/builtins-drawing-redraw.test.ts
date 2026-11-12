/**
 * drawing_redraw: the read check comes first and its refusal is the answer;
 * a database with no Symbols tab names the one line to run; a canvas over the
 * cap is refused with a window that fits and nothing is saved; a fitting one
 * is saved through saveBuiltCanvas (present_create's path) with the counts
 * and the layer list. The file's read check and the save are stood in here
 * (file_sql's tests and the Present tools hold them); the rows are made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const FILE_ID = '11111111-1111-4111-8111-111111111111';
const CANVAS_ID = '22222222-2222-4222-8222-222222222222';

const h = vi.hoisted(() => ({
  readableFileDb: vi.fn(),
  saveBuiltCanvas: vi.fn(),
  readTabColumns: vi.fn(),
  getPresent: vi.fn(),
}));
vi.mock('@mantle/content/presents', () => ({ getPresent: h.getPresent }));
vi.mock('./builtins-file-sql', () => ({ readableFileDb: h.readableFileDb }));
vi.mock('./builtins-presents', () => ({ saveBuiltCanvas: h.saveBuiltCanvas }));
vi.mock('@mantle/tabledb', () => ({ readTabColumns: h.readTabColumns }));
vi.mock('@mantle/files', () => ({
  fileDataExt: (row: { title: string }) => row.title.split('.').pop()!.toLowerCase(),
  isCadExt: (ext: string) => ['dwg', 'dxf', 'dgn'].includes(ext),
}));
vi.mock('@mantle/content-core/canvas', () => ({ CANVAS_MAX_BYTES: 1_000_000 }));

import { SYMBOLS_PASS_LINE, drawing_redraw } from './builtins-drawing-redraw';
import type { ToolHandlerContext } from './types';

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const call = (input: Record<string, unknown> = {}) =>
  drawing_redraw.handler({ file_id: FILE_ID, ...input }, ctx);
const errorOf = async (input: Record<string, unknown> = {}) => {
  const res = await call(input);
  if (res.ok) throw new Error(`expected a refusal, got ${JSON.stringify(res.output)}`);
  return res.error;
};

const SVG = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>';

/** The tabs as readTabColumns returns them, in ASKS order. */
function tabs(opts: { symbols?: boolean; segments?: number } = {}) {
  const segments = Array.from({ length: opts.segments ?? 2 }, (_, i) => ({
    Layer: 'PIPE',
    X1: i,
    Y1: 0,
    X2: i + 0.5,
    Y2: 10,
  }));
  segments.push({ Layer: 'BORDER', X1: -1, Y1: -1, X2: 1000, Y2: -1 });
  segments.push({ Layer: 'BORDER', X1: 1000, Y1: -1, X2: 1000, Y2: 50 });
  segments.push({ Layer: 'BORDER', X1: 1000, Y1: 50, X2: -1, Y2: 50 });
  segments.push({ Layer: 'BORDER', X1: -1, Y1: 50, X2: -1, Y2: -1 });
  return [
    opts.symbols === false ? null : [{ Key: 'V', SVG, X0: -1, Y0: -1, Width: 2, Height: 2 }],
    [{ Key: 'V', X: 5, Y: 5, Rotation: 0, Xscale: 1, Yscale: 1, Layer: 'VALVES', Handle: '1A' }],
    segments,
    [
      { Text: 'P-101', Layer: 'TAGS', X: 5, Y: 8, Height: 2.5, Rotation: 0, Width: null },
      { Text: 'OLD', Layer: 'TAGS', X: 9, Y: 8, Height: null, Rotation: null, Width: null },
    ],
    [{ Handle: '1A', 'Min X': 4, 'Min Y': 4, 'Max X': 6, 'Max Y': 6 }],
    // A database from before the Shapes tab: every segment is drawn.
    null,
  ];
}

beforeEach(() => {
  vi.resetAllMocks();
  h.readableFileDb.mockResolvedValue({
    ok: true,
    row: { id: FILE_ID, path: 'files.m2', title: 'made-up.dxf', data: {} },
    abs: '/data/files/.file-dbs/x.sqlite',
  });
  h.readTabColumns.mockReturnValue(tabs());
  h.getPresent.mockResolvedValue({ id: CANVAS_ID });
  h.saveBuiltCanvas.mockResolvedValue({
    ok: true,
    output: {
      id: CANVAS_ID,
      url: `/n/${CANVAS_ID}`,
      title: 'made-up.dxf (redraw)',
      rev: 1,
      page_embed: `![Canvas](present:${CANVAS_ID})`,
      render: { rendered: false },
    },
  });
});

describe('drawing_redraw', () => {
  it('a caller who cannot read the file is refused, and nothing is read or saved', async () => {
    h.readableFileDb.mockResolvedValue({
      ok: false,
      kind: 'refused',
      message: 'This file is private to another login.',
    });
    expect(await errorOf()).toBe('This file is private to another login.');
    expect(h.readableFileDb).toHaveBeenCalledWith('o1', FILE_ID, false);
    expect(h.readTabColumns).not.toHaveBeenCalled();
    expect(h.saveBuiltCanvas).not.toHaveBeenCalled();
  });

  it('a file that is not a drawing is refused', async () => {
    h.readableFileDb.mockResolvedValue({
      ok: true,
      row: { id: FILE_ID, path: 'files.m2', title: 'sheet.csv', data: {} },
      abs: '/x.sqlite',
    });
    expect(await errorOf()).toMatch(/must be a \.dwg, \.dxf or \.dgn drawing; sheet\.csv/);
    expect(h.readTabColumns).not.toHaveBeenCalled();
  });

  it('a database with no Symbols tab names the line to run', async () => {
    h.readTabColumns.mockReturnValue(tabs({ symbols: false }));
    const error = await errorOf();
    expect(error).toContain(SYMBOLS_PASS_LINE);
    expect(SYMBOLS_PASS_LINE).toBe(
      'scripts/box-maintain.sh --files-writable <box> dwg-reindex --symbols --apply',
    );
    expect(h.saveBuiltCanvas).not.toHaveBeenCalled();
  });

  it('a bad window is refused with the fix', async () => {
    expect(await errorOf({ window: [10, 0, 5, 5] })).toMatch(/x1 above x0/);
    expect(await errorOf({ window: [1, 2, 3] })).toMatch(/four numbers/);
  });

  it('over the cap: refused with a window that fits, nothing saved', async () => {
    h.readTabColumns.mockReturnValue(tabs({ segments: 60_000 }));
    const error = await errorOf();
    expect(error).toMatch(/over the canvas limit of 1000 KB, so nothing was saved/);
    expect(error).toMatch(/window \[[-\d.]+, [-\d.]+, [-\d.]+, [-\d.]+\] fits/);
    expect(h.saveBuiltCanvas).not.toHaveBeenCalled();
  });

  it('saves the canvas and answers counts, layers and no picture', async () => {
    const res = await call({ hide_layers: ['TAGS'] });
    expect(res.ok).toBe(true);
    expect(h.saveBuiltCanvas).toHaveBeenCalledTimes(1);
    const [, canvas] = h.saveBuiltCanvas.mock.calls[0]!;
    expect(canvas).toMatchObject({
      title: 'made-up.dxf (redraw)',
      tags: ['drawing-redraw'],
      look: false,
    });
    expect(canvas.id).toBeUndefined();
    expect(canvas.source).toMatch(/^<!doctype html>/);
    const out = (res as { output: Record<string, unknown> }).output;
    expect(out).toMatchObject({
      canvas_id: CANVAS_ID,
      url: `/n/${CANVAS_ID}`,
      file_id: FILE_ID,
      counts: {
        symbols: 1,
        placements: 1,
        lines: 6,
        texts: 2,
        placements_without_symbol: 0,
        texts_with_height: 1,
      },
    });
    expect(out.layers).toEqual([
      { name: 'BORDER', off: true, frame: true },
      { name: 'PIPE', off: false },
      { name: 'TAGS', off: true },
      { name: 'VALVES', off: false },
    ]);
    expect(out.text_note).toMatch(/1 texts have no Height/);
    expect(res).not.toHaveProperty('modelImages');
  });

  it('with canvas_id and look it saves a new version and asks for the picture', async () => {
    await call({ canvas_id: CANVAS_ID, look: true, frame: 'on', title: 'P-1' });
    const [, canvas] = h.saveBuiltCanvas.mock.calls[0]!;
    expect(canvas).toMatchObject({ id: CANVAS_ID, look: true, title: 'P-1' });
  });

  it('a redraw into a canvas keeps its name when no title is given', async () => {
    await call({ canvas_id: CANVAS_ID });
    const [, canvas] = h.saveBuiltCanvas.mock.calls[0]!;
    expect(canvas.id).toBe(CANVAS_ID);
    expect(canvas).not.toHaveProperty('title');
  });

  it('a canvas_id that names no canvas is refused before the drawing is read', async () => {
    h.getPresent.mockResolvedValue(null);
    expect(await errorOf({ canvas_id: CANVAS_ID })).toMatch(/canvas/);
    expect(h.readableFileDb).not.toHaveBeenCalled();
    expect(h.readTabColumns).not.toHaveBeenCalled();
    expect(h.saveBuiltCanvas).not.toHaveBeenCalled();
  });

  it('is a write that reads the file, not person-only', () => {
    expect(drawing_redraw.policy).toMatchObject({
      matrix: { action: 'read', param: 'file_id', kinds: ['file'] },
      effect: 'write',
      spends: 'none',
      scope: 'any',
      creates: 'present',
      outside: { untrusted: true },
    });
    // As present_create: no key area, so a key limited to Files cannot write a canvas.
    expect(drawing_redraw.policy).not.toHaveProperty('keyArea');
    expect(drawing_redraw.policy).not.toHaveProperty('startsModelWork');
  });
});
