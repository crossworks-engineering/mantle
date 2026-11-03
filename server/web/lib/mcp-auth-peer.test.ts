/**
 * A linked brain's bearer (lib/mcp-auth.ts callerFromPeerToken): the peer
 * acts as the login it is bound to, and what only an Admin login has (the
 * owner's own peer, the risky tools named on the peer) asks Admin
 * membership (a user of Admin, read with the login row; S8b), never the
 * role. No database: the peer check and the login row are stood in, for
 * the five logins of the adminFacts cells.
 *
 * And the access scope (0353, docs/federation.md "Status links"): a
 * `status` peer is the owner, read-only, status tools only, whatever its row
 * says about Acts as, Write or risky tools; `none` and a scope this code
 * does not know are no caller (fail closed).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  boundTo: '' as string,
  accessScope: 'full' as string,
}));

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  verifyInboundToken: vi.fn(async () => ({
    id: 'peer-1',
    ownerId: OWNER,
    createdBy: OWNER,
    actsAsLoginId: h.boundTo,
    writeEnabled: true,
    allowedRiskyTools: ['email_send'],
    accessScope: h.accessScope,
  })),
}));
vi.mock('./auth/login-row', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadLoginRow: vi.fn(async () => h.row),
}));

/** The login rows: [role, a user of Admin now, the anchor]. */
const LOGINS = {
  owner: ['admin', true, true],
  adm: ['admin', true, false],
  out: ['admin', false, false], // role admin, taken out of Admin (drift)
  memIn: ['member', true, false], // role member, put into Admin (drift)
  mem: ['member', false, false],
} as const;

beforeEach(() => {
  h.row = null;
  h.accessScope = 'full';
});

function loginRow(name: string, id: string, role: string, adminMember: boolean) {
  return {
    id,
    role,
    adminMember,
    email: `${name}@example.invalid`,
    displayName: name,
    disabledAt: null,
    sessionEpoch: 0,
  };
}

async function callerFor(): Promise<Record<string, unknown> | null> {
  const { resolveMcpCaller } = await import('./mcp-auth');
  const req = new Request('http://x/api/mcp', {
    headers: { authorization: 'Bearer mtlpeer_stand-in' },
  });
  return (await resolveMcpCaller(req)) as Record<string, unknown> | null;
}

describe("a peer's Admin facts (callerFromPeerToken)", () => {
  it('the owner peer and the risky tools follow Admin membership, not the role', async () => {
    const { resolveMcpCaller } = await import('./mcp-auth');
    const got: Record<string, unknown> = {};
    for (const [name, [role, adminMember, anchor]] of Object.entries(LOGINS)) {
      const id = anchor ? OWNER : `${name}-login`;
      h.boundTo = id;
      h.row = {
        id,
        role,
        adminMember,
        email: `${name}@example.invalid`,
        displayName: name,
        disabledAt: null,
        sessionEpoch: 0,
      };
      const req = new Request('http://x/api/mcp', {
        headers: { authorization: 'Bearer mtlpeer_stand-in' },
      });
      const c = (await resolveMcpCaller(req)) as {
        role: string;
        peerByOwner: boolean;
        riskyAllowed: string[];
      } | null;
      got[name] = c && { role: c.role, peerByOwner: c.peerByOwner, risky: c.riskyAllowed };
    }
    expect(got).toEqual({
      owner: { role: 'admin', peerByOwner: true, risky: ['email_send'] },
      adm: { role: 'admin', peerByOwner: false, risky: ['email_send'] },
      out: { role: 'admin', peerByOwner: false, risky: [] }, // drift: not a user of Admin
      // Drift: membership decides (S8b), the one wider answer, on a box with
      // drift only (the merge's precondition is mantle_role_drift 0).
      memIn: { role: 'member', peerByOwner: false, risky: ['email_send'] },
      mem: { role: 'member', peerByOwner: false, risky: [] },
    });
  });
});

describe("a peer's access scope (callerFromPeerToken, 0353)", () => {
  it('a status peer is the owner, read-only, the status tools only, whatever its row says', async () => {
    h.accessScope = 'status';
    // Bound to a member with Write and a risky tool: none of it counts.
    h.boundTo = 'mem-login';
    h.row = loginRow('owner', OWNER, 'admin', true);
    expect(await callerFor()).toEqual({
      role: 'admin',
      anchorId: OWNER,
      loginId: OWNER,
      displayName: 'owner',
      via: 'peer',
      peerId: 'peer-1',
      peerByOwner: false,
      write: false,
      riskyAllowed: [],
      statusOnly: true,
    });
  });

  it('a status peer whose owner is no usable Admin login is no caller', async () => {
    h.accessScope = 'status';
    h.row = { ...loginRow('owner', OWNER, 'admin', true), disabledAt: new Date() };
    expect(await callerFor()).toBeNull();
    h.row = loginRow('owner', OWNER, 'member', false);
    expect(await callerFor()).toBeNull();
  });

  it('a full peer is not status-only; `none` and an unknown scope are no caller', async () => {
    h.boundTo = OWNER;
    h.row = loginRow('owner', OWNER, 'admin', true);
    const full = await callerFor();
    expect(full?.statusOnly).toBeUndefined();
    expect(full?.write).toBe(true);
    for (const scope of ['none', 'everything', '']) {
      h.accessScope = scope;
      expect(await callerFor(), scope).toBeNull();
    }
  });
});
