/**
 * resolveTools returns tools in the order they were asked for, not Postgres
 * row order. The tool list is the front of every cached prompt prefix, and
 * row order changes (every boot rewrites the builtin rows), which made the
 * prompt cache miss (spike 9, dev-brain page e9539aaf).
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as Array<{ slug: string; enabled: boolean }>,
}));

vi.mock('@mantle/db', () => ({
  tools: { ownerId: 'owner_id', slug: 'slug', enabled: 'enabled' },
  db: {
    select: () => ({ from: () => ({ where: async () => h.rows }) }),
  },
}));

import { resolveTools } from './resolve';

describe('resolveTools', () => {
  it('keeps the requested order whatever order the rows come back in', async () => {
    h.rows = [
      { slug: 'search', enabled: true },
      { slug: 'page_get', enabled: true },
      { slug: 'calculate', enabled: true },
    ];
    const out = await resolveTools('o', ['calculate', 'search', 'page_get']);
    expect(out.map((t) => t.slug)).toEqual(['calculate', 'search', 'page_get']);

    h.rows = [...h.rows].reverse();
    const again = await resolveTools('o', ['calculate', 'search', 'page_get']);
    expect(again.map((t) => t.slug)).toEqual(['calculate', 'search', 'page_get']);
  });

  it('skips missing slugs and duplicates', async () => {
    h.rows = [{ slug: 'search', enabled: true }];
    const out = await resolveTools('o', ['search', 'gone', 'search']);
    expect(out.map((t) => t.slug)).toEqual(['search']);
  });

  it('empty in, empty out', async () => {
    expect(await resolveTools('o', [])).toEqual([]);
  });
});
