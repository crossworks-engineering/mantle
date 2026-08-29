/**
 * Pure half of the MCP connector sync: slug namespacing/collision handling,
 * the reconcile plan (insert/update/disable, identity by remote toolName),
 * the binding validator, and the generated group description. No DB — the
 * impure applier is exercised end-to-end via the connectors API.
 */

import { describe, expect, it } from 'vitest';

import { parseMcpBinding } from './integration-meta';
import {
  mcpGroupDescription,
  mcpGroupSlug,
  mcpToolSlug,
  planMcpSync,
  type McpSyncRowState,
} from './mcp-sync';

const GROUP = 'mcp-firecrawl';

function row(over: Partial<McpSyncRowState> & { toolName: string }): McpSyncRowState {
  const { toolName, ...rest } = over;
  return {
    slug: mcpToolSlug(GROUP, toolName, new Set()),
    name: toolName,
    description: 'd',
    enabled: true,
    inputSchema: { type: 'object' },
    handler: { kind: 'mcp', group: GROUP, toolName },
    ...rest,
  };
}

describe('mcpGroupSlug / mcpToolSlug', () => {
  it('prefixes the connector slug once', () => {
    expect(mcpGroupSlug('firecrawl')).toBe('mcp-firecrawl');
    expect(mcpGroupSlug('mcp-firecrawl')).toBe('mcp-firecrawl');
  });

  it('namespaces and sanitises remote names', () => {
    expect(mcpToolSlug(GROUP, 'firecrawl_scrape', new Set())).toBe(
      'mcp_firecrawl_firecrawl_scrape',
    );
    expect(mcpToolSlug(GROUP, 'Search Web!', new Set())).toBe('mcp_firecrawl_search_web');
    expect(mcpToolSlug(GROUP, '???', new Set())).toBe('mcp_firecrawl_tool');
  });

  it('suffixes on collision and stays under the length cap', () => {
    const taken = new Set(['mcp_firecrawl_scrape']);
    expect(mcpToolSlug(GROUP, 'scrape', taken)).toBe('mcp_firecrawl_scrape_2');
    const long = 'x'.repeat(300);
    const slug = mcpToolSlug(GROUP, long, new Set());
    expect(slug.length).toBeLessThanOrEqual(120);
    const slug2 = mcpToolSlug(GROUP, long, new Set([slug]));
    expect(slug2.length).toBeLessThanOrEqual(120);
    expect(slug2).not.toBe(slug);
  });
});

describe('planMcpSync', () => {
  it('inserts new remote tools with namespaced slugs', () => {
    const plan = planMcpSync({
      groupSlug: GROUP,
      remote: [{ name: 'scrape', description: 'Scrape a page', inputSchema: { type: 'object' } }],
      existing: [],
      ownerSlugs: [],
    });
    expect(plan.inserts).toHaveLength(1);
    expect(plan.inserts[0]!.slug).toBe('mcp_firecrawl_scrape');
    expect(plan.inserts[0]!.handler).toEqual({ kind: 'mcp', group: GROUP, toolName: 'scrape' });
    expect(plan.toolSlugs).toEqual(['mcp_firecrawl_scrape']);
    expect(plan.disableSlugs).toEqual([]);
  });

  it('matches by remote toolName, not slug, and only updates changed rows', () => {
    const existing = [row({ toolName: 'scrape', description: 'old' })];
    const plan = planMcpSync({
      groupSlug: GROUP,
      remote: [{ name: 'scrape', description: 'new', inputSchema: { type: 'object' } }],
      existing,
      ownerSlugs: existing.map((r) => r.slug),
    });
    expect(plan.inserts).toHaveLength(0);
    expect(plan.updates).toEqual([{ slug: existing[0]!.slug, description: 'new' }]);
  });

  it('emits no update for an identical row', () => {
    const existing = [row({ toolName: 'scrape' })];
    const plan = planMcpSync({
      groupSlug: GROUP,
      remote: [{ name: 'scrape', description: 'd', inputSchema: { type: 'object' } }],
      existing,
      ownerSlugs: existing.map((r) => r.slug),
    });
    expect(plan.updates).toHaveLength(0);
  });

  it('disables vanished tools (never deletes) and drops them from membership', () => {
    const existing = [row({ toolName: 'scrape' }), row({ toolName: 'extract' })];
    const plan = planMcpSync({
      groupSlug: GROUP,
      remote: [{ name: 'scrape', description: 'd', inputSchema: { type: 'object' } }],
      existing,
      ownerSlugs: existing.map((r) => r.slug),
    });
    expect(plan.disableSlugs).toEqual(['mcp_firecrawl_extract']);
    expect(plan.toolSlugs).toEqual(['mcp_firecrawl_scrape']);
  });

  it('re-enables a tool that reappears after a vanish', () => {
    const existing = [row({ toolName: 'scrape', enabled: false })];
    const plan = planMcpSync({
      groupSlug: GROUP,
      remote: [{ name: 'scrape', description: 'd', inputSchema: { type: 'object' } }],
      existing,
      ownerSlugs: existing.map((r) => r.slug),
    });
    expect(plan.updates).toEqual([{ slug: existing[0]!.slug, enabled: true }]);
  });

  it('avoids slug collisions with unrelated owner tools', () => {
    const plan = planMcpSync({
      groupSlug: GROUP,
      remote: [{ name: 'scrape', description: 'd', inputSchema: { type: 'object' } }],
      existing: [],
      ownerSlugs: ['mcp_firecrawl_scrape'], // an unrelated row already owns it
    });
    expect(plan.inserts[0]!.slug).toBe('mcp_firecrawl_scrape_2');
  });

  it('caps a runaway description and replaces an oversized schema', () => {
    const bigSchema = { type: 'object', blob: 'y'.repeat(40_000) };
    const plan = planMcpSync({
      groupSlug: GROUP,
      remote: [{ name: 'scrape', description: 'x'.repeat(5_000), inputSchema: bigSchema }],
      existing: [],
      ownerSlugs: [],
    });
    expect(plan.inserts[0]!.description).toHaveLength(2_000);
    expect(plan.inserts[0]!.inputSchema).toEqual({ type: 'object', additionalProperties: true });
  });

  it('collapses duplicate remote names into one row', () => {
    const plan = planMcpSync({
      groupSlug: GROUP,
      remote: [
        { name: 'scrape', description: 'a', inputSchema: { type: 'object' } },
        { name: 'scrape', description: 'b', inputSchema: { type: 'object' } },
      ],
      existing: [],
      ownerSlugs: [],
    });
    expect(plan.inserts).toHaveLength(1);
  });
});

describe('parseMcpBinding', () => {
  it('accepts a full binding, snake or camel', () => {
    const parsed = parseMcpBinding({
      url: 'https://mcp.firecrawl.dev/v2/mcp',
      secret_ref: 'firecrawl/default',
      auth_header: 'Authorization',
      authScheme: 'Bearer ',
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        url: 'https://mcp.firecrawl.dev/v2/mcp',
        secretRef: 'firecrawl/default',
        authHeader: 'Authorization',
        authScheme: 'Bearer ',
      },
    });
  });

  it('unwraps a {{secret:…}} handed as the ref', () => {
    const parsed = parseMcpBinding({
      url: 'https://example.com/mcp',
      secretRef: '{{secret:firecrawl/default}}',
    });
    expect(parsed.ok && parsed.value.secretRef).toBe('firecrawl/default');
  });

  it('rejects a non-http url and a junk header name', () => {
    expect(parseMcpBinding({ url: 'ftp://x' }).ok).toBe(false);
    expect(parseMcpBinding({ url: 'https://x.dev/mcp', auth_header: 'bad header' }).ok).toBe(false);
  });

  it('refuses a secret ref smuggled into auth_scheme', () => {
    expect(parseMcpBinding({ url: 'https://x.dev/mcp', auth_scheme: '{{secret:a/b}}' }).ok).toBe(
      false,
    );
  });

  it('round-trips sync bookkeeping', () => {
    const parsed = parseMcpBinding({
      url: 'https://x.dev/mcp',
      lastSyncAt: '2026-08-29T00:00:00.000Z',
      toolCount: 7,
      serverInfo: { name: 'x', version: '1.0' },
    });
    expect(parsed.ok && parsed.value.toolCount).toBe(7);
    expect(parsed.ok && parsed.value.serverInfo).toEqual({ name: 'x', version: '1.0' });
  });
});

describe('mcpGroupDescription', () => {
  it('names the host, the untrusted fence, and the no-write recommendation', () => {
    const d = mcpGroupDescription({ url: 'https://mcp.firecrawl.dev/v2/mcp' });
    expect(d).toContain('mcp.firecrawl.dev');
    expect(d).toContain('untrusted');
    expect(d).toContain('no-write specialist');
  });
});
