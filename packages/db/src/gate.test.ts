/**
 * THE one ordered gate (arch A3c, plan section 2): a test for each of the
 * eight steps, the order they run in, and listing equals calling. The
 * database is stubbed: the scope binding (withTurnScope) and the create-home
 * intent (createHomeIntent, its own tests) record what they were asked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ log: [] as string[] }));

vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client')>()),
  withTurnScope: vi.fn(
    async (_scope: unknown, fn: () => Promise<unknown>, o?: { writes?: boolean }) => {
      h.log.push(`scope:${o?.writes ? 'writes' : 'reads'}`);
      return fn();
    },
  ),
}));
vi.mock('./create-home', () => ({
  createHomeIntent: vi.fn(async () => {
    h.log.push('home');
    return { createWs: null, privateWs: 'p1' };
  }),
}));

import { ADMIN_ONLY_ERROR, adminAreaError, ADMIN_KIND_CREATE_ERROR } from '@mantle/std';
import { currentActor, loginActor, systemActor, type Actor } from './actor';
import { withTurnScope } from './client';
import { createHomeIntent } from './create-home';
import {
  GateNotReadyError,
  NARROWERS,
  READ_ONLY_CALLER_ERROR,
  currentCaller,
  enterCall,
  gateCheck,
  gateLists,
  registerNarrower,
  registerPolicySource,
  resetGateRegistry,
  type GateCaller,
  type GatePolicy,
  type Narrower,
  type NarrowerName,
  type PolicyRef,
} from './gate';
import { currentCreateHome, type WorkspaceScope } from './viewer';

const LOGIN = '55555555-5555-4555-8555-555555555555';
const W1 = '11111111-1111-4111-8111-111111111111';
const SCOPE: WorkspaceScope = { kind: 'user', loginId: LOGIN, ws: [W1], modWs: [W1] };

const POLICIES: Record<string, GatePolicy> = {
  read: { effect: 'read', scope: 'any' },
  write: { effect: 'write', scope: 'any' },
  create: { effect: 'write', scope: 'any', creates: 'page' },
  remove: { effect: 'write', scope: 'any', makesItems: false },
  admin: { effect: 'read', scope: 'admin' },
  adminKind: { effect: 'write', scope: 'admin-kind', creates: 'contact' },
  keys: { effect: 'write', scope: { area: 'keys' } },
};

const ref = (name: string): PolicyRef => ({ kind: 'test', name });

function login(over: Partial<GateCaller> = {}): GateCaller {
  return {
    actor: loginActor(LOGIN, 'rw'),
    via: 'oauth',
    loginId: LOGIN,
    admin: { holdsAdmin: false, areas: new Set() },
    ...over,
  };
}

const ok = async () => {
  h.log.push('run');
  return 'done';
};

const TEST_SOURCE = (r: PolicyRef) => POLICIES[r.name] ?? null;
const NOOP: Narrower = () => null;

/** A fresh registry: the test source, and every narrower (a no-op unless
 *  the test gives its own). */
function setup(over: Partial<Record<NarrowerName, Narrower>> = {}): void {
  resetGateRegistry();
  registerPolicySource('test', TEST_SOURCE);
  for (const n of NARROWERS) if (n !== 'read-only') registerNarrower(n, over[n] ?? NOOP);
}

beforeEach(() => {
  setup();
  h.log = [];
  vi.mocked(createHomeIntent).mockClear();
  vi.mocked(withTurnScope).mockClear();
});
afterEach(() => resetGateRegistry());

describe('step 1: resolve the caller', () => {
  it('no caller: refused 401, nothing runs', async () => {
    const run = vi.fn(ok);
    const r = await enterCall(async () => null, ref('read'), run);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.kind).toBe('unauthorized');
      expect(r.refusal.http).toEqual({ status: 401, body: { error: 'unauthorized' } });
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('a resolver runs once; a resolved caller is taken as is', async () => {
    const resolve = vi.fn(async () => login());
    expect(await enterCall(resolve, ref('read'), ok)).toEqual({ ok: true, value: 'done' });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(await enterCall(login(), ref('read'), ok)).toEqual({ ok: true, value: 'done' });
  });
});

describe('step 2: bind the caller', () => {
  it('currentCaller() is the caller inside the call, null outside', async () => {
    const caller = login({ via: 'key' });
    let seen: GateCaller | null = null;
    await enterCall(caller, ref('read'), async () => {
      seen = currentCaller();
    });
    // A frozen copy of the caller (fix round 2, L-c), not the object itself;
    // its Sets read-only views (LOW-3), holding the same values.
    const bound = seen as unknown as GateCaller;
    expect({ ...bound, admin: { ...bound.admin, areas: new Set(bound.admin?.areas) } }).toEqual(
      caller,
    );
    expect(seen).not.toBe(caller);
    expect(currentCaller()).toBeNull();
  });
});

describe('step 3: the declared policy, then the actor and the scope', () => {
  it('no entry: refused (an unknown kind, a source with no entry, a bad job reason)', async () => {
    for (const r of [
      { kind: 'nope', name: 'read' },
      ref('missing'),
      { kind: 'job', name: 'Not A Reason' },
    ]) {
      const res = await enterCall(login(), r, ok);
      expect(res.ok, r.name).toBe(false);
      if (!res.ok) {
        expect(res.refusal.kind).toBe('unclassified');
        expect(res.refusal.http?.status).toBe(403);
      }
      expect(gateCheck(login(), r)?.kind).toBe('unclassified');
    }
    expect(h.log).toEqual([]);
  });

  it('a job runs as its system reason', async () => {
    let actor: Actor | null = null;
    const proc: GateCaller = { actor: systemActor('worker:runs'), via: 'process', admin: null };
    const r = await enterCall(proc, { kind: 'job', name: 'worker:extract' }, async () => {
      actor = currentActor();
    });
    expect(r.ok).toBe(true);
    expect(actor).toEqual(systemActor('worker:extract'));
  });

  it('a read runs read only; a write as the caller; the policy actor first', async () => {
    const seen: (Actor | null)[] = [];
    const note = async () => {
      seen.push(currentActor());
    };
    await enterCall(login(), ref('read'), note);
    await enterCall(login(), ref('write'), note);
    registerPolicySource('pub', () => ({
      effect: 'write',
      scope: 'any',
      actor: systemActor('http:signup'),
    }));
    await enterCall(login(), { kind: 'pub', name: 'signup' }, note);
    expect(seen).toEqual([
      { kind: 'login', mode: 'ro', loginId: LOGIN },
      loginActor(LOGIN, 'rw'),
      systemActor('http:signup'),
    ]);
  });

  it('enters the caller scope, writing only for a write; a surface may enter its own', async () => {
    await enterCall(login({ scope: SCOPE }), ref('read'), ok);
    await enterCall(login({ scope: SCOPE }), ref('write'), ok);
    expect(vi.mocked(withTurnScope).mock.calls.map((c) => c[2])).toEqual([
      { writes: false },
      { writes: true },
    ]);
    const entered: boolean[] = [];
    const enterScope = async <T>(writes: boolean, fn: () => Promise<T>): Promise<T> => {
      entered.push(writes);
      return fn();
    };
    await enterCall(login({ scope: SCOPE, enterScope }), ref('write'), ok);
    expect(entered).toEqual([true]);
    expect(withTurnScope).toHaveBeenCalledTimes(2);
  });
});

describe('step 4: narrow by surface', () => {
  it('a read-only credential calls reads only', async () => {
    const ro = login({ write: false });
    expect(gateLists(ro, ref('read'))).toBe(true);
    const r = await enterCall(ro, ref('write'), ok);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.kind).toBe('narrowed');
      expect(r.refusal.toolText).toBe(READ_ONLY_CALLER_ERROR);
      expect(r.refusal.http).toEqual({
        status: 403,
        body: { error: 'forbidden', reason: 'narrowed', message: READ_ONLY_CALLER_ERROR },
      });
    }
  });

  it('the narrowers run in their fixed order, whatever order they registered in', async () => {
    const order: string[] = [];
    const over: Partial<Record<NarrowerName, Narrower>> = {};
    for (const name of ['turn-caps', 'spending', 'member-app', 'peer', 'key'] as const) {
      over[name] = () => {
        order.push(name);
        return null;
      };
    }
    setup(over);
    await enterCall(login(), ref('read'), ok);
    expect(order).toEqual(NARROWERS.filter((n) => n !== 'read-only'));
  });

  it('the first refusal stops the call and the later narrowers', async () => {
    const later = vi.fn(() => null);
    setup({ key: () => 'not in this key area', spending: later });
    const r = await enterCall(login(), ref('read'), ok);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.toolText).toBe('not in this key area');
    expect(later).not.toHaveBeenCalled();
    expect(h.log).not.toContain('run');
  });

  it('a narrower reads the caller, the policy and the ref', () => {
    setup({
      peer: (c, p, r) =>
        c.via === 'peer' && p.fields?.risky && !(c.facts?.risky as string[]).includes(r.name)
          ? 'risky'
          : null,
    });
    registerPolicySource('t2', () => ({ effect: 'read', scope: 'any', fields: { risky: true } }));
    const peer = login({ via: 'peer', facts: { risky: ['allowed'] } });
    expect(gateLists(peer, { kind: 't2', name: 'allowed' })).toBe(true);
    expect(gateCheck(peer, { kind: 't2', name: 'other' })?.message).toBe('risky');
    expect(gateLists(login(), { kind: 't2', name: 'other' })).toBe(true);
  });

  it('the read-only narrower is the gate own; an unknown narrower is refused', () => {
    expect(() => registerNarrower('read-only', () => null)).toThrow();
    expect(() => registerNarrower('nope' as never, () => null)).toThrow();
  });
});

describe('step 5: the Admin step', () => {
  const admin = login({ admin: { holdsAdmin: true, areas: new Set(['keys']) } });
  const adminNoKeys = login({ admin: { holdsAdmin: true, areas: new Set() } });

  it('the Admin workspace, an Admin area, an Admin-only kind', () => {
    expect(gateLists(admin, ref('admin'))).toBe(true);
    expect(gateLists(admin, ref('keys'))).toBe(true);
    expect(gateLists(admin, ref('adminKind'))).toBe(true);
    expect(gateCheck(login(), ref('admin'))?.message).toBe(ADMIN_ONLY_ERROR);
    expect(gateCheck(login(), ref('keys'))?.message).toBe(ADMIN_ONLY_ERROR);
    expect(gateCheck(adminNoKeys, ref('keys'))?.message).toBe(adminAreaError('keys'));
    expect(gateCheck(login(), ref('adminKind'))?.message).toBe(ADMIN_KIND_CREATE_ERROR);
  });

  it('the area refusal answers the guard 403 with its area', async () => {
    const r = await enterCall(adminNoKeys, ref('keys'), ok);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.http).toEqual({
        status: 403,
        body: {
          error: 'forbidden',
          reason: 'area',
          area: 'keys',
          message: 'You cannot manage this part of the brain.',
        },
      });
    }
  });

  it('unscoped (null): the surface rules decide; unknown (absent): refused', () => {
    const unscoped = login({ admin: null });
    const unknown = login({ admin: undefined });
    for (const p of ['admin', 'keys', 'adminKind']) {
      expect(gateLists(unscoped, ref(p)), p).toBe(true);
      expect(gateLists(unknown, ref(p)), p).toBe(false);
    }
    expect(gateLists(unknown, ref('read'))).toBe(true);
  });
});

describe('step 6: the create-home intent', () => {
  it('a create asks the one intent with what the call asked, and runs in its home', async () => {
    let home: unknown = null;
    const ask = { from: 'argument' as const, workspace: 'Research' };
    const r = await enterCall(
      login(),
      ref('create'),
      async () => {
        home = currentCreateHome();
      },
      { ask },
    );
    expect(r.ok).toBe(true);
    expect(createHomeIntent).toHaveBeenCalledWith(LOGIN, ask, {
      ownWork: 'auto',
      makePrivate: true,
    });
    expect(home).toEqual({ createWs: null, privateWs: 'p1' });
  });

  it('a write that is not a create: the fallback only; a delete makes no private workspace', async () => {
    await enterCall(login(), ref('write'), ok, {
      ask: { from: 'param', ws: '11111111-1111-4111-8111-111111111111' },
    });
    await enterCall(login(), ref('remove'), ok);
    expect(vi.mocked(createHomeIntent).mock.calls).toEqual([
      [LOGIN, null, { ownWork: 'auto', makePrivate: true }],
      [LOGIN, null, { ownWork: 'auto', makePrivate: false }],
    ]);
  });

  it('the fallback a connection resolved is used as is', async () => {
    await enterCall(login({ createFallback: { privateWs: 'p9' } }), ref('create'), ok);
    expect(createHomeIntent).toHaveBeenCalledWith(LOGIN, null, { privateWs: 'p9' });
  });

  it('a read, and a caller that is no login, name no home', async () => {
    await enterCall(login(), ref('read'), ok);
    const proc: GateCaller = { actor: systemActor('worker:runs'), via: 'process', admin: null };
    await enterCall(proc, ref('create'), ok);
    expect(createHomeIntent).not.toHaveBeenCalled();
  });

  it('a refused home: 403 workspace, or 400 for a ?ws= that is no id', async () => {
    vi.mocked(createHomeIntent).mockResolvedValueOnce({
      refused: 'not-moderator',
      message: 'You are not a Moderator of Sales.',
    });
    const r1 = await enterCall(login(), ref('create'), ok);
    vi.mocked(createHomeIntent).mockResolvedValueOnce({
      refused: 'invalid',
      message: 'ws must be a workspace id.',
    });
    const r2 = await enterCall(login(), ref('create'), ok);
    expect(r1.ok || r2.ok).toBe(false);
    if (!r1.ok && !r2.ok) {
      expect(r1.refusal.http).toEqual({
        status: 403,
        body: {
          error: 'forbidden',
          reason: 'workspace',
          message: 'You are not a Moderator of Sales.',
        },
      });
      expect(r1.refusal.toolText).toBe('You are not a Moderator of Sales.');
      expect(r2.refusal.http?.status).toBe(400);
    }
    expect(h.log).not.toContain('run');
  });
});

describe('step 7 and 8: run, then map', () => {
  it('a database refusal while running is mapped (no_read: 404, a tool says not found)', async () => {
    const r = await enterCall(login(), ref('write'), async () => {
      throw Object.assign(new Error('not allowed to change this item'), {
        code: '42501',
        detail: 'no_read',
      });
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.http?.status).toBe(404);
      expect(r.refusal.toolText).toBe('not found');
    }
  });

  it('any other error goes to the surface own error path', async () => {
    await expect(
      enterCall(login(), ref('write'), async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});

describe('the order of the steps', () => {
  // The Admin step reads the bound copy (step 2), so it shows by what it
  // stops: after the narrowers, before the create home and the run.
  const run = async (holdsAdmin: boolean) => {
    h.log = [];
    const r = await enterCall(
      async () => {
        h.log.push('resolve');
        return login({ scope: SCOPE, admin: { holdsAdmin, areas: new Set<string>() } });
      },
      { kind: 'ordered', name: 'adminKind' },
      ok,
    );
    return r;
  };

  it('resolve, policy, scope, narrow, Admin, home, run', async () => {
    setup({
      key: () => {
        h.log.push('narrow');
        return null;
      },
    });
    registerPolicySource('ordered', (r: PolicyRef) => {
      h.log.push('policy');
      return POLICIES[r.name] ?? null;
    });
    expect((await run(true)).ok).toBe(true);
    expect(h.log).toEqual(['resolve', 'policy', 'scope:writes', 'narrow', 'home', 'run']);
    const refused = await run(false);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.kind).toBe('admin-kind');
    expect(h.log).toEqual(['resolve', 'policy', 'scope:writes', 'narrow']);
  });
});

describe('listing equals calling', () => {
  it('for every caller and policy, the call runs exactly when the listing shows it', async () => {
    setup({
      key: (c, _p, r) => (c.via === 'key' && r.name === 'keys' ? 'not in this key area' : null),
      spending: (c, p) =>
        p.spends === 'ownerKey' && c.admin && !c.admin.holdsAdmin ? 'spends the owner keys' : null,
    });
    registerPolicySource('spend', () => ({ effect: 'read', scope: 'any', spends: 'ownerKey' }));
    const callers: GateCaller[] = [
      login(),
      login({ write: false }),
      login({ via: 'key' }),
      login({ admin: { holdsAdmin: true, areas: new Set(['keys']) } }),
      login({ admin: { holdsAdmin: true, areas: new Set() } }),
      login({ admin: null }),
      login({ admin: undefined }),
      { actor: systemActor('worker:runs'), via: 'process', admin: null },
    ];
    const refs: PolicyRef[] = [
      ...Object.keys(POLICIES).map(ref),
      ref('missing'),
      { kind: 'spend', name: 'web_crawl' },
      { kind: 'job', name: 'worker:extract' },
    ];
    let cells = 0;
    for (const caller of callers) {
      for (const r of refs) {
        const listed = gateCheck(caller, r);
        const called = await enterCall(caller, r, ok);
        expect(called.ok, `${caller.via} ${r.name}`).toBe(listed === null);
        if (!called.ok) expect(called.refusal.toolText).toBe(listed?.message);
        cells += 1;
      }
    }
    expect(cells).toBe(callers.length * refs.length);
  });
});

describe('fail closed: every narrower registered (fix round 1, M1)', () => {
  it('a missing narrower stops listing and calling, before any step', async () => {
    resetGateRegistry();
    registerPolicySource('test', TEST_SOURCE);
    for (const n of ['key', 'peer', 'spending', 'turn-caps'] as const) registerNarrower(n, NOOP);
    expect(() => gateCheck(login(), ref('read'))).toThrow(GateNotReadyError);
    expect(() => gateCheck(login(), ref('read'))).toThrow(/member-app/);
    const resolve = vi.fn(async () => login());
    await expect(enterCall(resolve, ref('read'), ok)).rejects.toThrow(GateNotReadyError);
    expect(resolve).not.toHaveBeenCalled();
    expect(h.log).toEqual([]);
    registerNarrower('member-app', NOOP);
    expect(gateCheck(login(), ref('read'))).toBeNull();
  });
});

describe('registration (fix round 1, L3)', () => {
  it('the same function again is a no-op; another under a taken name is refused', () => {
    expect(() => registerPolicySource('test', TEST_SOURCE)).not.toThrow();
    expect(() => registerPolicySource('test', () => null)).toThrow(/has a source already/);
    expect(() => registerNarrower('key', NOOP)).not.toThrow();
    expect(() => registerNarrower('key', () => null)).toThrow(/has a narrower already/);
    expect(() => registerPolicySource('job', () => null)).toThrow();
  });
});

describe('a read runs read only, the policy own actor too (fix round 1, L5)', () => {
  it('a read policy that names an actor runs it read only', async () => {
    const READ_AS = () =>
      ({ effect: 'read', scope: 'any', actor: systemActor('http:public-read') }) as GatePolicy;
    registerPolicySource('pubread', READ_AS);
    let seen: Actor | null = null;
    await enterCall(login(), { kind: 'pubread', name: 'x' }, async () => {
      seen = currentActor();
    });
    expect(seen).toEqual({ kind: 'system', reason: 'http:public-read', mode: 'ro' });
  });
});

describe('the bound caller (fix round 1, L6)', () => {
  it('is frozen, and a detached promise keeps it', async () => {
    let inside: GateCaller | null = null;
    let detached: Promise<GateCaller | null> = Promise.resolve(null);
    await enterCall(login(), ref('read'), async () => {
      inside = currentCaller();
      detached = new Promise((resolve) => setTimeout(() => resolve(currentCaller()), 5));
    });
    expect(Object.isFrozen(inside)).toBe(true);
    expect(await detached).toBe(inside);
    expect(currentCaller()).toBeNull();
  });
});

describe('the bound caller is a copy (fix round 2, L-c)', () => {
  it("never freezes the surface's object, and its later changes do not reach the call", async () => {
    const areas = new Set(['keys']);
    const keyAreas = ['notes'];
    const caller = login({
      admin: { holdsAdmin: true, areas },
      scope: { ...SCOPE, ws: [W1] },
      facts: { keyAreas },
    });
    let inside: GateCaller | null = null;
    await enterCall(caller, ref('read'), async () => {
      inside = currentCaller();
      // The surface changes its own object while the call runs.
      areas.add('settings');
      keyAreas.push('files');
    });
    expect(Object.isFrozen(caller)).toBe(false);
    expect(Object.isFrozen(areas)).toBe(false);
    expect(Object.isFrozen(keyAreas)).toBe(false);
    const bound = inside as unknown as GateCaller;
    expect([...(bound.admin?.areas ?? [])]).toEqual(['keys']);
    expect(bound.facts?.keyAreas).toEqual(['notes']);
    expect(Object.isFrozen(bound.admin)).toBe(true);
    expect(Object.isFrozen(bound.scope)).toBe(true);
    expect(Object.isFrozen(bound.scope?.ws)).toBe(true);
    expect(Object.isFrozen(bound.facts)).toBe(true);
    expect(Object.isFrozen(bound.facts?.keyAreas)).toBe(true);
    // The Admin areas refuse every change: a read-only view, no Set.
    const bAreas = bound.admin?.areas as Set<string>;
    expect(() => bAreas.add('x')).toThrow(TypeError);
    expect(() => bAreas.delete('keys')).toThrow(TypeError);
    expect(() => bAreas.clear()).toThrow(TypeError);
    expect(bAreas.has('keys')).toBe(true);
  });
});

describe("the bound caller's Sets are read-only views (A3c audit LOW-3)", () => {
  it("Set.prototype's own add, delete and clear cannot reach them", async () => {
    const caller = login({
      admin: { holdsAdmin: true, areas: new Set(['keys']) },
      facts: { tags: new Set(['a']) },
    });
    let inside: GateCaller | null = null;
    await enterCall(caller, ref('read'), async () => {
      inside = currentCaller();
    });
    const bound = inside as unknown as GateCaller;
    const views = [bound.admin!.areas, bound.facts!.tags as ReadonlySet<string>];
    for (const view of views) {
      expect(view).not.toBeInstanceOf(Set);
      expect(() => Set.prototype.add.call(view as Set<string>, 'x')).toThrow(TypeError);
      expect(() => Set.prototype.delete.call(view as Set<string>, 'keys')).toThrow(TypeError);
      expect(() => Set.prototype.clear.call(view as Set<string>)).toThrow(TypeError);
      expect(Object.isFrozen(view)).toBe(true);
    }
    // Still read like a Set, and nothing changed.
    expect([...bound.admin!.areas]).toEqual(['keys']);
    expect(bound.admin!.areas.has('keys')).toBe(true);
    expect(bound.admin!.areas.size).toBe(1);
    const seen: string[] = [];
    bound.admin!.areas.forEach((v) => seen.push(v));
    expect(seen).toEqual(['keys']);
    expect([...(bound.facts!.tags as ReadonlySet<string>)]).toEqual(['a']);
    // The ES2025 Set methods make a new Set; the view keeps its own.
    const algebra = bound.admin!.areas as unknown as { union(o: Set<string>): Set<string> };
    const both = algebra.union(new Set(['x']));
    both.add('y');
    expect([...both]).toEqual(['keys', 'x', 'y']);
    expect([...bound.admin!.areas]).toEqual(['keys']);
    // A nested call re-binds the bound caller: the view is copied again.
    let nested: GateCaller | null = null;
    await enterCall(bound, ref('read'), async () => {
      nested = currentCaller();
    });
    expect([...(nested as unknown as GateCaller).admin!.areas]).toEqual(['keys']);
  });
});

describe('a scope no call can run in (fix round 1, L7)', () => {
  it('lists nothing and calls nothing, with the same refusal; the scope is never entered', async () => {
    const empty = login({ scope: { ...SCOPE, ws: [], modWs: [] } });
    const junk = login({ scope: { ...SCOPE, ws: ['w1'], modWs: [] } });
    for (const c of [empty, junk]) {
      for (const p of ['read', 'write']) {
        const listed = gateCheck(c, ref(p));
        expect(listed?.kind, p).toBe('no-scope');
        const called = await enterCall(c, ref(p), ok);
        expect(called.ok).toBe(false);
        if (!called.ok) expect(called.refusal.toolText).toBe(listed?.message);
      }
    }
    expect(gateCheck(empty, ref('read'))?.message).toMatch(/user of no workspace/);
    expect(withTurnScope).not.toHaveBeenCalled();
    expect(h.log).not.toContain('run');
    // A surface that enters its own scope answers for it.
    const own = login({ scope: { ...SCOPE, ws: [] }, enterScope: (_w, fn) => fn() });
    expect(gateCheck(own, ref('read'))).toBeNull();
  });
});

describe('step 6 rules (fix round 1, M2)', () => {
  const TURN_WS = '22222222-2222-4222-8222-222222222222';

  it('an entry that asks on every call asks for reads and writes alike', async () => {
    const memo = {};
    const turn = login({
      via: 'turn',
      createHome: {
        ownWork: 'auto',
        askEvery: { from: 'assistant', ws: TURN_WS },
        reads: true,
        soft: true,
        memo,
      },
    });
    vi.mocked(createHomeIntent).mockResolvedValueOnce({ createWs: null, privateWs: null });
    await enterCall(turn, ref('read'), ok);
    expect(createHomeIntent).toHaveBeenLastCalledWith(
      LOGIN,
      { from: 'assistant', ws: TURN_WS },
      { ownWork: 'auto', makePrivate: false },
    );
    // Kept for a read; a write asks again, making the private workspace.
    await enterCall(turn, ref('read'), ok);
    expect(createHomeIntent).toHaveBeenCalledTimes(1);
    await enterCall(turn, ref('write'), ok);
    expect(createHomeIntent).toHaveBeenLastCalledWith(
      LOGIN,
      { from: 'assistant', ws: TURN_WS },
      { ownWork: 'auto', makePrivate: true },
    );
    // Final now: kept for every later call.
    await enterCall(turn, ref('create'), ok);
    expect(createHomeIntent).toHaveBeenCalledTimes(2);
  });

  it('soft: a refusal or an error names no home and the call runs', async () => {
    const turn = login({ createHome: { ownWork: 'auto', soft: true } });
    vi.mocked(createHomeIntent).mockResolvedValueOnce({ refused: 'not-member', message: 'no' });
    let home: unknown = 'unset';
    const r1 = await enterCall(turn, ref('create'), async () => {
      home = currentCreateHome();
    });
    expect(r1.ok).toBe(true);
    expect(home).toBeNull();
    vi.mocked(createHomeIntent).mockRejectedValueOnce(new Error('db down'));
    expect((await enterCall(turn, ref('create'), ok)).ok).toBe(true);
  });

  it('a hard entry refuses; its ownWork reaches the fallback', async () => {
    const http = login({ createHome: { ownWork: false } });
    vi.mocked(createHomeIntent).mockRejectedValueOnce(new Error('db down'));
    await expect(enterCall(http, ref('create'), ok)).rejects.toThrow('db down');
    await enterCall(http, ref('remove'), ok);
    expect(createHomeIntent).toHaveBeenLastCalledWith(LOGIN, null, {
      ownWork: false,
      makePrivate: false,
    });
  });

  it('only the login own actor names a home; never over one named around it', async () => {
    const assistantActor = login({ actor: { kind: 'assistant', agentId: null } });
    const otherLogin = login({ actor: loginActor('66666666-6666-4666-8666-666666666666') });
    await enterCall(assistantActor, ref('create'), ok);
    await enterCall(otherLogin, ref('create'), ok);
    await enterCall(login({ loginId: null }), ref('create'), ok);
    expect(createHomeIntent).not.toHaveBeenCalled();
    const { withCreateHome } = await import('./viewer');
    let home: unknown = null;
    await withCreateHome({ createWs: W1, privateWs: null }, () =>
      enterCall(login(), ref('create'), async () => {
        home = currentCreateHome();
      }),
    );
    expect(createHomeIntent).not.toHaveBeenCalled();
    expect(home).toEqual({ createWs: W1, privateWs: null });
  });
});
