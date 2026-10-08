/**
 * "Team apps may use" (external-access.ts), the parts with no database: which tools
 * may get the switch, and the handler signature that voids it when the
 * handler changes. The broker rules on Postgres are in
 * team-apps.viewer.db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { Tool, ToolHandler, ToolExternalAccess } from '@mantle/db';
import {
  OUTSIDE_WRITE_LOG_INPUT_MAX,
  connectorLevelAllows,
  outsideCallLogDetail,
  externalAccessActive,
  externalAccessHandlerSig,
  externalAccessIneligible,
  externalAccessSummary,
} from './external-access';

const MCP: ToolHandler = { kind: 'mcp', group: 'mcp-site', toolName: 'query' };
const HTTP: ToolHandler = { kind: 'http', url: 'https://api.example.test/rows', method: 'GET' };

type Row = Pick<Tool, 'slug' | 'handler' | 'requiresConfirm' | 'externalAccess'>;
const row = (handler: ToolHandler, extra: Partial<Row> = {}): Row => ({
  slug: 'site_query',
  handler,
  requiresConfirm: false,
  externalAccess: null,
  ...extra,
});
const on = (handler: ToolHandler): ToolExternalAccess => ({
  confirmedReadOnlyAt: '2026-10-01T00:00:00.000Z',
  by: { via: 'web', actorId: 'a', actorEmail: 'admin@example.invalid' },
  handlerSig: externalAccessHandlerSig(handler),
});

describe('externalAccessIneligible', () => {
  it('lets mcp and http (GET, POST) tools get the switch', () => {
    expect(externalAccessIneligible(row(MCP))).toBeNull();
    expect(externalAccessIneligible(row(HTTP))).toBeNull();
    expect(externalAccessIneligible(row({ ...HTTP, method: 'POST' }))).toBeNull();
    expect(externalAccessIneligible(row({ kind: 'http', url: 'https://x.test' }))).toBeNull();
  });

  it('never shell, recipe or builtin', () => {
    expect(externalAccessIneligible(row({ kind: 'shell', cmd: 'true' }))).toMatch(/shell/);
    expect(externalAccessIneligible(row({ kind: 'recipe', steps: [] }))).toMatch(/recipe/);
    expect(externalAccessIneligible(row({ kind: 'builtin', ref: 'note_list' }))).toMatch(
      /built in/,
    );
  });

  it('never an http write method, never a tool that needs confirmation', () => {
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      expect(externalAccessIneligible(row({ ...HTTP, method })), method).toMatch(/changes data/);
    }
    expect(externalAccessIneligible(row(MCP, { requiresConfirm: true }))).toMatch(/confirmation/);
  });
});

describe('externalAccessHandlerSig', () => {
  it('ignores key order and the bookkeeping a sync writes', () => {
    const a = externalAccessHandlerSig({ kind: 'mcp', group: 'mcp-site', toolName: 'query' });
    const b = externalAccessHandlerSig({
      toolName: 'query',
      kind: 'mcp',
      group: 'mcp-site',
    } as ToolHandler);
    expect(a).toBe(b);
    expect(externalAccessHandlerSig({ ...MCP, vanishedAt: '2026-10-01' } as ToolHandler)).toBe(a);
    const mirror: ToolHandler = { ...HTTP, openapi: { group: 'openapi-x', op: 'getRows' } };
    expect(
      externalAccessHandlerSig({
        ...mirror,
        openapi: { group: 'openapi-x', op: 'getRows', editedAt: 't', vanishedAt: 't' },
      } as ToolHandler),
    ).toBe(externalAccessHandlerSig(mirror));
  });

  it('changes with anything that changes what the tool does', () => {
    const base = externalAccessHandlerSig(HTTP);
    expect(externalAccessHandlerSig({ ...HTTP, url: 'https://api.example.test/other' })).not.toBe(
      base,
    );
    expect(externalAccessHandlerSig({ ...HTTP, headers: { 'x-k': '{{secret:s/l}}' } })).not.toBe(
      base,
    );
    expect(externalAccessHandlerSig({ ...MCP, toolName: 'execute' })).not.toBe(
      externalAccessHandlerSig(MCP),
    );
  });
});

describe('externalAccessActive', () => {
  it('is off with no switch, on with a matching one', () => {
    expect(externalAccessActive(row(MCP))).toBe(false);
    expect(externalAccessActive(row(MCP, { externalAccess: on(MCP) }))).toBe(true);
  });

  it('a changed handler voids it, and the wire says so', () => {
    const t = row({ ...MCP, toolName: 'execute' }, { externalAccess: on(MCP) });
    expect(externalAccessActive(t)).toBe(false);
    expect(externalAccessSummary(t)).toMatchObject({ on: false });
  });

  it('a switch set by hand on a shell, recipe, confirm-gated or write tool never counts', () => {
    const shell: ToolHandler = { kind: 'shell', cmd: 'true' };
    const recipe: ToolHandler = { kind: 'recipe', steps: [] };
    const put: ToolHandler = { ...HTTP, method: 'PUT' };
    expect(externalAccessActive(row(shell, { externalAccess: on(shell) }))).toBe(false);
    expect(externalAccessActive(row(recipe, { externalAccess: on(recipe) }))).toBe(false);
    expect(externalAccessActive(row(put, { externalAccess: on(put) }))).toBe(false);
    expect(externalAccessActive(row(MCP, { externalAccess: on(MCP), requiresConfirm: true }))).toBe(
      false,
    );
  });
});

describe('connector levels (team apps Phase 2)', () => {
  it("a run's level reads a connector at its own level or below, as for an item", () => {
    expect(connectorLevelAllows('team', 'team')).toBe(true);
    expect(connectorLevelAllows('team', 'client')).toBe(true);
    expect(connectorLevelAllows('team', 'public')).toBe(true);
    expect(connectorLevelAllows('team', 'admin')).toBe(false);
    expect(connectorLevelAllows('client', 'client')).toBe(true);
    expect(connectorLevelAllows('client', 'team')).toBe(false);
    expect(connectorLevelAllows('client', 'public')).toBe(false);
    expect(connectorLevelAllows('public', 'public')).toBe(true);
    expect(connectorLevelAllows('public', 'client')).toBe(false);
  });

  it('an outside call logs its kind; a write keeps its input, capped', () => {
    const tool = { handler: MCP } as unknown as Tool;
    expect(outsideCallLogDetail({ tool, write: false }, { q: 1 })).toEqual({ handler: 'mcp' });
    const w = outsideCallLogDetail({ tool, write: true }, { sql: 'x'.repeat(5000) });
    expect(w).toMatchObject({ handler: 'mcp', write: true });
    expect(String(w.input).length).toBe(OUTSIDE_WRITE_LOG_INPUT_MAX);
    const builtin = { handler: { kind: 'builtin', ref: 'note_list' } } as unknown as Tool;
    expect(outsideCallLogDetail({ tool: builtin }, {})).toEqual({});
  });
});
