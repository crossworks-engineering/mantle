/**
 * The heartbeat control tools in a scope that holds Admin: every owner's
 * heartbeat is reached through the assistants area's system door
 * (areaSystem), which asks the area itself. A scope without the area is
 * refused at the first row it would read, in the gate's words
 * (adminAreaError), thrown as areaSystem throws it, and nothing is read; a
 * call that names no heartbeat and runs in no fire answers the addressing
 * error first, as it does anywhere (no row is asked for).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  scope: { kind: 'user', loginId: 'l1', ws: ['w-admin'], modWs: [] } as Record<string, unknown>,
  area: false,
  selects: 0,
}));

vi.mock('@mantle/db/viewer', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  currentWorkspaceScope: () => h.scope,
}));
vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  return {
    ...actual,
    currentWorkspaceScope: () => h.scope,
    adminOrSystemScope: async () => true,
    scopeHasArea: async (a: string) => h.area && a === 'assistants',
    db: {
      ...actual.db,
      select: () => {
        h.selects += 1;
        throw new Error('no row is read in this test');
      },
    },
  };
});

import { adminAreaError } from '@mantle/tools';
import { HEARTBEAT_TOOLS } from './tools';

const tool = (slug: string) => HEARTBEAT_TOOLS.find((t) => t.slug === slug)!;

beforeEach(() => {
  h.area = false;
  h.selects = 0;
});

describe('a heartbeat tool in an Admin scope without the assistants area', () => {
  for (const slug of ['heartbeat_complete', 'heartbeat_update_state'] as const) {
    it(`${slug} by slug: the area refusal, before any row is read`, async () => {
      const input = slug === 'heartbeat_update_state' ? { slug: 'hb', patch: {} } : { slug: 'hb' };
      await expect(tool(slug).handler(input, { ownerId: 'o1' })).rejects.toThrow(
        adminAreaError('assistants'),
      );
      expect(h.selects).toBe(0);
    });
  }

  it('naming no heartbeat outside a fire: the addressing error, no row asked for', async () => {
    const r = await tool('heartbeat_complete').handler({}, { ownerId: 'o1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no heartbeat context/);
    expect(h.selects).toBe(0);
  });

  it('with the area: the row read goes ahead', async () => {
    h.area = true;
    await expect(
      tool('heartbeat_complete').handler({ slug: 'hb' }, { ownerId: 'o1' }),
    ).rejects.toThrow('no row is read in this test');
    expect(h.selects).toBe(1);
  });
});
