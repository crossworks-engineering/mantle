/**
 * The gate callers of the dispatch entries (A5 step 3a low round): what
 * each call's gate caller holds, and the answers that must stay main's.
 *
 *  - LOW-2: a call with no actor bound runs with none, as on main (so the
 *    actor check refuses its item writes), never as a system actor that
 *    may write.
 *  - LOW-1: the Admin area is read on every call, as adminToolGate read it:
 *    an area turned off mid-turn refuses the turn's next call.
 *  - LOW-5: a non-Admin workspace assistant (an assistant actor, which
 *    readOnlyActor and systemUnder do not narrow) is refused at the Admin
 *    step before any Admin-area read runs, so no system work of one runs
 *    for it; and login(owner) reads as login(ro) inside a read tool.
 *  - Owner Q2: a pending call approved from inside an assistant turn, as
 *    another login, names no create home of its own: the outer
 *    pending_approve call's home decides, and with none the database's
 *    default names only the asked, the folder's or the Admin workspace.
 *
 * The database is stubbed as dispatch-parity.test.ts stubs it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  scope: null as null | Record<string, unknown>,
  view: { holdsAdmin: false, areas: new Set<string>() },
  areaReads: 0,
  intents: [] as unknown[],
  ran: [] as {
    slug: string;
    actor: unknown;
    mode: string | null;
    systemMode: string | null;
    home: unknown;
  }[],
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
  };
});
vi.mock('../../db/src/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/src/client')>()),
  scopeHoldsAdmin: async () => h.view.holdsAdmin,
  scopeHasArea: async (a: string) => {
    h.areaReads += 1;
    return h.view.holdsAdmin && h.view.areas.has(a);
  },
  loginHasArea: async (_l: string, a: string) => h.view.areas.has(a),
}));
vi.mock('../../db/src/create-home', () => ({
  createHomeIntent: vi.fn(async (...args: unknown[]) => {
    h.intents.push(args);
    return { createWs: null, privateWs: null };
  }),
}));
vi.mock('./preconditions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./preconditions')>()),
  checkToolPreconditions: async () => null,
}));
vi.mock('./registry', async (importOriginal) => {
  const real = await importOriginal<typeof import('./registry')>();
  return {
    ...real,
    // Every handler is a recorder: who it ran as, and its system work's mode.
    getBuiltinHandler: (slug: string) =>
      real.getBuiltinHandler(slug)
        ? async () => {
            const db = await import('@mantle/db');
            const actor = db.currentActor();
            h.ran.push({
              slug,
              actor,
              mode: actor ? db.writeModeOf(actor) : null,
              systemMode: db.writeModeOf(db.systemUnder('test:probe', actor)),
              home: db.currentCreateHome(),
            });
            return { ok: true, output: { ran: slug } };
          }
        : null,
  };
});

import type { Tool } from '@mantle/db';
import { loginActor, runAsActor, runWithoutActor, withCreateHome } from '@mantle/db';
import {
  ADMIN_ONLY_ERROR,
  BUILTIN_TOOLS,
  adminAreaError,
  dispatchTool,
  pendingCaller,
  policySystemWhole,
  turnCaller,
} from './index';
import { gateCallerFor } from './gate-callers';
import type { ToolHandlerContext } from './types';

const OWNER = '99999999-9999-4999-8999-999999999999';
const LOGIN = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';
const AGENT = '88888888-8888-4888-8888-888888888888';
const ADMIN_WS = '11111111-1111-4111-8111-111111111111';
const TEAM_WS = '22222222-2222-4222-8222-222222222222';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function row(slug: string): Tool {
  return {
    slug,
    ownerId: OWNER,
    handler: { kind: 'builtin', ref: slug },
    requiresConfirm: false,
    inputSchema: { type: 'object', properties: {} },
    description: '',
    externalAccess: null,
  } as unknown as Tool;
}

function ctx(
  caller = turnCaller(),
  surface: ToolHandlerContext['surface'] = { kind: 'web', loginId: LOGIN },
): ToolHandlerContext {
  return { ownerId: OWNER, caller, ...(surface ? { surface } : {}) } as ToolHandlerContext;
}

/** An Admin assistant turn of LOGIN, every area on. */
function adminTurn(): Record<string, unknown> {
  h.view = { holdsAdmin: true, areas: new Set(['settings', 'users', 'assistants', 'connectors']) };
  h.scope = { kind: 'assistant', loginId: LOGIN, ws: [ADMIN_WS], modWs: [ADMIN_WS] };
  return h.scope;
}

const byEffect = (effect: 'read' | 'write') =>
  BUILTIN_TOOLS.filter((d) => d.policy.effect === effect && !d.ownerOnly);

beforeEach(() => {
  h.scope = null;
  h.view = { holdsAdmin: false, areas: new Set() };
  h.areaReads = 0;
  h.intents = [];
  h.ran = [];
});

describe('a call with no actor runs with none (LOW-2)', () => {
  it('binds no actor: the actor check refuses its item writes, as on main', async () => {
    adminTurn();
    const write = byEffect('write').find((d) => d.policy.scope === 'any')!;
    const read = byEffect('read').find((d) => d.policy.scope === 'any')!;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const def of [write, read]) {
      const res = await runWithoutActor(() => dispatchTool(row(def.slug), {}, ctx()));
      expect(res.ok, def.slug).toBe(true);
    }
    warn.mockRestore();
    expect(h.ran.map((r) => r.slug)).toEqual([write.slug, read.slug]);
    for (const r of h.ran) expect(r.actor, r.slug).toBeNull();
    // No create home is named for a call with no login actor.
    expect(h.intents).toEqual([]);
  });

  it('gives the gate no actor, never a system one', async () => {
    adminTurn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const caller = await runWithoutActor(() =>
      gateCallerFor(turnCaller(), { effect: 'write', scope: 'any' }, true),
    );
    warn.mockRestore();
    expect(caller.actor).toBeNull();
  });
});

describe('the Admin area is read on every call (LOW-1)', () => {
  it('an area turned off mid-turn refuses the next call of the same turn', async () => {
    const turn = adminTurn();
    const def = BUILTIN_TOOLS.find(
      (d) =>
        typeof d.policy.scope === 'object' && !d.ownerOnly && d.policy.scope.area === 'settings',
    )!;
    expect(def, 'a settings-area builtin').toBeDefined();
    const first = await runAsActor(loginActor(LOGIN), () => dispatchTool(row(def.slug), {}, ctx()));
    expect(first.ok).toBe(true);
    // The owner turns the area off while the turn runs: same scope object.
    h.view = { holdsAdmin: true, areas: new Set() };
    expect(h.scope).toBe(turn);
    const second = await runAsActor(loginActor(LOGIN), () =>
      dispatchTool(row(def.slug), {}, ctx()),
    );
    expect(second).toEqual({ ok: false, error: adminAreaError('settings') });
    expect(h.areaReads).toBe(2);
    expect(h.ran.map((r) => r.slug)).toEqual([def.slug]);
  });
});

describe('an assistant actor in a read tool (LOW-5)', () => {
  /** A workspace assistant's turn with no user (a heartbeat of a
   *  workspace assistant): the assistant actor, a non-Admin workspace. */
  function workspaceAssistant(): void {
    h.view = { holdsAdmin: false, areas: new Set() };
    h.scope = { kind: 'assistant', loginId: null, ws: [TEAM_WS], modWs: [] };
  }

  it('is refused at the Admin step before any Admin-area read runs', async () => {
    workspaceAssistant();
    const admin = byEffect('read').filter((d) => d.policy.scope !== 'any');
    expect(admin.length).toBeGreaterThan(5);
    // Every read that runs whole on the system pool is among them.
    for (const def of BUILTIN_TOOLS.filter((d) => policySystemWhole(d.policy))) {
      if (def.policy.effect === 'read' && !def.ownerOnly) {
        expect(admin.includes(def), def.slug).toBe(true);
      }
    }
    for (const def of admin) {
      const res = await runAsActor({ kind: 'assistant', agentId: AGENT }, () =>
        dispatchTool(row(def.slug), {}, ctx(turnCaller(), { kind: 'team', loginId: OTHER })),
      );
      expect(res, def.slug).toEqual({ ok: false, error: ADMIN_ONLY_ERROR });
    }
    expect(h.ran).toEqual([]);
  });

  it('is not narrowed where it runs (pinned: its system work writes)', async () => {
    workspaceAssistant();
    const def = byEffect('read').find((d) => d.policy.scope === 'any')!;
    await runAsActor({ kind: 'assistant', agentId: AGENT }, () =>
      dispatchTool(row(def.slug), {}, ctx(turnCaller(), { kind: 'team', loginId: OTHER })),
    );
    expect(h.ran[0]?.actor).toEqual({ kind: 'assistant', agentId: AGENT });
    expect(h.ran[0]?.mode).toBe('ro');
    expect(h.ran[0]?.systemMode).toBe('rw');
  });

  it('login(owner) reads as login(ro) inside a read tool', async () => {
    adminTurn();
    const def = byEffect('read').find((d) => d.policy.scope === 'any')!;
    await runAsActor(loginActor(LOGIN, 'owner'), () => dispatchTool(row(def.slug), {}, ctx()));
    expect(h.ran[0]?.actor).toEqual({ kind: 'login', mode: 'ro', loginId: LOGIN });
    expect(h.ran[0]?.systemMode).toBe('ro');
  });
});

describe('a pending call approved inside a turn names no home of its own (owner Q2)', () => {
  const PRIVATE = '77777777-7777-4777-8777-777777777777';
  const write = () => byEffect('write').find((d) => d.policy.scope === 'any')!;

  it("the outer pending_approve call's home decides", async () => {
    adminTurn();
    const outer = { createWs: ADMIN_WS, privateWs: PRIVATE };
    await withCreateHome(outer, () =>
      runAsActor(loginActor(OTHER), () =>
        dispatchTool(
          row(write().slug),
          {},
          ctx(pendingCaller(), { kind: 'owner', via: 'pending', loginId: LOGIN }),
        ),
      ),
    );
    expect(h.ran[0]?.home).toEqual(outer);
    expect(h.intents).toEqual([]);
  });

  it('with none around, it names none: the database default decides', async () => {
    adminTurn();
    await runAsActor(loginActor(OTHER), () =>
      dispatchTool(
        row(write().slug),
        {},
        ctx(pendingCaller(), { kind: 'owner', via: 'pending', loginId: LOGIN }),
      ),
    );
    expect(h.ran[0]?.home).toBeNull();
    expect(h.intents).toEqual([]);
  });

  it('the database default names only the asked, the private, the folder or the Admin workspace', () => {
    const dir = join(repoRoot, 'packages/db/migrations');
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const re = /CREATE OR REPLACE FUNCTION "public"\."mantle_default_home"\([\s\S]*?\n\$\$;/g;
    let body = '';
    for (const f of files) {
      for (const m of readFileSync(join(dir, f), 'utf8').matchAll(re)) body = m[0];
    }
    expect(body).toContain('mantle_default_home');
    const returns = new Set([...body.matchAll(/RETURN ([a-z_]+);/gi)].map((m) => m[1]!));
    // req: mantle.create_ws, the asked workspace (none here); priv:
    // mantle.private_ws (none here); home: the folder the item is made in;
    // admin_ws: the Admin workspace. Nothing else.
    expect([...returns].sort()).toEqual(['NULL', 'admin_ws', 'home', 'priv', 'req']);
    expect(body).toMatch(/req uuid := "public"\."mantle_setting_uuid"\('mantle\.create_ws'\)/);
    expect(body).toMatch(/priv uuid := "public"\."mantle_setting_uuid"\('mantle\.private_ws'\)/);
    expect(body).toMatch(
      /SELECT f\."home_ws", f\."write_ws" INTO home, fw FROM "public"\."nodes" f/,
    );
  });
});
