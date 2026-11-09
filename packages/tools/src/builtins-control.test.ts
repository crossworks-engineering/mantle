/**
 * The Control Center's tools (docs/control-center.md) off a Control Center:
 * every one refuses before it reads or writes anything, and says why.
 * control_box_remove is the destructive one: it must never remove a box
 * row on a box that is not a Control Center.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const removed: string[] = [];
vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  return {
    ...actual,
    removeControlBox: vi.fn(async (id: string) => {
      removed.push(id);
      return true;
    }),
  };
});

const { CONTROL_TOOLS } = await import('./builtins-control');
const ctx = { ownerId: '00000000-0000-4000-8000-000000000001' } as never;
const tool = (slug: string) => CONTROL_TOOLS.find((t) => t.slug === slug)!;

afterEach(() => vi.unstubAllEnvs());

describe('control_box_remove', () => {
  it('refuses off a Control Center and removes nothing', async () => {
    vi.stubEnv('MANTLE_IS_CONTROL_CENTER', '');
    const r = await tool('control_box_remove').handler(
      { id: '00000000-0000-4000-8000-000000000002' },
      ctx,
    );
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('not a Control Center') });
    expect(removed).toEqual([]);
  });
});

describe('every control tool', () => {
  it('refuses off a Control Center', async () => {
    vi.stubEnv('MANTLE_IS_CONTROL_CENTER', 'off');
    for (const t of CONTROL_TOOLS) {
      const r = await t.handler({}, ctx);
      expect(r.ok, t.slug).toBe(false);
    }
    expect(removed).toEqual([]);
  });
});
