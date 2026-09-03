import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));

vi.mock('@mantle/search', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  searchNodes: vi.fn(async (args: Record<string, unknown>) => {
    h.calls.push(args);
    return [];
  }),
  resolveSupersededTargets: vi.fn(async () => new Map()),
}));
vi.mock('@mantle/embeddings', () => ({ embed: vi.fn(async () => [0.1, 0.2]) }));

import { SEARCH_TOOLS } from './builtins-search';

const search_nodes = SEARCH_TOOLS.find((t) => t.slug === 'search_nodes')!;
const run = (input: Record<string, unknown>) =>
  search_nodes.handler(input, { ownerId: 'owner-1' } as never);

/**
 * `search_nodes` gained a `since` bound when the MCP `search` fork was folded
 * into it. `searchNodes` had always accepted one; the schema simply never
 * offered it, so the MCP fork was the only surface that could date-scope a
 * search and no in-app agent could.
 */
describe('search_nodes since', () => {
  it('offers since in its schema, so an agent can discover it', () => {
    const props = (search_nodes.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props.since).toBeTruthy();
  });

  it('passes a valid instant through to the searcher', async () => {
    h.calls = [];
    await run({ q: 'x', since: '2026-06-01T00:00:00.000Z' });
    expect(h.calls[0]!.since).toEqual(new Date('2026-06-01T00:00:00.000Z'));
  });

  it('omits since entirely when not given', async () => {
    h.calls = [];
    await run({ q: 'x' });
    expect(h.calls[0]!.since).toBeUndefined();
  });

  it('REFUSES an unparseable instant rather than searching without the filter', async () => {
    // Dropping it silently would return plausible out-of-range hits that read
    // as a correct answer to a date-scoped question.
    h.calls = [];
    const res = await run({ q: 'x', since: 'yesterday' });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain('yesterday');
    expect(h.calls).toEqual([]);
  });
});
