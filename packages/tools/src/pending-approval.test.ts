/**
 * The approval rule of an elevated pending call (A5 step 6d fix round 1,
 * pending-approval.ts), through the real gate: its asker is refused on
 * every path, the owner runs it with the owner's rights, any other login
 * only when its own scope passes the connector rule in the workspace the
 * call was asked in. The rule reads the scope its approval names, never the
 * one the approving surface runs in (a Telegram tap runs in none). The
 * connector's resource rows and the approver's own scope are stubbed (no
 * database); the paths themselves on a real database:
 * server/web/server/a5-elevated-approval.db.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  scope: null as null | Record<string, unknown>,
  /** The connector's resource row in the Team workspace: held, Write on. */
  connector: { held: true, write: true },
  /** The Moderator workspaces of each login's own scope. */
  modWs: {} as Record<string, string[]>,
  /** The workspaces of each login's own scope (default: its modWs). */
  ws: {} as Record<string, string[]>,
  /** The live workspaces a loginless re-check still reads. */
  live: [] as string[],
  /** The workspaces the asking assistant still runs in (fix round 1). */
  assistantWs: [] as string[],
}));

vi.mock('../../db/src/viewer', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/src/viewer')>();
  return {
    ...real,
    currentWorkspaceScope: () => h.scope ?? real.currentWorkspaceScope(),
    scopeLeftForSystem: () => null,
  };
});
vi.mock('../../db/src/gateway/scope-answers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/src/gateway/scope-answers')>()),
  scopeHoldsAdmin: async () => false,
  scopeHasArea: async () => false,
  loginActorNow: async (login: string) => ({ kind: 'login', mode: 'rw', loginId: login }),
}));
vi.mock('../../db/src/gateway/viewer-scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/src/gateway/viewer-scope')>()),
  loginScopeFor: async (login: string) => ({
    kind: 'user',
    loginId: login,
    ws: h.ws[login] ?? h.modWs[login] ?? [],
    modWs: h.modWs[login] ?? [],
  }),
}));
vi.mock('../../db/src/pending-elevated', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/src/pending-elevated')>()),
  liveWorkspaceIds: async (_owner: string, ids: readonly string[]) =>
    ids.filter((w) => h.live.includes(w)),
  assistantWorkspaceIds: async (_owner: string, _agent: string, ids: readonly string[]) =>
    ids.filter((w) => h.assistantWs.includes(w)),
}));
vi.mock('./external-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./external-access')>()),
  connectorGroupOf: async (_owner: string, row: { handler: { group?: string } }) => ({
    id: 'g',
    slug: row.handler.group,
    usable: true,
  }),
  connectorResources: async (_owner: string, _group: string, ws: readonly string[]) =>
    h.connector.held
      ? ws
          .filter((w) => w === TEAM_WS)
          .map((workspaceId) => ({ workspaceId, write: h.connector.write }))
      : [],
}));

import { loginActor, runAsActor, type PendingOrigin, type Tool } from '@mantle/db';
import { CONNECTOR_WRITE_ERROR } from './connector-scope';
import { PENDING_RECHECK_ERROR, PENDING_SCOPE_LOST_ERROR } from './pending-origin';
import { ensureGateReady } from './index';
import { CONNECTOR_NOT_HELD_ERROR } from './connector-scope';
import { gateCallerFor } from './gate-callers';
import {
  ApprovalRefusedError,
  deciderOf,
  elevatedApproval,
  ELEVATED_APPROVER_ERROR,
  ELEVATED_NO_APPROVER_ERROR,
  ELEVATED_NO_ASKER_ERROR,
  ELEVATED_NO_TOOL_ERROR,
  ELEVATED_SELF_APPROVAL_ERROR,
  elevatedRejection,
  originApproval,
  PENDING_LINK_OWNER_ERROR,
} from './pending-approval';
import { runtimeToolPolicy } from './runtime-policy';

const OWNER = '99999999-9999-4999-8999-999999999999';
const ASKER = '55555555-5555-4555-8555-555555555555';
const MOD = '66666666-6666-4666-8666-666666666666';
const OTHER = '77777777-7777-4777-8777-777777777777';
const TEAM_WS = '22222222-2222-4222-8222-222222222222';
const ELSEWHERE_WS = '33333333-3333-4333-8333-333333333333';
const AGENT = '44444444-4444-4444-8444-444444444444';

const update = {
  slug: 'crm_update',
  ownerId: OWNER,
  handler: { kind: 'mcp', group: 'crm', toolName: 'update' },
  requiresConfirm: true,
  externalAccess: null,
  description: 'crm_update',
  inputSchema: { type: 'object', properties: {} },
} as unknown as Tool;

const row = { loginId: ASKER, workspaceId: TEAM_WS };
const context = { ownerId: OWNER, surface: { kind: 'owner', via: 'pending' } };

/** The approval of `decider`, in the surface scope `scope` (null: none, a
 *  Telegram tap's), as the refusal it throws or the run it gives. */
async function approve(
  decider: string | null,
  scope: Record<string, unknown> | null = null,
  asked: { loginId: string | null; workspaceId: string } = row,
  tool: Tool | null = update,
) {
  ensureGateReady();
  h.scope = scope;
  try {
    return await runAsActor(loginActor(decider ?? OWNER), () =>
      elevatedApproval(OWNER, asked, tool, decider, context),
    );
  } catch (err) {
    if (err instanceof ApprovalRefusedError) return { refused: err.message };
    throw err;
  } finally {
    h.scope = null;
  }
}

function reset() {
  h.connector = { held: true, write: true };
  h.modWs = { [MOD]: [TEAM_WS], [ASKER]: [], [OTHER]: [ELSEWHERE_WS] };
  h.ws = {};
  h.live = [];
  h.assistantWs = [];
}

describe('who decides (deciderOf)', () => {
  it('the scope the decision runs in, else the login the path names, else the owner', () => {
    h.scope = null;
    expect(deciderOf(OWNER, MOD)).toBe(MOD);
    expect(deciderOf(OWNER)).toBe(OWNER);
    h.scope = { kind: 'assistant', loginId: OTHER, ws: [], modWs: [] };
    expect(deciderOf(OWNER, MOD)).toBe(OTHER);
    h.scope = { kind: 'assistant', loginId: null, ws: [], modWs: [] };
    expect(deciderOf(OWNER, MOD)).toBeNull();
    h.scope = null;
  });
});

describe('an elevated call: the approval rule (A5 step 6d fix round 1)', () => {
  it('its asker is refused, on any surface scope', async () => {
    reset();
    expect(await approve(ASKER)).toEqual({ refused: ELEVATED_SELF_APPROVAL_ERROR });
    expect(
      await approve(ASKER, { kind: 'assistant', loginId: ASKER, ws: [TEAM_WS], modWs: [] }),
    ).toEqual({ refused: ELEVATED_SELF_APPROVAL_ERROR });
  });

  it('even an asker who has since become a Moderator there', async () => {
    reset();
    h.modWs[ASKER] = [TEAM_WS];
    expect(await approve(ASKER)).toEqual({ refused: ELEVATED_SELF_APPROVAL_ERROR });
  });

  it("the owner runs it with the owner's rights, the connector's Write off and all", async () => {
    reset();
    h.connector = { held: true, write: false };
    const run = await approve(OWNER);
    expect(run).toMatchObject({ runAs: OWNER, owner: true });
    expect((run as { caller: { approval: unknown } }).caller.approval).toMatchObject({
      approver: OWNER,
      lifted: true,
    });
  });

  it('the rest of the rule stands for the owner: a connector the workspace does not hold', async () => {
    reset();
    h.connector = { held: false, write: true };
    expect(await approve(OWNER)).toEqual({ refused: CONNECTOR_NOT_HELD_ERROR });
  });

  it("a Moderator of the call's workspace, its Write on, runs it with its own rights", async () => {
    reset();
    expect(await approve(MOD)).toMatchObject({ runAs: MOD, owner: false });
  });

  it('a login without write rights there is refused: no Moderator, or the Write off', async () => {
    reset();
    expect(await approve(OTHER)).toEqual({ refused: ELEVATED_APPROVER_ERROR });
    h.connector = { held: true, write: false };
    expect(await approve(MOD)).toEqual({ refused: ELEVATED_APPROVER_ERROR });
  });

  it('a scope that names no login is refused', async () => {
    reset();
    expect(await approve(null)).toEqual({ refused: ELEVATED_NO_APPROVER_ERROR });
  });

  it("the rule reads the call's workspace, not the surface's scope (a Telegram tap: none; MCP: the approver's own)", async () => {
    reset();
    // The approver moderates a workspace that holds the connector, but not
    // the one that asked: refused whatever scope the surface runs in.
    h.modWs[OTHER] = [ELSEWHERE_WS];
    for (const scope of [
      null,
      { kind: 'assistant', loginId: OTHER, ws: [TEAM_WS, ELSEWHERE_WS], modWs: [ELSEWHERE_WS] },
    ]) {
      expect(await approve(OTHER, scope)).toEqual({ refused: ELEVATED_APPROVER_ERROR });
    }
    // And the caller dispatch runs the approved call as carries the same
    // facts: the gate refuses the call itself for a login that may not.
    h.connector = { held: true, write: false };
    const ownerRun = (await approve(OWNER)) as { caller: Parameters<typeof gateCallerFor>[0] };
    h.scope = null;
    const gate = await gateCallerFor(ownerRun.caller, runtimeToolPolicy(update), false, {
      ownerSurface: true,
      ownerId: OWNER,
      row: update,
    });
    expect(gate.facts?.connector).toMatchObject({
      held: [{ workspaceId: TEAM_WS, write: true }],
      modWs: [TEAM_WS],
    });
  });
});

describe("6d's lows, closed in A5 step 6c", () => {
  it('L4: the owner is asked first, so the owner may approve even a call it asked itself', async () => {
    reset();
    h.connector = { held: true, write: false };
    expect(await approve(OWNER, null, { loginId: OWNER, workspaceId: TEAM_WS })).toMatchObject({
      runAs: OWNER,
      owner: true,
    });
    // Anyone else who asked is still refused.
    expect(await approve(MOD, null, { loginId: MOD, workspaceId: TEAM_WS })).toEqual({
      refused: ELEVATED_SELF_APPROVAL_ERROR,
    });
  });

  it('L2: a row that names no asker is the owner’s alone', async () => {
    reset();
    const noAsker = { loginId: null, workspaceId: TEAM_WS };
    expect(await approve(MOD, null, noAsker)).toEqual({ refused: ELEVATED_NO_ASKER_ERROR });
    expect(await approve(OWNER, null, noAsker)).toMatchObject({ runAs: OWNER, owner: true });
  });

  it('L1: a tool gone or with no policy is the owner’s alone (no gate step judges it)', async () => {
    reset();
    expect(await approve(MOD, null, row, null)).toEqual({ refused: ELEVATED_NO_TOOL_ERROR });
    const noPolicy = { ...update, handler: { kind: 'nothing-known' } } as unknown as Tool;
    expect(await approve(MOD, null, row, noPolicy)).toEqual({ refused: ELEVATED_NO_TOOL_ERROR });
    // The owner decides it: the approval then records the tool is gone.
    expect(await approve(OWNER, null, row, null)).toMatchObject({ runAs: OWNER, owner: true });
  });

  it('L3: whoever may approve it may reject it; nobody else', async () => {
    reset();
    ensureGateReady();
    const rejects = (login: string | null) =>
      runAsActor(loginActor(login ?? OWNER), () =>
        elevatedRejection(OWNER, row, update, login, context),
      );
    expect(await rejects(OWNER)).toBe(true);
    expect(await rejects(MOD)).toBe(true);
    expect(await rejects(OTHER)).toBe(false);
    expect(await rejects(ASKER)).toBe(false); // its asker withdraws by deciderFilter
    // The owner may reject even what it could not run (a connector not held).
    h.connector = { held: false, write: true };
    expect(await rejects(OWNER)).toBe(true);
    expect(await rejects(MOD)).toBe(false);
  });
});

describe('the approval re-check (A5 step 6c): the queue-time check again, where it was asked', () => {
  /** A connector write ASKER queued in a Team turn, a Moderator there. */
  const origin = (extra: Partial<PendingOrigin> = {}): PendingOrigin => ({
    v: 1,
    scope: { kind: 'assistant', loginId: ASKER, ws: [TEAM_WS], modWs: [TEAM_WS] },
    enter: 'turn',
    writes: false,
    admin: { holds: false, areas: [] },
    surface: { kind: 'team', loginId: ASKER },
    ...extra,
  });
  const recheck = async (
    o: PendingOrigin | null,
    approver: string | null = OWNER,
    agentId: string | null = null,
  ) => {
    ensureGateReady();
    try {
      return await runAsActor(loginActor(approver ?? OWNER), () =>
        originApproval(
          OWNER,
          { loginId: o?.scope?.loginId ?? null, origin: o, args: { id: 'c-1' }, agentId },
          update,
          approver,
        ),
      );
    } catch (err) {
      if (err instanceof ApprovalRefusedError) return { refused: err.message };
      throw err;
    }
  };
  const asker = (ws: string[], modWs: string[]) => {
    h.ws[ASKER] = ws;
    h.modWs[ASKER] = modWs;
  };

  it('a row with no stamp is not re-checked (the legacy rule)', async () => {
    reset();
    expect(await recheck(null)).toBeNull();
  });

  it('nothing changed: it passes, and runs in the scope it was asked in as its asker', async () => {
    reset();
    asker([TEAM_WS], [TEAM_WS]);
    const run = await recheck(origin());
    expect(run).toMatchObject({
      run: {
        scope: { kind: 'assistant', loginId: ASKER, ws: [TEAM_WS], modWs: [TEAM_WS] },
        narrowed: [],
      },
      caller: { entry: 'pending', approval: { approver: OWNER, narrowed: [] } },
      actor: { kind: 'login', loginId: ASKER },
    });
  });

  it('a lost Moderator seat: refused in the gate’s words, whoever approves', async () => {
    reset();
    asker([TEAM_WS], []);
    for (const approver of [OWNER, ASKER, MOD]) {
      expect(await recheck(origin(), approver)).toEqual({
        refused: `${PENDING_RECHECK_ERROR}${CONNECTOR_WRITE_ERROR}`,
      });
    }
  });

  it('a lost workspace: refused, the scope is gone', async () => {
    reset();
    asker([ELSEWHERE_WS], [ELSEWHERE_WS]);
    expect(await recheck(origin())).toEqual({ refused: PENDING_SCOPE_LOST_ERROR });
  });

  it('gained rights are not the call’s: the scope stays the one it asked in', async () => {
    reset();
    asker([TEAM_WS, ELSEWHERE_WS], [TEAM_WS, ELSEWHERE_WS]);
    const run = await recheck(origin());
    expect(run).toMatchObject({ run: { scope: { ws: [TEAM_WS], modWs: [TEAM_WS] } } });
  });

  it('a call asked without a Moderator seat stays without one, though its asker gained it', async () => {
    reset();
    asker([TEAM_WS], [TEAM_WS]);
    const plain = origin({
      scope: { kind: 'assistant', loginId: ASKER, ws: [TEAM_WS], modWs: [] },
    });
    expect(await recheck(plain)).toEqual({
      refused: `${PENDING_RECHECK_ERROR}${CONNECTOR_WRITE_ERROR}`,
    });
  });

  it('a turn that answered no login: its workspace while it is live, never a Moderator seat', async () => {
    reset();
    // A turn that answered no login ran on a surface that names none (a
    // workspace assistant's heartbeat): one naming a login other than the
    // owner refuses (lows round, 6c L2; pending-origin.test.ts).
    const loginless = origin({
      scope: { kind: 'assistant', loginId: null, ws: [TEAM_WS], modWs: [] },
      surface: { kind: 'owner', via: 'heartbeat' },
    });
    expect(await recheck(loginless)).toEqual({ refused: PENDING_SCOPE_LOST_ERROR });
    h.live = [TEAM_WS];
    expect(await recheck(loginless)).toEqual({
      refused: `${PENDING_RECHECK_ERROR}${CONNECTOR_WRITE_ERROR}`,
    });
  });

  it('a turn that answered no login keeps the Moderator seat its stamp named while its assistant still runs there (fix round 1, L6)', async () => {
    reset();
    const seated = origin({
      scope: { kind: 'assistant', loginId: null, ws: [TEAM_WS], modWs: [TEAM_WS] },
      surface: { kind: 'owner', via: 'heartbeat' },
      actor: { kind: 'assistant', agentId: AGENT },
    });
    h.assistantWs = [TEAM_WS];
    const run = await recheck(seated, OWNER, AGENT);
    expect(run).toMatchObject({
      run: { scope: { loginId: null, ws: [TEAM_WS], modWs: [TEAM_WS] }, narrowed: [] },
    });
    // The assistant moved to another workspace: the scope is gone.
    h.assistantWs = [];
    expect(await recheck(seated, OWNER, AGENT)).toEqual({ refused: PENDING_SCOPE_LOST_ERROR });
  });

  it('a row with no asker runs as the actor its turn ran as, never the approving path’s (fix round 1, L5)', async () => {
    reset();
    h.assistantWs = [TEAM_WS];
    const stamped = (actor: PendingOrigin['actor']) =>
      origin({
        scope: { kind: 'assistant', loginId: null, ws: [TEAM_WS], modWs: [TEAM_WS] },
        surface: { kind: 'owner', via: 'heartbeat' },
        actor,
      });
    expect(
      await recheck(stamped({ kind: 'assistant', agentId: AGENT }), OWNER, AGENT),
    ).toMatchObject({ actor: { kind: 'assistant', agentId: AGENT } });
    // None stamped: the asking assistant, not the owner who approves.
    expect(await recheck(stamped(undefined), OWNER, AGENT)).toMatchObject({
      actor: { kind: 'assistant', agentId: AGENT },
    });
    // An Admin assistant that answered no one ran as the owner: so it runs.
    expect(
      await recheck(stamped({ kind: 'login', mode: 'owner', loginId: OWNER }), MOD, AGENT),
    ).toMatchObject({ actor: { kind: 'login', loginId: OWNER } });
  });

  it('a call asked through a public link: only the owner approves it, in no scope (fix round 1, L4)', async () => {
    reset();
    const linked = origin({ scope: null, enter: null, admin: null, surface: null, link: true });
    for (const approver of [MOD, ASKER, null]) {
      expect(await recheck(linked, approver)).toEqual({ refused: PENDING_LINK_OWNER_ERROR });
    }
    expect(await recheck(linked, OWNER)).toMatchObject({ run: { scope: null } });
  });

  it('a Telegram chat’s call is judged on an owner path naming its login, the chat id not stamped (fix round 1)', async () => {
    reset();
    asker([TEAM_WS], [TEAM_WS]);
    const run = await recheck(origin({ surface: { kind: 'telegram', loginId: ASKER } }));
    expect(run).toMatchObject({
      run: { surface: { kind: 'owner', via: 'pending', loginId: ASKER } },
    });
  });
});

describe('a refusal is a domain error (A10 part 2 table)', () => {
  it('answers 403 with its message, on the web and as a tool', async () => {
    const { domainErrorAnswer } = await import('@mantle/std');
    expect(domainErrorAnswer(new ApprovalRefusedError(ELEVATED_APPROVER_ERROR))).toEqual({
      status: 403,
      body: { error: ELEVATED_APPROVER_ERROR },
      toolText: ELEVATED_APPROVER_ERROR,
    });
  });
});
