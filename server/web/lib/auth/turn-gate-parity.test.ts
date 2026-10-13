/**
 * The assistant turn's tool path against the one gate (arch A3c fix round
 * 1): what dispatch asks for a turn's tool call today (adminToolGate, then
 * toolItemWriteRefusal, then turnCreateHome) next to what the gate decides
 * for the same call (gateCheck's Admin step with the tool's policy, and
 * step 6 with the turn's create-home rule). The contract A5 moves dispatch
 * onto; drift fails here.
 *
 *  - The Admin step equals adminToolGate for every built-in and every
 *    scope, refusal words included, but for the creates of a kind of the
 *    Admin workspace only: the gate refuses those outside Admin
 *    (ADMIN_KIND_CREATE_ERROR), where the turn path leaves them to the
 *    database, which refuses the same row ("this kind of item lives in the
 *    Admin workspace only"). The same answer, earlier.
 *  - toolItemWriteRefusal has no gate step in A3c: the item pre-checks stay
 *    in dispatch until the edit check is on (plan 8). Every tool it checks
 *    has a gate policy, so A5 can hang the check on it.
 *  - Step 6 with the turn's rule (askEvery its workspace, reads, soft,
 *    memo per turn scope) equals turnCreateHome, call by call.
 *
 * No database: the scope, the Admin view and the create-home intent are
 * stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const P = '77777777-7777-4777-8777-777777777777';

const h = vi.hoisted(() => ({
  scope: null as null | Record<string, unknown>,
  view: { holdsAdmin: false, areas: new Set<string>() },
  calls: [] as unknown[][],
  privateWs: null as string | null,
  member: [] as string[],
  moderated: [] as string[],
  next: null as null | 'error' | 'refused',
}));

vi.mock('../../../../packages/db/src/viewer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../packages/db/src/viewer')>()),
  currentWorkspaceScope: () => h.scope,
}));
vi.mock('../../../../packages/db/src/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../packages/db/src/client')>()),
  scopeHoldsAdmin: async () => h.view.holdsAdmin,
  scopeHasArea: async (a: string) => h.view.holdsAdmin && h.view.areas.has(a),
}));
vi.mock('../../../../packages/db/src/create-home', () => ({
  /** A model of the intent: the asked workspace when moderated, the
   *  private one made when asked to. */
  createHomeIntent: vi.fn(async (...args: unknown[]) => {
    h.calls.push(args);
    const next = h.next;
    h.next = null;
    if (next === 'error') throw new Error('db down');
    if (next === 'refused') return { refused: 'not-member', message: 'no' };
    const [, ask, fb] = args as [
      string,
      { ws: string | null } | null,
      { ownWork: unknown; makePrivate: boolean } | { privateWs: string | null },
    ];
    const ws = ask?.ws ?? null;
    if (ws && !h.member.includes(ws)) return { refused: 'not-member', message: 'not in it' };
    const createWs = ws && h.moderated.includes(ws) ? ws : null;
    if ('privateWs' in fb) return { createWs, privateWs: fb.privateWs };
    if (fb.ownWork === false) return { createWs, privateWs: null };
    if (fb.makePrivate && !h.privateWs) h.privateWs = P;
    return { createWs, privateWs: h.privateWs };
  }),
}));

import {
  gateCheck,
  loginActor,
  withCreateHome,
  type GateCaller,
  type WorkspaceScope,
} from '@mantle/db';
import { BUILTIN_TOOLS, ITEM_WRITE_TARGETS, adminToolGate } from '@mantle/tools';
import { createHomeStep } from '../../../../packages/db/src/gate';
import { turnCreateHome } from '../../../../packages/tools/src/turn-create-home';
import { ADMIN_KIND_CREATE_TOOL_SLUGS } from '@mantle/mcp-core';

const LOGIN = '55555555-5555-4555-8555-555555555555';
const W1 = '11111111-1111-4111-8111-111111111111';
const W2 = '22222222-2222-4222-8222-222222222222';
const AREAS = ['settings', 'users', 'assistants', 'connectors', 'keys'];

/** The gate's caller for a turn scope (what A5 builds at dispatch). */
function turnCaller(scope: WorkspaceScope, admin: GateCaller['admin'] = null): GateCaller {
  const answers = scope.kind === 'assistant' && scope.loginId ? scope.loginId : null;
  return {
    actor: loginActor(scope.loginId ?? LOGIN),
    via: 'turn',
    loginId: answers,
    admin,
    createHome: {
      ownWork: 'auto',
      askEvery: { from: 'assistant', ws: scope.ws.length === 1 ? scope.ws[0]! : null },
      reads: true,
      soft: true,
      memo: scope,
    },
  };
}

beforeEach(() => {
  h.scope = null;
  h.calls = [];
  h.privateWs = null;
  h.next = null;
});

describe('the Admin step equals adminToolGate on the turn path', () => {
  const views = [
    { holdsAdmin: false, areas: new Set<string>() },
    { holdsAdmin: true, areas: new Set<string>(AREAS) },
    { holdsAdmin: true, areas: new Set<string>(['settings']) },
    { holdsAdmin: true, areas: new Set<string>() },
  ];

  it('for every built-in and every scope; only the Admin-only kinds differ, refused earlier', async () => {
    const scope: WorkspaceScope = { kind: 'assistant', loginId: LOGIN, ws: [W1], modWs: [W1] };
    const differ = new Set<string>();
    for (const view of views) {
      h.view = view;
      h.scope = scope;
      const caller = turnCaller(scope, view);
      for (const def of BUILTIN_TOOLS) {
        const today = await adminToolGate(def.slug, { ref: def.slug, ownerOnly: def.ownerOnly });
        const gate = gateCheck(caller, { kind: 'mcp-tool', name: def.slug });
        const todayRefusal = 'refused' in today ? today.refused : null;
        if (todayRefusal === (gate?.message ?? null)) continue;
        differ.add(def.slug);
        expect(ADMIN_KIND_CREATE_TOOL_SLUGS.has(def.slug), def.slug).toBe(true);
        expect(view.holdsAdmin, def.slug).toBe(false);
        expect(todayRefusal, def.slug).toBeNull();
        expect(gate?.kind, def.slug).toBe('admin-kind');
      }
    }
    expect([...differ].sort()).toEqual([...ADMIN_KIND_CREATE_TOOL_SLUGS].sort());
  });

  it('every tool the item pre-check reads has a gate policy (A5 hangs the check on it)', () => {
    const caller = turnCaller({ kind: 'assistant', loginId: LOGIN, ws: [W1], modWs: [W1] }, null);
    for (const slug of ITEM_WRITE_TARGETS.keys()) {
      expect(gateCheck(caller, { kind: 'mcp-tool', name: slug })?.kind, slug).not.toBe(
        'unclassified',
      );
    }
  });
});

type Step = 'read' | 'write';
type Scenario = {
  name: string;
  scope: WorkspaceScope;
  steps: (Step | [Step, 'error' | 'refused'])[];
  member?: string[];
  moderated?: string[];
  privateWs?: string | null;
  outer?: boolean;
};

const assistant = (ws: string[], loginId: string | null = LOGIN): WorkspaceScope => ({
  kind: 'assistant',
  loginId,
  ws,
  modWs: [],
});

const SCENARIOS: Scenario[] = [
  {
    name: 'moderated workspace',
    scope: assistant([W1]),
    steps: ['read', 'read', 'write', 'read', 'write'],
    member: [W1],
    moderated: [W1],
  },
  {
    name: 'read-only workspace',
    scope: assistant([W1]),
    steps: ['read', 'write', 'read'],
    member: [W1],
  },
  { name: 'several workspaces', scope: assistant([W1, W2]), steps: ['write', 'read', 'write'] },
  {
    name: 'a private workspace already',
    scope: assistant([W1]),
    steps: ['read', 'write'],
    member: [W1],
    privateWs: P,
  },
  { name: 'no user', scope: assistant([W1], null), steps: ['read', 'write'] },
  {
    name: 'not an assistant turn',
    scope: { kind: 'user', loginId: LOGIN, ws: [W1], modWs: [W1] },
    steps: ['write', 'read'],
  },
  {
    name: 'a database error is not kept',
    scope: assistant([W1]),
    steps: [['read', 'error'], 'read', ['write', 'error'], 'write'],
    member: [W1],
  },
  {
    name: 'a refusal names no home',
    scope: assistant([W1]),
    steps: [['write', 'refused'], 'write'],
    member: [W1],
  },
  {
    name: 'a home named around',
    scope: assistant([W1]),
    steps: ['write', 'read'],
    member: [W1],
    outer: true,
  },
];

/** Run a scenario's calls, today's way or the gate's, from a fresh state. */
async function run(sc: Scenario, way: 'today' | 'gate'): Promise<unknown[]> {
  h.calls = [];
  h.privateWs = sc.privateWs ?? null;
  h.member = sc.member ?? [];
  h.moderated = sc.moderated ?? [];
  const scope = { ...sc.scope };
  h.scope = scope;
  const results: unknown[] = [];
  for (const s of sc.steps) {
    const [step, inject] = Array.isArray(s) ? s : [s, null];
    h.next = inject;
    const creates = step === 'write';
    const call = () =>
      way === 'today'
        ? turnCreateHome(creates)
        : createHomeStep(
            turnCaller(scope),
            { effect: creates ? 'write' : 'read', scope: 'any' },
            null,
          );
    results.push(
      sc.outer ? await withCreateHome({ createWs: W2, privateWs: null }, call) : await call(),
    );
  }
  return [results, h.calls];
}

describe('step 6 with the turn rule equals turnCreateHome', () => {
  for (const sc of SCENARIOS) {
    it(sc.name, async () => {
      const today = await run(sc, 'today');
      const gate = await run(sc, 'gate');
      expect(gate).toEqual(today);
      // Not vacuous: where the turn names a home, both name the same one.
      if (sc.name === 'moderated workspace') expect(JSON.stringify(today)).toContain(W1);
      if (sc.name === 'read-only workspace') expect(JSON.stringify(today)).toContain(P);
    });
  }
});
