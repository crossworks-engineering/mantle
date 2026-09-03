import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  result: { ok: true, output: [{ id: 'n1', url: '/n/n1' }] } as
    { ok: true; output: unknown } | { ok: false; error: string },
}));

/**
 * `search` is the MCP surface's shipped name for the `search_nodes` builtin.
 *
 * It used to be a 63-line FORK, and the name mismatch is exactly why it
 * survived every duplicate check: no-duplicate-tools.test.ts compares slugs,
 * and `search` is not a builtin slug. The fork had drifted silently and only
 * downwards — no `url` permalink, and NO supersession annotation, so MCP
 * clients got stale copies presented as current while the in-app agent got
 * "prefer this successor" on the very same row.
 *
 * These tests pin the delegation itself: what `search` receives, it hands to
 * the builtin, and what the builtin answers is what the client sees. The
 * builtin is stubbed, because its own behaviour is tested in @mantle/tools.
 */
vi.mock('@mantle/tools', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    SEARCH_TOOLS: [
      {
        slug: 'search_nodes',
        name: 'Search nodes',
        description: 'stub',
        inputSchema: { type: 'object', properties: {} },
        handler: async (input: Record<string, unknown>) => {
          h.calls.push(input);
          return h.result;
        },
      },
    ],
  };
});

import { registerSearchTools } from './search';
import type { McpRegisterContext } from './context';

type Reply = { content: Array<{ text: string }>; isError?: boolean };
type Result = { ok: true; output: unknown } | { ok: false; error: string };

function searchHandler() {
  const handlers = new Map<string, (a: Record<string, unknown>) => Promise<Reply>>();
  const ctx = {
    server: { tool: (n: string, _d: string, _s: unknown, fn: never) => handlers.set(n, fn) },
    ownerId: 'owner-1',
    jsonReply: (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] }),
    callBuiltin: async (
      def: { handler: (i: Record<string, unknown>, c: unknown) => Promise<Result> },
      args: Record<string, unknown>,
    ) => {
      const r = await def.handler(args, { ownerId: 'owner-1' });
      if (!r.ok) return { content: [{ type: 'text', text: `Error: ${r.error}` }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(r.output) }] };
    },
  } as unknown as McpRegisterContext;
  registerSearchTools(ctx);
  return handlers.get('search')!;
}

describe('MCP `search` delegates to the search_nodes builtin', () => {
  it('forwards every argument the MCP schema accepts, under the same names', async () => {
    h.calls = [];
    await searchHandler()({
      q: 'invoice',
      branch: 'files.work',
      type: 'file',
      tags: ['a'],
      since: '2026-01-01T00:00:00.000Z',
      limit: 200,
    });
    expect(h.calls).toEqual([
      {
        q: 'invoice',
        branch: 'files.work',
        type: 'file',
        tags: ['a'],
        since: '2026-01-01T00:00:00.000Z',
        limit: 200,
      },
    ]);
  });

  it('passes `since` through — the one thing the fork could do that the builtin could not', async () => {
    h.calls = [];
    await searchHandler()({ q: 'x', since: '2026-06-01T00:00:00.000Z' });
    expect(h.calls[0]!.since).toBe('2026-06-01T00:00:00.000Z');
  });

  it('returns the builtin output verbatim, so url and superseded_by reach the client', async () => {
    h.result = {
      ok: true,
      output: [
        {
          id: 'stale',
          url: '/n/stale',
          superseded_by: { id: 'fresh', title: 'Corrected', url: '/n/fresh' },
        },
      ],
    };
    const reply = await searchHandler()({ q: 'x' });
    const rows = JSON.parse(reply.content[0]!.text);
    expect(rows[0].url).toBe('/n/stale');
    expect(rows[0].superseded_by.id).toBe('fresh');
  });

  it('maps a builtin failure to an isError reply instead of throwing', async () => {
    h.result = { ok: false, error: 'since is not a valid ISO-8601 instant: yesterday' };
    const reply = await searchHandler()({ since: 'yesterday' });
    expect(reply.isError).toBe(true);
    expect(reply.content[0]!.text).toContain('not a valid ISO-8601');
    h.result = { ok: true, output: [] };
  });

  it('runs no query of its own — the builtin is the only implementation', async () => {
    // A second implementation is what this change removed. If `search` ever
    // grows its own searchNodes/embed call again, it stops being a delegation.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./search.ts', import.meta.url), 'utf8'),
    );
    const body = src.slice(src.indexOf("server.tool(\n    'search'"));
    expect(body).not.toContain('searchNodes(');
    expect(body).not.toContain('embed(');
  });
});
