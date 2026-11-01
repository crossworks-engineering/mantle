/**
 * dwg_render: asks the parser for one `view`, hands the picture back for the
 * model, and saves nothing. Every wrong call says what to do instead, and a
 * window with nothing in it is an answer, not an error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const files = vi.hoisted(() => ({ parserDwgCrop: vi.fn(), readFileById: vi.fn() }));
vi.mock('@mantle/files', () => files);

import { APP_BYTES_MAX } from './app-bytes';
import { dwg_render } from './builtins-dwg-render';
import type { ToolHandlerContext } from './types';

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const FILE_ID = '11111111-1111-4111-8111-111111111111';
const row = (extension: string) => ({
  id: FILE_ID,
  filename: `sheet.${extension}`,
  extension,
});
const FRAME = {
  full: [0, 0, 9000, 500],
  sheet: [-10, -10, 810, 510],
  offSheet: [{ window: [8900, 100, 9000, 140], entities: 2 }],
  framed: true,
};
const crop = (over: Record<string, unknown> = {}) => ({
  ok: true,
  value: {
    converter: 'dwg2dxf',
    crops: [
      {
        id: 'view',
        part: 0,
        of: 1,
        window: [-10, -10, 810, 510],
        width: 2000,
        height: 1268,
        textPx: 9.5,
        png: Buffer.from('picture'),
        ...over,
      },
    ],
    overview: null,
    capped: [],
    frame: FRAME,
  },
});

const call = (input: Record<string, unknown>) =>
  dwg_render.handler({ file_id: FILE_ID, ...input }, ctx);

beforeEach(() => {
  files.parserDwgCrop.mockReset().mockResolvedValue(crop());
  files.readFileById.mockReset().mockResolvedValue({ row: row('dwg'), bytes: Buffer.from('AC') });
});

describe('dwg_render', () => {
  it('draws the sheet when no window is named, and returns the picture', async () => {
    const r = await call({});
    expect(files.parserDwgCrop).toHaveBeenCalledWith(Buffer.from('AC'), {
      items: [{ id: 'view', kind: 'view', edge: 2000 }],
      overview: false,
    });
    expect(r).toMatchObject({
      ok: true,
      output: {
        file_id: FILE_ID,
        filename: 'sheet.dwg',
        window: [-10, -10, 810, 510],
        width: 2000,
        smallest_text_px: 9.5,
        sheet: FRAME.sheet,
        full_extents: FRAME.full,
        off_sheet: FRAME.offSheet,
      },
      modelImages: [{ mimeType: 'image/png', base64: Buffer.from('picture').toString('base64') }],
    });
  });

  it('hands a window, full and an edge to the parser', async () => {
    await call({ window: [1, 2, 3, 4], edge: 800 });
    expect(files.parserDwgCrop.mock.calls[0]![1].items[0]).toEqual({
      id: 'view',
      kind: 'view',
      edge: 800,
      window: [1, 2, 3, 4],
    });
    await call({ full: true });
    expect(files.parserDwgCrop.mock.calls[1]![1].items[0]).toEqual({
      id: 'view',
      kind: 'view',
      edge: 2000,
      full: true,
    });
  });

  it('draws a dxf too, whatever the case of its extension', async () => {
    files.readFileById.mockResolvedValue({ row: row('DXF'), bytes: Buffer.from('0') });
    expect((await call({})).ok).toBe(true);
  });

  it('says a blank window is blank and sends no picture', async () => {
    files.parserDwgCrop.mockResolvedValue(crop({ blank: true }));
    const r = await call({ window: [3000, 3000, 3100, 3100] });
    expect(r.ok).toBe(true);
    expect(r).not.toHaveProperty('modelImages');
    expect(JSON.stringify(r)).toContain('Nothing is drawn in this window');
  });

  it.each([
    [{ window: [1, 2, 3] }, 'four numbers'],
    [{ window: [1, 2, 'x', 4] }, 'four numbers'],
    [{ window: [1, 2, null, 4] }, 'four numbers'],
    [{ window: [5, 2, 3, 4] }, 'x1 above x0'],
    [{ window: [1, 9, 3, 4] }, 'y1 above y0'],
    [{ window: [1, 2, 3, 4], full: true }, 'pass one of them'],
    [{ edge: 10 }, 'edge must be a whole number'],
    [{ edge: 1000.5 }, 'edge must be a whole number'],
  ])('refuses %j and says how to fix it', async (input, words) => {
    const r = await call(input);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain(words);
    expect(files.readFileById).not.toHaveBeenCalled();
  });

  it('points at the lookup for an unknown file', async () => {
    files.readFileById.mockResolvedValue(null);
    expect(await call({})).toMatchObject({
      ok: false,
      error: expect.stringContaining('file_list'),
    });
  });

  it('refuses a file that is not a drawing and does not ask the parser', async () => {
    files.readFileById.mockResolvedValue({ row: row('pdf'), bytes: Buffer.from('%PDF') });
    expect(await call({})).toMatchObject({
      ok: false,
      error: expect.stringContaining('sheet.pdf is not one'),
    });
    expect(files.parserDwgCrop).not.toHaveBeenCalled();
  });

  it('tells a retryable failure from a verdict', async () => {
    files.parserDwgCrop.mockResolvedValue({
      ok: false,
      code: 'busy',
      message: 'busy',
      retryable: true,
      terminal: false,
    });
    expect(await call({})).toMatchObject({
      ok: false,
      error: expect.stringContaining('call again in a moment'),
    });
    files.parserDwgCrop.mockResolvedValue({
      ok: false,
      code: 'failed',
      message: 'no converter produced a parseable DXF',
      retryable: false,
      terminal: false,
    });
    expect(await call({})).toMatchObject({
      ok: false,
      error: expect.stringContaining('no converter produced a parseable DXF'),
    });
  });

  it('says when the parser sent no picture back', async () => {
    files.parserDwgCrop.mockResolvedValue({
      ok: true,
      value: {
        converter: 'dwg2dxf',
        crops: [],
        overview: null,
        capped: ["1 crops left out: the answer's picture budget is spent"],
        frame: FRAME,
      },
    });
    expect(await call({})).toMatchObject({
      ok: false,
      error: expect.stringContaining('smaller `edge`'),
    });
  });

  describe('bytes', () => {
    const app = { ...ctx, caller: { entry: 'app' } } as unknown as ToolHandlerContext;
    const asApp = (input: Record<string, unknown>) =>
      dwg_render.handler({ file_id: FILE_ID, ...input }, app);

    it('hands an app the picture in its output, and no model image', async () => {
      const r = await asApp({ bytes: true, window: [1, 2, 3, 4] });
      expect(r).toMatchObject({
        ok: true,
        output: {
          mime_type: 'image/png',
          content_base64: Buffer.from('picture').toString('base64'),
          window: [-10, -10, 810, 510],
          off_sheet: FRAME.offSheet,
        },
      });
      expect(r).not.toHaveProperty('modelImages');
    });

    it.each([
      ['an agent', ctx],
      ['an MCP client', { ...ctx, caller: { entry: 'mcp' } } as unknown as ToolHandlerContext],
    ])('refuses %s before it reads the file', async (_who, who) => {
      const r = await dwg_render.handler({ file_id: FILE_ID, bytes: true }, who);
      expect(r).toMatchObject({ ok: false, error: expect.stringContaining('show_image') });
      expect(files.readFileById).not.toHaveBeenCalled();
    });

    it('sends a blank window no bytes', async () => {
      files.parserDwgCrop.mockResolvedValue(crop({ blank: true }));
      const r = await asApp({ bytes: true });
      expect(JSON.stringify(r)).not.toContain('content_base64');
    });

    it('refuses a picture past the cap', async () => {
      files.parserDwgCrop.mockResolvedValue(crop({ png: Buffer.alloc(APP_BYTES_MAX + 1) }));
      expect(await asApp({ bytes: true })).toMatchObject({
        ok: false,
        error: expect.stringContaining('past the 16.0 MB'),
      });
    });
  });

  it('is a read that names its file, fenced as data', () => {
    expect(dwg_render.policy).toMatchObject({
      effect: 'read',
      spends: 'none',
      matrix: { action: 'read', param: 'file_id', kinds: ['file'] },
      outside: { untrusted: true },
    });
  });
});
