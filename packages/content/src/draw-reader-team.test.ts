/**
 * The draw reader on the system pool (W8 integration, W8 final), without a
 * database: the owner's own paths get every image (null), but a read for a
 * team surface that reaches the system pool gets none (fail closed), never
 * the owner's every image. Nor does it get the drawing itself: its metadata
 * and its text are not found (W8 final). Nothing is read for it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ reads: 0 }));

vi.mock('@mantle/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/db')>();
  const row = {
    id: '22222222-2222-4222-8222-222222222222',
    title: 'Owner drawing',
    tags: [],
    data: {},
    hasDraft: false,
    hasSvg: true,
    fileRefs: { 'f-1': '11111111-1111-4111-8111-111111111111' },
  };
  const chain = {
    from: () => chain,
    leftJoin: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: async () => {
      h.reads += 1;
      return [row];
    },
  };
  return {
    ...real,
    inTurnScope: () => false,
    isSystemScope: () => true,
    currentSpaceScope: () => null,
    readsDrafts: () => false,
    db: { select: () => chain },
  };
});

describe('readerVisibleFileIds on the system pool', () => {
  beforeEach(() => {
    h.reads = 0;
  });

  it("the owner's own paths: every image", async () => {
    const { readerVisibleFileIds } = await import('./draw-reader');
    expect(await readerVisibleFileIds('o', 'd')).toBeNull();
    expect(await readerVisibleFileIds('o', 'd', { teamSurface: false })).toBeNull();
  });

  it('a team surface: no image, and nothing read', async () => {
    const { readerVisibleFileIds } = await import('./draw-reader');
    const seen = await readerVisibleFileIds('o', 'd', { teamSurface: true });
    expect(seen).not.toBeNull();
    expect([...(seen ?? ['all'])]).toEqual([]);
    expect(h.reads).toBe(0);
  });
});

describe('the drawing itself on the system pool (W8 final)', () => {
  beforeEach(() => {
    h.reads = 0;
  });

  it("the owner's own paths read it", async () => {
    const { readableDraw } = await import('./draw-reader');
    expect(await readableDraw('o', 'd')).toMatchObject({ title: 'Owner drawing' });
    expect(await readableDraw('o', 'd', { teamSurface: false })).not.toBeNull();
  });

  it('a team surface: not found, no text, and nothing read', async () => {
    const { readableDraw, readableDrawText } = await import('./draw-reader');
    expect(await readableDraw('o', 'd', { teamSurface: true })).toBeNull();
    expect(await readableDrawText('o', 'd', { teamSurface: true })).toBeNull();
    expect(h.reads).toBe(0);
  });
});
