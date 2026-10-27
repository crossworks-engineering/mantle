/**
 * pid-canvas-resave without a database: every page of the box's `pid`
 * canvases is read, each canvas goes through the content layer's re-save
 * once, a dry run writes nothing, `limit` cuts the run and says so. The
 * write itself (a new revision, nothing announced) is the content layer's,
 * on Postgres in packages/content/src/presents.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const box = vi.hoisted(() => ({
  ids: [] as string[],
  outcome: new Map<string, string>(),
  calls: [] as { id: string; apply: boolean }[],
}));

vi.mock('@mantle/content/presents', () => ({
  listPidCanvasPage: async (after: string | null, limit: number) => {
    const from = after === null ? 0 : box.ids.indexOf(after) + 1;
    const ids = box.ids.slice(from, from + limit);
    return { ids, next: ids.length === limit ? ids[ids.length - 1]! : null };
  },
  resavePidCanvas: async (id: string, opts: { apply: boolean }) => {
    box.calls.push({ id, apply: opts.apply });
    return box.outcome.get(id) ?? 'unchanged';
  },
}));

import { RESAVE_PAGE, resavePidCanvases } from './pid-canvas-resave';

beforeEach(() => {
  box.ids = Array.from(
    { length: 2 * RESAVE_PAGE + 3 },
    (_, i) => `id-${String(i).padStart(3, '0')}`,
  );
  box.outcome = new Map([
    ['id-001', 'changed'],
    ['id-030', 'refused'],
    ['id-031', 'moved'],
  ]);
  box.calls = [];
});

describe('pid-canvas-resave', () => {
  it('a dry run reads every page and writes nothing', async () => {
    const c = await resavePidCanvases({ apply: false });
    expect(c).toEqual({
      canvases: box.ids.length,
      changed: 1,
      unchanged: box.ids.length - 3,
      refused: 1,
      moved: 1,
      cut: false,
    });
    expect(box.calls.every((x) => !x.apply)).toBe(true);
    expect(box.calls.map((x) => x.id)).toEqual(box.ids);
  });

  it('--apply passes the write on, each canvas once', async () => {
    const c = await resavePidCanvases({ apply: true });
    expect(c.changed).toBe(1);
    expect(box.calls.every((x) => x.apply)).toBe(true);
    expect(new Set(box.calls.map((x) => x.id)).size).toBe(box.ids.length);
  });

  it('--limit cuts the run and says so', async () => {
    const c = await resavePidCanvases({ apply: true, limit: 5 });
    expect(c.canvases).toBe(5);
    expect(c.cut).toBe(true);
    expect(box.calls).toHaveLength(5);
  });
});
