/**
 * The stamp of the scope a pending call was asked in, and the Admin view an
 * approved call may not exceed (A5 step 6c, pending-origin.ts and
 * gate-callers.ts capAdminView). The scope reads are stubbed (no database);
 * the stamp a real turn writes and the scope its approval runs in, on a
 * real database: server/web/server/a5-approval-recheck.db.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  scope: null as null | Record<string, unknown>,
  gate: null as null | Record<string, unknown>,
  mode: null as null | Record<string, unknown>,
  holds: false,
  areas: [] as string[],
}));

vi.mock('../../db/src/viewer', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/src/viewer')>();
  return {
    ...real,
    currentWorkspaceScope: () => h.scope,
    currentGateScope: () => h.gate,
    currentRequestMode: () => h.mode,
  };
});
vi.mock('../../db/src/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/src/client')>()),
  scopeHoldsAdmin: async () => h.holds,
  scopeHasArea: async (area: string) => h.areas.includes(area),
  loginHasArea: async (_login: string, area: string) => h.areas.includes(area),
  withTurnScope: async (_s: unknown, fn: () => Promise<unknown>) => fn(),
}));

import { loginActor, runAsActor } from '@mantle/db';
import { linkLoginId } from './builtins-share';
import { capAdminView } from './gate-callers';
import {
  originRunFor,
  pendingOriginNow,
  PENDING_SURFACE_LOGIN_ERROR,
  PENDING_SURFACE_MCP_ERROR,
} from './pending-origin';
import { ownerKeysOff } from './surface';
import type { ToolHandlerContext } from './types';

const LOGIN = '55555555-5555-4555-8555-555555555555';
const TEAM = '22222222-2222-4222-8222-222222222222';
const ADMIN = '11111111-1111-4111-8111-111111111111';

describe('the stamp a queued call carries (pendingOriginNow)', () => {
  it("a member's Team turn: its scope whole, how it held it, its surface's kind and login", async () => {
    h.scope = { kind: 'assistant', loginId: LOGIN, ws: [TEAM], modWs: [TEAM] };
    h.gate = null;
    h.mode = null;
    h.holds = false;
    expect(
      await pendingOriginNow({
        kind: 'telegram',
        telegramChatId: '123',
        loginId: LOGIN,
        accountId: 'acc',
      }),
    ).toEqual({
      v: 1,
      scope: { kind: 'assistant', loginId: LOGIN, ws: [TEAM], modWs: [TEAM] },
      enter: 'turn',
      writes: false,
      admin: { holds: false, areas: [] },
      // No chat or account id: only what a re-check reads.
      surface: { kind: 'telegram', loginId: LOGIN },
      actor: { kind: 'system', reason: 'test' },
    });
  });

  it('an Admin turn: its writes and the Admin areas it could do', async () => {
    h.scope = { kind: 'assistant', loginId: LOGIN, ws: [ADMIN], modWs: [] };
    h.mode = { writes: true, drafts: true };
    h.holds = true;
    h.areas = ['settings', 'keys'];
    expect(await pendingOriginNow({ kind: 'web', loginId: LOGIN })).toMatchObject({
      enter: 'turn',
      writes: true,
      admin: { holds: true, areas: ['settings', 'keys'] },
      surface: { kind: 'web', loginId: LOGIN },
    });
  });

  it("the rollback switch's gate scope: held as a gate scope", async () => {
    h.scope = null;
    h.gate = { kind: 'assistant', loginId: LOGIN, ws: [ADMIN], modWs: [ADMIN] };
    h.holds = true;
    h.areas = ['users'];
    expect(await pendingOriginNow({ kind: 'owner', via: 'run' })).toMatchObject({
      scope: { ws: [ADMIN], modWs: [ADMIN] },
      enter: 'gate',
      writes: false,
      admin: { holds: true, areas: ['users'] },
      surface: { kind: 'owner', via: 'run' },
    });
  });

  it('a turn in no scope (system work): no scope, no Admin view', async () => {
    h.scope = null;
    h.gate = null;
    expect(await pendingOriginNow(undefined)).toEqual({
      v: 1,
      scope: null,
      enter: null,
      writes: false,
      admin: null,
      surface: null,
      actor: { kind: 'system', reason: 'test' },
    });
  });

  it('the actor the turn runs as, so a row with no asker runs as it (fix round 1, L5)', async () => {
    h.scope = { kind: 'assistant', loginId: null, ws: [TEAM], modWs: [] };
    h.gate = null;
    h.mode = null;
    h.holds = false;
    const agent = '44444444-4444-4444-8444-444444444444';
    expect(
      await runAsActor({ kind: 'assistant', agentId: agent }, () =>
        pendingOriginNow({ kind: 'owner', via: 'heartbeat' }),
      ),
    ).toMatchObject({ actor: { kind: 'assistant', agentId: agent } });
    expect(
      await runAsActor(loginActor(LOGIN, 'owner'), () => pendingOriginNow(undefined)),
    ).toMatchObject({ actor: { kind: 'login', mode: 'owner', loginId: LOGIN } });
    // A link or a contact is no actor a call runs as: none.
    expect(await runAsActor({ kind: 'link' }, () => pendingOriginNow(undefined))).toMatchObject({
      actor: null,
    });
  });

  it("a public link's turn: no scope, marked, so only the owner approves it (fix round 1, L4)", async () => {
    h.scope = { kind: 'link', loginId: null, ws: [], modWs: [], served: ['n1'] };
    h.gate = null;
    expect(await pendingOriginNow(undefined)).toMatchObject({
      scope: null,
      enter: null,
      admin: null,
      link: true,
    });
  });
});

describe('the Admin view an approved call may not exceed (capAdminView)', () => {
  const view = (holdsAdmin: boolean, areas: string[]) => ({ holdsAdmin, areas: new Set(areas) });

  it('met with what it held when asked: a right gained since is not the call’s', () => {
    expect(
      capAdminView(view(true, ['settings', 'keys']), { holds: true, areas: ['settings'] }),
    ).toEqual(view(true, ['settings']));
    expect(capAdminView(view(true, ['settings']), { holds: false, areas: [] })).toEqual(
      view(false, []),
    );
  });

  it('one it lost since stays lost', () => {
    expect(capAdminView(view(false, []), { holds: true, areas: ['settings'] })).toEqual(
      view(false, []),
    );
  });

  it('no cap, or an unscoped view: as read', () => {
    expect(capAdminView(view(true, ['users']), undefined)).toEqual(view(true, ['users']));
    expect(capAdminView(view(true, ['users']), null)).toEqual(view(true, ['users']));
    expect(capAdminView(null, { holds: true, areas: [] })).toBeNull();
  });
});

/**
 * The surface an approved call runs on (lows round, 6c L1 to L3), from a
 * stamp with no scope (so no scope read is asked). Recorded on main first;
 * each answer this round changed is named with its main answer:
 *   L1 a Telegram chat that named no login: main linked as the owner, now
 *      refused (a delegated child's path, no owner fallback);
 *   L2 a stamp naming another login than the row's asker: main ran as the
 *      stamp's login, now refused; a stamp naming none: main named none,
 *      now the asker;
 *   L3 a member's MCP turn: main dropped its connection, so the approved
 *      call spent on the owner's keys (ownerKeysOff false) and a peer's
 *      connection that named no login linked as the owner; now both kept.
 */
describe('the surface an approved stamped call runs on (lows round, 6c)', () => {
  const OWNER = '99999999-9999-4999-8999-999999999999';
  const OTHER = '66666666-6666-4666-8666-666666666666';
  const refuse = (m: string) => new Error(m);
  const runOn = async (
    surface: ToolHandlerContext['surface'],
    loginId: string | null,
  ): Promise<ToolHandlerContext['surface']> => {
    h.scope = null;
    h.gate = null;
    const origin = await pendingOriginNow(surface);
    return (await originRunFor(OWNER, origin, { agentId: null, loginId }, refuse)).surface;
  };
  const linkAs = (surface: ToolHandlerContext['surface']) => {
    try {
      return linkLoginId({ ownerId: OWNER, surface });
    } catch {
      return 'refused';
    }
  };

  it('L1: a Telegram chat that named no login links as no one (main: as the owner)', async () => {
    const run = await runOn({ kind: 'telegram', telegramChatId: '1' }, null);
    expect(run).toEqual({ kind: 'owner', via: 'delegate' });
    expect(linkAs(run)).toBe('refused');
    // One that named its login: that login, as before.
    const named = await runOn({ kind: 'telegram', telegramChatId: '1', loginId: LOGIN }, LOGIN);
    expect(named).toEqual({ kind: 'owner', via: 'pending', loginId: LOGIN });
    expect(linkAs(named)).toBe(LOGIN);
  });

  it("L2: the surface's login is the row's asker; a stamp naming another refuses (main: ran as the stamp's)", async () => {
    await expect(runOn({ kind: 'web', loginId: OTHER }, LOGIN)).rejects.toThrow(
      PENDING_SURFACE_LOGIN_ERROR,
    );
    // A stamp naming none runs as the asker (main: named none).
    expect(await runOn({ kind: 'web' }, LOGIN)).toEqual({ kind: 'web', loginId: LOGIN });
    // A row with no asker: the owner's login is kept, any other refuses.
    expect(await runOn({ kind: 'web', loginId: OWNER }, null)).toEqual({
      kind: 'web',
      loginId: OWNER,
    });
    await expect(runOn({ kind: 'web', loginId: OTHER }, null)).rejects.toThrow(
      PENDING_SURFACE_LOGIN_ERROR,
    );
    // The stamp and the row agree: unchanged.
    expect(await runOn({ kind: 'team', loginId: LOGIN }, LOGIN)).toEqual({
      kind: 'team',
      loginId: LOGIN,
    });
  });

  it("L3: an approved member MCP call still spends nothing on the owner's keys (main: it did)", async () => {
    const asked: ToolHandlerContext['surface'] = {
      kind: 'owner',
      via: 'mcp',
      loginId: LOGIN,
      mcp: { via: 'oauth', write: true, oauthClientId: 'client-1', ownerKeysOff: true },
    };
    expect(ownerKeysOff({ surface: asked })).toBe(true);
    // The stamp keeps how it came in and the keys rule, and (lows round 2,
    // L7; main: dropped) its client id for the app data log; no Write.
    expect((await pendingOriginNow(asked)).surface).toEqual({
      kind: 'owner',
      via: 'mcp',
      loginId: LOGIN,
      mcp: { via: 'oauth', oauthClientId: 'client-1', ownerKeysOff: true },
    });
    const run = await runOn(asked, LOGIN);
    expect(run).toEqual({
      kind: 'owner',
      via: 'mcp',
      loginId: LOGIN,
      mcp: {
        via: 'oauth',
        write: false,
        oauthClientId: 'client-1',
        ownerKeysOff: true,
        approval: true,
      },
    });
    expect(ownerKeysOff({ surface: run })).toBe(true);
    // An Admin login's connection keeps spending as it did.
    const admin = await runOn(
      { kind: 'owner', via: 'mcp', loginId: LOGIN, mcp: { via: 'oauth', write: true } },
      LOGIN,
    );
    expect(ownerKeysOff({ surface: admin })).toBe(false);
  });

  it("L3: a peer's connection that named no login is never read as the owner's own path (main: linked as the owner)", async () => {
    const run = await runOn(
      { kind: 'owner', via: 'mcp', mcp: { via: 'peer', write: true, peerId: 'p1' } },
      null,
    );
    // Lows round 2, L7: its peer id kept, marked an approval's.
    expect(run).toEqual({
      kind: 'owner',
      via: 'mcp',
      mcp: { via: 'peer', write: false, peerId: 'p1', approval: true },
    });
    expect(linkAs(run)).toBe('refused');
    // The owner's own stdio connection (no channel): the owner, as before.
    expect(linkAs(await runOn({ kind: 'owner', via: 'mcp' }, null))).toBe(OWNER);
  });
});

/**
 * The second lows round on approvals (lows-approvals-2), from a stamp with
 * no scope. Recorded on main first; each answer this round changed is named
 * with its main answer:
 *   L1 a peer's connection that named no login, its row given an asker by
 *      its session: main ran it naming the asker (so a link opened as that
 *      login), now it names none and a link is refused;
 *   L4 a stamp of an MCP connection by a way in this code does not know:
 *      main ran it with the connection dropped (no Write switch, no keys
 *      rule, read as an owner path naming its login), now refused;
 *   L7 a login's own MCP connection keeps its key, peer and OAuth client id
 *      on the stamp and at approval (the app data log names them; main
 *      dropped them), and the restored connection says it is an approval's,
 *      so app_data_write says why it does not run.
 */
describe('the surface an approved stamped call runs on (lows-approvals-2)', () => {
  const OWNER = '99999999-9999-4999-8999-999999999999';
  const refuse = (m: string) => new Error(m);
  const runOn = async (
    surface: ToolHandlerContext['surface'],
    loginId: string | null,
  ): Promise<ToolHandlerContext['surface']> => {
    h.scope = null;
    h.gate = null;
    const origin = await pendingOriginNow(surface);
    return (await originRunFor(OWNER, origin, { agentId: null, loginId }, refuse)).surface;
  };
  const linkAs = (surface: ToolHandlerContext['surface']) => {
    try {
      return linkLoginId({ ownerId: OWNER, surface });
    } catch {
      return 'refused';
    }
  };

  it("L1: a peer's connection that named no login names none at approval, whatever asker its row has (main: linked as the asker)", async () => {
    const run = await runOn(
      { kind: 'owner', via: 'federation', mcp: { via: 'peer', write: true, peerId: 'p1' } },
      LOGIN,
    );
    expect(run).toEqual({
      kind: 'owner',
      via: 'federation',
      mcp: { via: 'peer', write: false, peerId: 'p1', approval: true },
    });
    expect(linkAs(run)).toBe('refused');
    // A peer that named its login (registered by its Admin login): that
    // login, as before.
    const named = await runOn(
      {
        kind: 'owner',
        via: 'federation',
        loginId: LOGIN,
        mcp: { via: 'peer', write: true, peerId: 'p1' },
      },
      LOGIN,
    );
    expect(linkAs(named)).toBe(LOGIN);
  });

  it('L4: a stamp of an MCP connection by an unknown way in refuses the approval (main: ran with the connection dropped)', async () => {
    await expect(
      runOn(
        {
          kind: 'owner',
          via: 'mcp',
          loginId: LOGIN,
          mcp: { via: 'sse' as never, write: true, ownerKeysOff: true },
        },
        LOGIN,
      ),
    ).rejects.toThrow(PENDING_SURFACE_MCP_ERROR);
  });

  it("L7: the connection's key, peer and OAuth client ids are kept for the app data log (main: dropped)", async () => {
    const asked: ToolHandlerContext['surface'] = {
      kind: 'owner',
      via: 'api',
      loginId: LOGIN,
      mcp: { via: 'key', write: true, keyId: 'key-1', role: 'member', ownerKeysOff: true },
    };
    expect((await pendingOriginNow(asked)).surface).toEqual({
      kind: 'owner',
      via: 'api',
      loginId: LOGIN,
      mcp: { via: 'key', keyId: 'key-1', ownerKeysOff: true },
    });
    const run = await runOn(asked, LOGIN);
    expect(run).toEqual({
      kind: 'owner',
      via: 'api',
      loginId: LOGIN,
      mcp: { via: 'key', write: false, keyId: 'key-1', ownerKeysOff: true, approval: true },
    });
    // A stamped id that is not a string (a stamp is JSON) is not restored.
    const origin = await pendingOriginNow(asked);
    (origin.surface as { mcp: Record<string, unknown> }).mcp['keyId'] = 7;
    const bad = await originRunFor(OWNER, origin, { agentId: null, loginId: LOGIN }, refuse);
    expect((bad.surface as { mcp: Record<string, unknown> }).mcp['keyId']).toBeUndefined();
  });
});
