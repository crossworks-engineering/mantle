/**
 * draw_get's picture (`image: true` / `region`). What is pinned:
 *
 *  - text stays the default: no picture, no image tokens, unless asked;
 *  - asked, the committed snapshot comes back as a PNG for the MODEL
 *    (`modelImages`), never as base64 inside the model-visible `output`;
 *  - the reader is taken from the surface the server stamped, so a member's
 *    or a client's call gets the snapshot through their own image rule
 *    (draw-reader.ts), and a model argument cannot widen it;
 *  - no snapshot, or a drawing out of reach, is a note or a not-found, and a
 *    render failure still returns the text.
 *
 * The reader helpers are stubbed; the renderer is the real one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  readableDraw: vi.fn(),
  readableDrawText: vi.fn(),
  readableDrawSvg: vi.fn(),
}));

vi.mock('@mantle/content', async () => {
  const png = await import('../../content/src/draw-png');
  return {
    listDraws: vi.fn(async () => []),
    nodeUrl: (id: string) => `/n/${id}`,
    readableDraw: h.readableDraw,
    readableDrawText: h.readableDrawText,
    readableDrawSvg: h.readableDrawSvg,
    renderDrawSvgPng: png.renderDrawSvgPng,
    cachedDrawPng: png.cachedDrawPng,
    cacheDrawPng: png.cacheDrawPng,
    validRegion: png.validRegion,
    DRAW_PNG_LONG_EDGE: png.DRAW_PNG_LONG_EDGE,
  };
});

import { DRAW_TOOLS } from './builtins-draws';
import type { ToolHandlerContext } from './types';

const draw_get = DRAW_TOOLS.find((t) => t.slug === 'draw_get')!;
const ID = '11111111-1111-4111-8111-111111111111';
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="400" height="200">' +
  '<rect x="10" y="10" width="100" height="50" fill="#1971c2"/></svg>';
const META = {
  id: ID,
  title: 'Pipeline',
  tags: ['arch'],
  summary: 'The ingest pipeline.',
  hasDraft: false,
  hasSvg: true,
};

const owner: ToolHandlerContext = { ownerId: 'anchor', surface: { kind: 'web' } };

beforeEach(() => {
  h.readableDraw.mockReset().mockResolvedValue(META);
  h.readableDrawText.mockReset().mockResolvedValue('# Pipeline\nIngest -> Extract');
  h.readableDrawSvg.mockReset().mockResolvedValue(SVG);
});

describe('draw_get picture', () => {
  it('returns text only by default, and never reads the snapshot', async () => {
    const r = await draw_get.handler({ id: ID }, owner);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.modelImages).toBeUndefined();
    expect((r.output as Record<string, unknown>).content).toContain('Ingest -> Extract');
    expect('image' in (r.output as object)).toBe(false);
    expect(h.readableDrawSvg).not.toHaveBeenCalled();
  });

  it('with image: a PNG for the model, metadata only in the output', async () => {
    const r = await draw_get.handler({ id: ID, image: true }, owner);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const img = r.modelImages?.[0];
    expect(img?.mimeType).toBe('image/png');
    expect(Buffer.from(img!.base64, 'base64').subarray(0, 4).toString('hex')).toBe('89504e47');
    const out = r.output as Record<string, unknown>;
    expect(out.image).toEqual({ format: 'png', width: 2000, height: 1000 });
    expect(out.image_note).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain(img!.base64.slice(0, 40));
    // The text still comes with it.
    expect(out.content).toContain('Ingest -> Extract');
  });

  it('a region implies image and zooms', async () => {
    const r = await draw_get.handler(
      { id: ID, region: { x: 0, y: 0, width: 0.5, height: 1 } },
      owner,
    );
    expect(r.ok && r.modelImages?.length).toBe(1);
    if (!r.ok) return;
    expect((r.output as Record<string, unknown>).image).toMatchObject({
      width: 2000,
      height: 2000,
      region: { x: 0, y: 0, width: 0.5, height: 1 },
    });
  });

  it('refuses a region outside the scene with the fix', async () => {
    const r = await draw_get.handler({ id: ID, region: { x: 0.8, width: 0.5 } }, owner);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/fractions of the scene/);
  });

  it('reads for the login the surface names, never a model argument', async () => {
    await draw_get.handler(
      { id: ID, image: true, loginId: 'someone-else' },
      { ownerId: 'anchor', surface: { kind: 'team', loginId: 'member-1' } },
    );
    expect(h.readableDrawSvg).toHaveBeenLastCalledWith('anchor', ID, {
      kind: 'member',
      loginId: 'member-1',
    });
    await draw_get.handler(
      { id: ID, image: true },
      { ownerId: 'anchor', surface: { kind: 'client', loginId: 'client-1' } },
    );
    expect(h.readableDrawSvg).toHaveBeenLastCalledWith('anchor', ID, { kind: 'client' });
    await draw_get.handler({ id: ID, image: true }, owner);
    expect(h.readableDrawSvg).toHaveBeenLastCalledWith('anchor', ID, { kind: 'scope' });
  });

  it('a drawing out of reach is not found, for the picture as for the text', async () => {
    h.readableDraw.mockResolvedValue(null);
    const r = await draw_get.handler({ id: ID, image: true }, owner);
    expect(r.ok).toBe(false);
    expect(h.readableDrawSvg).not.toHaveBeenCalled();
  });

  it('no committed snapshot: the text and a note, no picture', async () => {
    h.readableDraw.mockResolvedValue({ ...META, hasSvg: false });
    const r = await draw_get.handler({ id: ID, image: true }, owner);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.modelImages).toBeUndefined();
    const out = r.output as Record<string, unknown>;
    expect(out.image).toBeNull();
    expect(out.image_note).toMatch(/no committed snapshot/);
  });

  it('says the picture is the last commit when a draft exists', async () => {
    h.readableDraw.mockResolvedValue({ ...META, hasDraft: true });
    const r = await draw_get.handler({ id: ID, image: true }, owner);
    expect(r.ok && (r.output as Record<string, unknown>).image_note).toMatch(/last commit/);
  });

  it('a long thin scene suggests a region', async () => {
    h.readableDrawSvg.mockResolvedValue(
      SVG.replace(
        'viewBox="0 0 400 200" width="400" height="200"',
        'viewBox="0 0 1600 200" width="1600" height="200"',
      ),
    );
    const r = await draw_get.handler({ id: ID, image: true }, owner);
    expect(r.ok && (r.output as Record<string, unknown>).image_note).toMatch(/region/);
  });

  it('a snapshot that cannot be drawn still returns the text', async () => {
    h.readableDrawSvg.mockResolvedValue('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const r = await draw_get.handler({ id: ID, image: true }, owner);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.modelImages).toBeUndefined();
    expect((r.output as Record<string, unknown>).image_note).toMatch(/could not be drawn/);
    expect((r.output as Record<string, unknown>).content).toContain('Ingest');
  });
});
