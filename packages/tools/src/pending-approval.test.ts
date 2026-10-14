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
}));

vi.mock('../../db/src/viewer', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/src/viewer')>();
  return {
    ...real,
    currentWorkspaceScope: () => h.scope ?? real.currentWorkspaceScope(),
    currentGateScope: () => null,
    scopeLeftForSystem: () => null,
  };
});
vi.mock('../../db/src/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/src/client')>()),
  scopeHoldsAdmin: async () => false,
  scopeHasArea: async () => false,
  loginScopeFor: async (login: string) => ({
    kind: 'user',
    loginId: login,
    ws: h.modWs[login] ?? [],
    modWs: h.modWs[login] ?? [],
  }),
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

import { loginActor, runAsActor, type Tool } from '@mantle/db';
import { ensureGateReady } from './index';
import { CONNECTOR_NOT_HELD_ERROR } from './connector-scope';
import { gateCallerFor } from './gate-callers';
import {
  ApprovalRefusedError,
  deciderOf,
  elevatedApproval,
  ELEVATED_APPROVER_ERROR,
  ELEVATED_NO_APPROVER_ERROR,
  ELEVATED_SELF_APPROVAL_ERROR,
} from './pending-approval';
import { runtimeToolPolicy } from './runtime-policy';

const OWNER = '99999999-9999-4999-8999-999999999999';
const ASKER = '55555555-5555-4555-8555-555555555555';
const MOD = '66666666-6666-4666-8666-666666666666';
const OTHER = '77777777-7777-4777-8777-777777777777';
const TEAM_WS = '22222222-2222-4222-8222-222222222222';
const ELSEWHERE_WS = '33333333-3333-4333-8333-333333333333';

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
async function approve(decider: string | null, scope: Record<string, unknown> | null = null) {
  ensureGateReady();
  h.scope = scope;
  try {
    return await runAsActor(loginActor(decider ?? OWNER), () =>
      elevatedApproval(OWNER, row, update, decider, context),
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
