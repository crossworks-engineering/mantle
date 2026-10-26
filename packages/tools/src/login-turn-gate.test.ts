/**
 * A login's workspace turn runs the app tools (`loginTurns`, 2026-10-26)
 * only when its team surface names the very login its turn scope answers
 * (gateCallerFor's `loginTurn` fact, the owner-only narrower, and each app
 * handler's own check). Fix round 1 test gaps: a surface login that is not
 * the scope's, and a scope that is not a turn's (a user's MCP scope, kind
 * `user`), are refused by the gate and by the handler alike, and the
 * handler never runs.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Scope = { kind: 'assistant' | 'user'; loginId: string; ws: string[]; modWs: string[] };
const h = vi.hoisted(() => ({
  pre: vi.fn(async () => null),
  resolveTool: vi.fn(),
  scope: null as null | Scope,
}));
vi.mock('./preconditions', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkToolPreconditions: h.pre,
}));
vi.mock('./resolve', () => ({ resolveTool: h.resolveTool, resolveTools: vi.fn() }));
vi.mock('@mantle/db/viewer', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  currentWorkspaceScope: () => h.scope,
}));

import type { Tool } from '@mantle/db';
import { dispatchTool } from './dispatch';
import { gateCallerFor, runCaller } from './gate-callers';
import { ensureGateReady } from './gate-narrowers';
import { getBuiltin, registerBuiltin } from './registry';
import { surfaceGateFacts, OWNER_ONLY_ERROR } from './surface';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const L1 = '00000000-0000-4000-8000-0000000000a1';
const L2 = '00000000-0000-4000-8000-0000000000a2';
const turnScope = (loginId: string): Scope => ({
  kind: 'assistant',
  loginId,
  ws: ['w1'],
  modWs: [],
});
const userScope = (loginId: string): Scope => ({ kind: 'user', loginId, ws: ['w1'], modWs: [] });
const team = (loginId: string): ToolHandlerContext['surface'] => ({ kind: 'team', loginId });

const row = (slug: string) =>
  ({ slug, handler: { kind: 'builtin', ref: slug }, requiresConfirm: false }) as unknown as Tool;

beforeAll(() => ensureGateReady());

const SLUGS = ['app_update', 'app_create', 'app_undelete'];
const originals = new Map<string, BuiltinToolDef>();
const spy = vi.fn(async () => ({ ok: true as const, output: 'ran' }));

beforeEach(() => {
  spy.mockClear();
  h.scope = null;
  for (const slug of SLUGS) {
    const def = getBuiltin(slug)!;
    originals.set(slug, def);
    registerBuiltin({ ...def, handler: spy });
  }
});
afterEach(() => {
  for (const def of originals.values()) registerBuiltin(def);
});

describe('the gate’s loginTurn fact', () => {
  it('is set only when the team surface names the turn scope’s own login', async () => {
    const facts = async (scope: Scope | null, surface: ToolHandlerContext['surface']) => {
      h.scope = scope;
      const caller = await gateCallerFor(runCaller(), null, true, surfaceGateFacts(surface));
      return caller.facts?.loginTurn === true;
    };
    expect(await facts(turnScope(L1), team(L1))).toBe(true);
    expect(await facts(turnScope(L1), team(L2))).toBe(false);
    expect(await facts(userScope(L1), team(L1))).toBe(false);
    expect(await facts(null, team(L1))).toBe(false);
    expect(await facts(turnScope(L1), { kind: 'team' })).toBe(false);
  });
});

describe('an app tool on a team surface', () => {
  const cases: Array<[string, Scope | null, string]> = [
    ['a surface login that is not the turn scope’s', turnScope(L1), L2],
    ['a user-kind scope (an MCP scope, not a turn’s)', userScope(L1), L1],
    ['no scope', null, L1],
  ];

  it.each(cases)('the gate refuses %s before the handler', async (_n, scope, login) => {
    h.scope = scope;
    for (const slug of SLUGS) {
      const res = await dispatchTool(
        row(slug),
        { id: L1, name: 'x' },
        {
          ownerId: 'o1',
          caller: runCaller(),
          surface: team(login),
        },
      );
      expect(res, slug).toEqual({ ok: false, error: OWNER_ONLY_ERROR });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it.each(cases)('the handler refuses %s on its own (the MCP path)', async (_n, scope, login) => {
    h.scope = scope;
    for (const slug of SLUGS) {
      const res = await originals.get(slug)!.handler(
        { id: L1, name: 'x' },
        {
          ownerId: 'o1',
          surface: team(login),
        },
      );
      expect(res, slug).toEqual({ ok: false, error: OWNER_ONLY_ERROR });
    }
  });

  it('the turn scope’s own login passes the gate (the database decides after)', async () => {
    h.scope = turnScope(L1);
    const res = await dispatchTool(
      row('app_update'),
      { id: L1, name: 'x' },
      { ownerId: 'o1', caller: runCaller(), surface: team(L1) },
    );
    expect(res).toEqual({ ok: true, output: 'ran' });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
