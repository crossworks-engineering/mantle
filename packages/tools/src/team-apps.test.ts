/**
 * "Team apps may use" (team-apps.ts), the parts with no database: which tools
 * may get the switch, and the handler signature that voids it when the
 * handler changes. The broker rules on Postgres are in
 * team-apps.viewer.db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { Tool, ToolHandler, ToolTeamApps } from '@mantle/db';
import {
  teamAppsActive,
  teamAppsHandlerSig,
  teamAppsIneligible,
  teamAppsSummary,
} from './team-apps';

const MCP: ToolHandler = { kind: 'mcp', group: 'mcp-site', toolName: 'query' };
const HTTP: ToolHandler = { kind: 'http', url: 'https://api.example.test/rows', method: 'GET' };

type Row = Pick<Tool, 'slug' | 'handler' | 'requiresConfirm' | 'teamApps'>;
const row = (handler: ToolHandler, extra: Partial<Row> = {}): Row => ({
  slug: 'site_query',
  handler,
  requiresConfirm: false,
  teamApps: null,
  ...extra,
});
const on = (handler: ToolHandler): ToolTeamApps => ({
  confirmedReadOnlyAt: '2026-10-01T00:00:00.000Z',
  by: { via: 'web', actorId: 'a', actorEmail: 'admin@example.invalid' },
  handlerSig: teamAppsHandlerSig(handler),
});

describe('teamAppsIneligible', () => {
  it('lets mcp and http (GET, POST) tools get the switch', () => {
    expect(teamAppsIneligible(row(MCP))).toBeNull();
    expect(teamAppsIneligible(row(HTTP))).toBeNull();
    expect(teamAppsIneligible(row({ ...HTTP, method: 'POST' }))).toBeNull();
    expect(teamAppsIneligible(row({ kind: 'http', url: 'https://x.test' }))).toBeNull();
  });

  it('never shell, recipe or builtin', () => {
    expect(teamAppsIneligible(row({ kind: 'shell', cmd: 'true' }))).toMatch(/shell/);
    expect(teamAppsIneligible(row({ kind: 'recipe', steps: [] }))).toMatch(/recipe/);
    expect(teamAppsIneligible(row({ kind: 'builtin', ref: 'note_list' }))).toMatch(/built in/);
  });

  it('never an http write method, never a tool that needs confirmation', () => {
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      expect(teamAppsIneligible(row({ ...HTTP, method })), method).toMatch(/changes data/);
    }
    expect(teamAppsIneligible(row(MCP, { requiresConfirm: true }))).toMatch(/confirmation/);
  });
});

describe('teamAppsHandlerSig', () => {
  it('ignores key order and the bookkeeping a sync writes', () => {
    const a = teamAppsHandlerSig({ kind: 'mcp', group: 'mcp-site', toolName: 'query' });
    const b = teamAppsHandlerSig({
      toolName: 'query',
      kind: 'mcp',
      group: 'mcp-site',
    } as ToolHandler);
    expect(a).toBe(b);
    expect(teamAppsHandlerSig({ ...MCP, vanishedAt: '2026-10-01' } as ToolHandler)).toBe(a);
    const mirror: ToolHandler = { ...HTTP, openapi: { group: 'openapi-x', op: 'getRows' } };
    expect(
      teamAppsHandlerSig({
        ...mirror,
        openapi: { group: 'openapi-x', op: 'getRows', editedAt: 't', vanishedAt: 't' },
      } as ToolHandler),
    ).toBe(teamAppsHandlerSig(mirror));
  });

  it('changes with anything that changes what the tool does', () => {
    const base = teamAppsHandlerSig(HTTP);
    expect(teamAppsHandlerSig({ ...HTTP, url: 'https://api.example.test/other' })).not.toBe(base);
    expect(teamAppsHandlerSig({ ...HTTP, headers: { 'x-k': '{{secret:s/l}}' } })).not.toBe(base);
    expect(teamAppsHandlerSig({ ...MCP, toolName: 'execute' })).not.toBe(teamAppsHandlerSig(MCP));
  });
});

describe('teamAppsActive', () => {
  it('is off with no switch, on with a matching one', () => {
    expect(teamAppsActive(row(MCP))).toBe(false);
    expect(teamAppsActive(row(MCP, { teamApps: on(MCP) }))).toBe(true);
  });

  it('a changed handler voids it, and the wire says so', () => {
    const t = row({ ...MCP, toolName: 'execute' }, { teamApps: on(MCP) });
    expect(teamAppsActive(t)).toBe(false);
    expect(teamAppsSummary(t)).toMatchObject({ on: false });
  });

  it('a switch set by hand on a shell, recipe, confirm-gated or write tool never counts', () => {
    const shell: ToolHandler = { kind: 'shell', cmd: 'true' };
    const recipe: ToolHandler = { kind: 'recipe', steps: [] };
    const put: ToolHandler = { ...HTTP, method: 'PUT' };
    expect(teamAppsActive(row(shell, { teamApps: on(shell) }))).toBe(false);
    expect(teamAppsActive(row(recipe, { teamApps: on(recipe) }))).toBe(false);
    expect(teamAppsActive(row(put, { teamApps: on(put) }))).toBe(false);
    expect(teamAppsActive(row(MCP, { teamApps: on(MCP), requiresConfirm: true }))).toBe(false);
  });
});
