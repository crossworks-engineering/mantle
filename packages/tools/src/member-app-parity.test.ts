/**
 * The member-app rule through the one gate equals the rule today (arch A3c
 * fix round 2, M-B). For every way a team-rules app run can call a tool,
 * the gate's answer on an `app-tool` ref is what the LIVE
 * memberAppToolVerdict says: the same allow, and a refusal in the same
 * words. Only its database reads are stubbed (the tool lookup, the
 * system-wide group, the outside tool's verdict); the rule is the live one.
 *
 * Fail closed: at team rules a ref that carries no verdict, and every ref
 * that is not an app tool (an MCP tool, a runtime tool row, a job), is
 * refused, whatever the tool is.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool, ToolHandler } from '@mantle/db';

const h = vi.hoisted(() => ({
  rows: new Map<string, unknown>(),
  inGroup: false,
  outside: null as null | { ok: true; write: boolean } | { ok: false; reason: string },
}));

vi.mock('./resolve', () => ({
  resolveTool: vi.fn(async (_owner: string, slug: string) => h.rows.get(slug) ?? null),
}));
vi.mock('@mantle/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/db')>();
  // inSystemWideGroup's one query: select().from().where().limit().
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: async () => (h.inGroup ? [{ slug: 'g' }] : []),
  };
  return { ...real, db: chain };
});
vi.mock('./external-access', async (importOriginal) => {
  const real = await importOriginal<typeof import('./external-access')>();
  return {
    ...real,
    outsideToolVerdict: vi.fn(async (_o: string, tool: Tool) => {
      const v = h.outside;
      if (!v) throw new Error('no outside verdict set for this case');
      return v.ok
        ? { ok: true, tool, write: v.write }
        : { ok: false, status: 403, reason: v.reason };
    }),
  };
});

import {
  enterCall,
  gateCheck,
  loginActor,
  registerPolicySource,
  systemActor,
  type GateCaller,
  type PolicyRef,
} from '@mantle/db';
import { BUILTIN_TOOLS } from './builtins';
import { TEAM_APP_NO_TOOL_ERROR } from './gate-narrowers';
import { memberAppRefusedName, memberAppToolVerdict } from './member-app-tools';
import { isBuiltinReadOnly, isBuiltinSpending } from './registry';

const OWNER = '00000000-0000-4000-8000-000000000002';
const LOGIN = '00000000-0000-4000-8000-000000000009';

function row(slug: string, handler: ToolHandler, over: Partial<Tool> = {}): Tool {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    ownerId: OWNER,
    slug,
    name: slug,
    description: 'A tool.',
    inputSchema: { type: 'object', properties: {} },
    handler,
    requiresConfirm: false,
    enabled: true,
    externalAccess: null,
    createdBy: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  } as Tool;
}
const builtin = (slug: string, ref = slug, over: Partial<Tool> = {}) =>
  row(slug, { kind: 'builtin', ref }, over);

const usable = BUILTIN_TOOLS.filter(
  (t) => !memberAppRefusedName(t.slug) && t.requiresConfirm !== true,
);
const READ = usable.find((t) => t.readOnly === true && t.spends !== true)!.slug;
const WRITE = usable.find((t) => t.readOnly !== true && t.spends !== true)!.slug;
const SPEND = usable.find((t) => t.spends === true)!.slug;
const CONNECTOR = row('mcp_crm_lookup', { kind: 'mcp', group: 'crm', toolName: 'lookup' });

/** A team-rules app run, as a broker would hand it to the gate (no login
 *  id: no create home, so no database). */
const team: GateCaller = {
  actor: loginActor(LOGIN, 'rw'),
  via: 'app',
  admin: null,
  facts: { appRules: 'team' },
};

type Case = {
  name: string;
  slug: string;
  declared?: readonly string[];
  row?: Tool;
  inGroup?: boolean;
  outside?: typeof h.outside;
};

const CASES: Case[] = [
  { name: 'not declared', slug: READ, declared: [], row: builtin(READ), inGroup: true },
  { name: 'a refused slug', slug: 'my_items_list', row: builtin('my_items_list') },
  { name: 'no such tool', slug: 'no_such_tool' },
  { name: 'read-only, in a system-wide group', slug: READ, row: builtin(READ), inGroup: true },
  { name: 'read-only, Admin-only groups only', slug: READ, row: builtin(READ), inGroup: false },
  { name: 'a write', slug: WRITE, row: builtin(WRITE), inGroup: true },
  { name: 'it spends', slug: SPEND, row: builtin(SPEND), inGroup: true },
  {
    name: 'it needs a confirm',
    slug: READ,
    row: builtin(READ, READ, { requiresConfirm: true }),
    inGroup: true,
  },
  {
    name: 'an alias over a refused builtin',
    slug: 'alias',
    row: builtin('alias', 'search_chunks'),
    inGroup: true,
  },
  {
    name: 'an alias over a spending builtin',
    slug: 'alias2',
    row: builtin('alias2', SPEND),
    inGroup: true,
  },
  {
    name: 'an outside tool its rule allows',
    slug: CONNECTOR.slug,
    row: CONNECTOR,
    outside: { ok: true, write: false },
  },
  {
    name: 'an outside tool its rule refuses',
    slug: CONNECTOR.slug,
    row: CONNECTOR,
    outside: { ok: false, reason: 'No workspace you hold has this connector.' },
  },
];

/** The app-tool ref a broker builds after asking the live rule. */
function appRef(c: Case, verdict: unknown): PolicyRef {
  const handler = c.row?.handler as ToolHandler | undefined;
  return {
    kind: 'app-tool',
    name: c.slug,
    ...(c.row ? { row: c.row } : {}),
    ...(handler?.kind === 'builtin'
      ? {
          builtin: {
            readOnly: isBuiltinReadOnly(handler.ref),
            spends: isBuiltinSpending(handler.ref),
          },
        }
      : {}),
    ...(verdict !== undefined ? { verdict } : {}),
  };
}

beforeEach(() => {
  h.rows.clear();
  h.inGroup = false;
  h.outside = null;
});

function arrange(c: Case): void {
  if (c.row) h.rows.set(c.slug, c.row);
  h.inGroup = c.inGroup ?? false;
  h.outside = c.outside ?? null;
}

describe('the gate at team rules equals memberAppToolVerdict', () => {
  it('picked a read, a write and a spending builtin from the registry', () => {
    expect(isBuiltinReadOnly(READ)).toBe(true);
    expect(isBuiltinReadOnly(WRITE)).toBe(false);
    expect(isBuiltinSpending(SPEND)).toBe(true);
  });

  for (const c of CASES) {
    it(c.name, async () => {
      arrange(c);
      const verdict = await memberAppToolVerdict(OWNER, c.declared ?? [c.slug], c.slug, LOGIN);
      const r = appRef(c, verdict);
      const listed = gateCheck(team, r);
      expect(listed === null, JSON.stringify(verdict)).toBe(verdict.ok);
      if (!verdict.ok) {
        expect(listed?.kind).toBe('narrowed');
        expect(listed?.message).toBe(verdict.reason);
      }
      // Listing equals calling.
      const called = await enterCall(team, r, async () => 'ran');
      expect(called.ok).toBe(verdict.ok);
      if (!called.ok) expect(called.refusal.toolText).toBe(listed?.message);
    });
  }

  it('covers both answers', async () => {
    const answers = new Set<boolean>();
    for (const c of CASES) {
      arrange(c);
      answers.add((await memberAppToolVerdict(OWNER, c.declared ?? [c.slug], c.slug, LOGIN)).ok);
    }
    expect([...answers].sort()).toEqual([false, true]);
  });
});

describe('fail closed at team rules', () => {
  it('an app tool with no verdict is refused, even one the rule allows', async () => {
    const allowed = CASES.find((c) => c.name === 'read-only, in a system-wide group')!;
    arrange(allowed);
    expect((await memberAppToolVerdict(OWNER, [allowed.slug], allowed.slug, LOGIN)).ok).toBe(true);
    expect(gateCheck(team, appRef(allowed, undefined))?.message).toBe(TEAM_APP_NO_TOOL_ERROR);
    expect(gateCheck(team, { kind: 'app-tool', name: 'x' })?.kind).toBe('unclassified');
  });

  it('every ref that is not an app tool is refused: web_search, a write, a refused slug', () => {
    // A stand-in for the owner MCP source (@mantle/mcp-core is not loaded
    // here): an open read, so only the member-app narrower can refuse.
    registerPolicySource('mcp-tool', () => ({ effect: 'read', scope: 'any' }));
    for (const name of ['web_search', WRITE, 'my_items_list', READ]) {
      expect(gateCheck(team, { kind: 'mcp-tool', name })?.message, name).toBe(
        TEAM_APP_NO_TOOL_ERROR,
      );
    }
    expect(gateCheck(team, { kind: 'runtime-tool', name: 'x', row: CONNECTOR })?.message).toBe(
      TEAM_APP_NO_TOOL_ERROR,
    );
    expect(gateCheck(team, { kind: 'job', name: 'worker:runs' })?.message).toBe(
      TEAM_APP_NO_TOOL_ERROR,
    );
  });

  it('every other caller passes the member-app narrower', async () => {
    const c = CASES.find((x) => x.name === 'a write')!;
    const r = appRef(c, undefined);
    for (const caller of [
      { ...team, facts: { appRules: 'admin' } },
      { ...team, facts: {} },
      { actor: systemActor('worker:runs'), via: 'process', admin: null } as GateCaller,
    ]) {
      expect(gateCheck(caller, r)).toBeNull();
    }
  });
});
