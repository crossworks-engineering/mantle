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
import { capAdminView } from './gate-callers';
import { pendingOriginNow } from './pending-origin';

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
