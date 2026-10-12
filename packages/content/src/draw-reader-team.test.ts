/**
 * The draw reader on the system pool (W8 integration), without a database:
 * the owner's own paths get every image (null), but a read for a team
 * surface that reaches the system pool gets none (fail closed), never the
 * owner's every image. Nothing is read for it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ reads: 0 }));

vi.mock('@mantle/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/db')>();
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => {
      h.reads += 1;
      return [{ fileRefs: { 'f-1': '11111111-1111-4111-8111-111111111111' } }];
    },
  };
  return {
    ...real,
    inTurnScope: () => false,
    isSystemScope: () => true,
    currentSpaceScope: () => null,
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
