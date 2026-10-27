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
  posters: new Set<string>(),
}));

vi.mock('@mantle/content/presents', () => ({
  listPidCanvasPage: async (after: string | null, limit: number) => {
    const from = after === null ? 0 : box.ids.indexOf(after) + 1;
    const ids = box.ids.slice(from, from + limit);
    return { ids, next: ids.length === limit ? ids[ids.length - 1]! : null };
  },
  resavePidCanvas: async (id: string, opts: { apply: boolean }) => {
    box.calls.push({ id, apply: opts.apply });
    return { outcome: box.outcome.get(id) ?? 'unchanged', poster: box.posters.has(id) };
  },
}));

import { parseResaveArgs, RESAVE_PAGE, resavePidCanvases } from './pid-canvas-resave';

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
  box.posters = new Set(['id-001', 'id-030', 'id-040']);
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
      posters: 3,
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

  it('reads --limit 5 and --limit=5 alike, and refuses anything else', () => {
    expect(parseResaveArgs([])).toEqual({ apply: false, limit: null });
    expect(parseResaveArgs(['--apply', '--limit', '5'])).toEqual({ apply: true, limit: 5 });
    expect(parseResaveArgs(['--limit=5', '--apply'])).toEqual({ apply: true, limit: 5 });
    for (const bad of [['--aply'], ['--limit'], ['--limit=0'], ['--limit', 'x'], ['5']])
      expect(parseResaveArgs(bad), bad.join(' ')).toMatchObject({
        error: expect.stringMatching(/usage: pnpm pid:resave/),
      });
  });
});
