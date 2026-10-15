/**
 * Listing equals calling for a tool loop (A5 step 5 fix round 1, L7): for
 * the owner, an Admin user, a member who is a user of Admin with no area,
 * and a member outside Admin, every tool turnListedTools lists is called
 * through dispatchTool for the same caller (turnCaller, the scope the loop
 * runs in) and reaches its handler: the gate refuses none of it. And every
 * tool it hides is refused by dispatch's gate for that caller, in the
 * gate's words.
 *
 * The real gate and dispatch. The scope, the Admin view and the database's
 * answers are stood in (no database); every builtin's handler is a fake
 * that records it ran; an outside row's fetch is stubbed. A shell row is
 * asked by its gate refusal only (dispatch would run its command).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  scope: null as null | Record<string, unknown>,
  view: { holdsAdmin: false, areas: new Set<string>() },
  ran: new Set<string>(),
}));

// No database here: the Moderator seat a turn holds is not taken away
// (moderator-seat.ts reads it; a8-findings.db.test.ts takes one away).
vi.mock('./moderator-seat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./moderator-seat')>()),
  moderatorSeatLost: async () => false,
}));
vi.mock('../../db/src/viewer', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/src/viewer')>();
  return {
    ...real,
    currentWorkspaceScope: () => h.scope ?? real.currentWorkspaceScope(),
    currentGateScope: () => null,
    asSystem: (fn: () => Promise<unknown>) => fn(),
  };
});
vi.mock('../../db/src/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/src/client')>();
  const viewer = await import('../../db/src/viewer');
  const chain = () => {
    const q: Record<string, unknown> = {};
    for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'limit', 'orderBy', 'groupBy']) {
      q[m] = () => q;
    }
    q.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
      Promise.resolve([]).then(ok, bad);
    return q;
  };
  return {
    ...real,
    db: { select: () => chain(), insert: () => ({ values: async () => [] }) },
    scopeHoldsAdmin: async () => h.view.holdsAdmin,
    scopeHasArea: async (a: string) => h.view.holdsAdmin && h.view.areas.has(a),
    // A turn scope without a database: the scope alone.
    withTurnScope: (scope: never, fn: () => Promise<unknown>) => viewer.runInViewerScope(scope, fn),
  };
});
vi.mock('../../db/src/create-home', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createHomeIntent: async () => ({ createWs: null, privateWs: null }),
}));
vi.mock('./preconditions', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkToolPreconditions: async () => null,
}));
vi.mock('./item-write-gate', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  toolItemWriteRefusal: async () => null,
  toolItemWriteRefusalOf: async () => null,
}));

import { loginActor, runAsActor, type Tool } from '@mantle/db';
import {
  BUILTIN_TOOLS,
  dispatchTool,
  ensureGateReady,
  getBuiltin,
  turnCallRefusal,
  turnCaller,
  turnListedTools,
} from './index';
import type { BuiltinToolDef } from './types';

const OWNER = '99999999-9999-4999-8999-999999999999';
const LOGIN = '55555555-5555-4555-8555-555555555555';
const ADMIN_WS = '11111111-1111-4111-8111-111111111111';
const TEAM_WS = '22222222-2222-4222-8222-222222222222';
const AREAS = ['settings', 'users', 'assistants', 'connectors', 'keys'];

const builtinRow = (slug: string) =>
  ({
    slug,
    ownerId: OWNER,
    handler: { kind: 'builtin', ref: slug },
    requiresConfirm: false,
    inputSchema: { type: 'object', properties: {} },
  }) as unknown as Tool;
const runtime = (slug: string, handler: Record<string, unknown>) =>
  ({
    slug,
    ownerId: OWNER,
    handler,
    requiresConfirm: false,
    externalAccess: null,
    description: slug,
    inputSchema: { type: 'object', properties: {} },
  }) as unknown as Tool;

const ROWS = [
  ...BUILTIN_TOOLS.map((d) => builtinRow(d.slug)),
  runtime('api_get', { kind: 'http', url: 'https://api.example.test/v1', method: 'GET' }),
  runtime('a_recipe', { kind: 'recipe', steps: [{ tool: 'search_nodes' }] }),
  runtime('shell_echo', { kind: 'shell', cmd: 'echo hi' }),
  runtime('odd', { kind: 'carrier-pigeon' }),
];

/** The builtins of each class the gate's scope step reads. */
const byScope = (want: (s: BuiltinToolDef['policy']['scope']) => boolean) =>
  BUILTIN_TOOLS.filter((d) => want(d.policy.scope)).map((d) => d.slug);
const ADMIN = byScope((s) => s === 'admin');
const ADMIN_KIND = byScope((s) => s === 'admin-kind');
const AREA = byScope((s) => typeof s === 'object');

type Caller = {
  scope: Record<string, unknown>;
  view: () => { holdsAdmin: boolean; areas: Set<string> };
  /** Exactly what the loop does not list for it. */
  hidden: readonly string[];
};
const CALLERS: Record<string, Caller> = {
  owner: {
    scope: { kind: 'assistant', loginId: LOGIN, ws: [ADMIN_WS], modWs: [ADMIN_WS] },
    view: () => ({ holdsAdmin: true, areas: new Set(AREAS) }),
    // A row with no policy, never callable.
    hidden: ['odd'],
  },
  'an Admin user': {
    scope: { kind: 'assistant', loginId: LOGIN, ws: [ADMIN_WS, TEAM_WS], modWs: [] },
    view: () => ({ holdsAdmin: true, areas: new Set(AREAS) }),
    hidden: ['odd'],
  },
  'a member in Admin with no area': {
    scope: { kind: 'assistant', loginId: LOGIN, ws: [ADMIN_WS, TEAM_WS], modWs: [TEAM_WS] },
    view: () => ({ holdsAdmin: true, areas: new Set<string>() }),
    // The Admin-area tools: Admin, but none of its areas.
    hidden: [...AREA, 'odd'],
  },
  'a member outside Admin': {
    scope: { kind: 'assistant', loginId: LOGIN, ws: [TEAM_WS], modWs: [TEAM_WS] },
    view: () => ({ holdsAdmin: false, areas: new Set<string>() }),
    // Admin-only tools, creates of an Admin-only kind, Admin-area tools and
    // shell rows (Q2).
    hidden: [...ADMIN, ...ADMIN_KIND, ...AREA, 'shell_echo', 'odd'],
  },
};

function inCaller<T>(c: Caller, fn: () => Promise<T>): Promise<T> {
  h.scope = c.scope;
  h.view = c.view();
  return runAsActor(loginActor(LOGIN), fn).finally(() => {
    h.scope = null;
  });
}

const realHandlers = new Map<string, BuiltinToolDef['handler']>();
beforeAll(() => {
  ensureGateReady();
  for (const def of BUILTIN_TOOLS) {
    const live = getBuiltin(def.slug)!;
    realHandlers.set(def.slug, live.handler);
    (live as { handler: BuiltinToolDef['handler'] }).handler = async () => {
      h.ran.add(def.slug);
      return { ok: true, output: { ran: def.slug } };
    };
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{"ok":true}', { headers: { 'content-type': 'json' } })),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterAll(() => {
  for (const [slug, handler] of realHandlers) {
    (getBuiltin(slug) as { handler: BuiltinToolDef['handler'] }).handler = handler;
  }
  vi.unstubAllGlobals();
});

describe('listing equals calling for a tool loop (A5 step 5 fix round 1, L7)', () => {
  for (const [name, caller] of Object.entries(CALLERS)) {
    it(`${name}: every listed tool is called past the gate; every hidden one is refused by it`, async () => {
      const listed = new Set(
        (await inCaller(caller, () => turnListedTools(ROWS))).map((t) => t.slug),
      );
      const hidden = ROWS.map((r) => r.slug).filter((slug) => !listed.has(slug));
      expect(hidden.sort()).toEqual([...new Set(caller.hidden)].sort());
      let ranBuiltins = 0;
      for (const row of ROWS) {
        // The gate's own verdict for the call dispatch would make.
        const refused = await inCaller(caller, () =>
          turnCallRefusal(row, {}, { ownerId: OWNER, surface: { kind: 'web' } }),
        );
        expect(refused === null, `${row.slug}: listed ${listed.has(row.slug)}`).toBe(
          listed.has(row.slug),
        );
        if ((row.handler as { kind: string }).kind === 'shell') continue;
        h.ran.clear();
        const res = await inCaller(caller, () =>
          dispatchTool(row, {}, { ownerId: OWNER, surface: { kind: 'web' }, caller: turnCaller() }),
        );
        if (listed.has(row.slug)) {
          // Past the gate: a builtin's handler ran; an outside row answers
          // anything but a gate refusal.
          if ((row.handler as { kind: string }).kind === 'builtin') {
            expect(h.ran.has(row.slug), `${row.slug}: ${JSON.stringify(res)}`).toBe(true);
            ranBuiltins += 1;
          } else if (!res.ok) {
            expect(res.error, row.slug).not.toBe(refused);
          }
        } else {
          expect(res, row.slug).toEqual({ ok: false, error: refused });
          expect(h.ran.has(row.slug), row.slug).toBe(false);
        }
      }
      // Not vacuous: every listed builtin was called and ran.
      expect(ranBuiltins).toBe(BUILTIN_TOOLS.filter((d) => listed.has(d.slug)).length);
      expect(ranBuiltins).toBeGreaterThan(100);
    }, 60_000);
  }
});
