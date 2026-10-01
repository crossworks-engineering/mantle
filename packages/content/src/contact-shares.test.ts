/**
 * The contact's "Shared with you" menu read without a database (contact
 * shares, plan section 6a): ONE query, bounded, whatever the page holds.
 * The database is stood in by a query chain that counts what starts a
 * query; the rows themselves are proven on Postgres in
 * contact-shares.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  starts: [] as string[],
  limits: [] as number[],
  rows: [] as unknown[],
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy']) chain[m] = () => chain;
  chain.limit = async (n: number) => {
    h.limits.push(n);
    return h.rows;
  };
  const start = (name: string) => () => {
    h.starts.push(name);
    return chain;
  };
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    db: {
      select: start('select'),
      update: start('update'),
      insert: start('insert'),
      delete: start('delete'),
      execute: start('execute'),
      transaction: start('transaction'),
    },
  };
});

const row = (i: number) => ({
  token: `tok-${i}`,
  kind: i % 2 ? 'app' : 'page',
  title: `Item ${i}`,
  data: i === 0 ? { icon: '📦' } : {},
});

describe('listContactShares', () => {
  beforeEach(() => {
    h.starts.length = 0;
    h.limits.length = 0;
  });

  it('is one query, reading one row past the limit to know there are more', async () => {
    const { listContactShares } = await import('./contact-shares');
    h.rows = Array.from({ length: 51 }, (_, i) => row(i));
    const r = await listContactShares('owner', 'contact', { limit: 50 });
    expect(h.starts).toEqual(['select']);
    expect(h.limits).toEqual([51]);
    expect(r.items).toHaveLength(50);
    expect(r.more).toBe(true);
    expect(r.items[0]).toEqual({ token: 'tok-0', kind: 'page', title: 'Item 0', icon: '📦' });
  });

  it('never reads more than 50, whatever a caller asks', async () => {
    const { listContactShares } = await import('./contact-shares');
    h.rows = [row(1)];
    const r = await listContactShares('owner', 'contact', { limit: 5000 });
    expect(h.limits).toEqual([51]);
    expect(r).toEqual({
      items: [{ token: 'tok-1', kind: 'app', title: 'Item 1', icon: null }],
      more: false,
    });
  });
});
