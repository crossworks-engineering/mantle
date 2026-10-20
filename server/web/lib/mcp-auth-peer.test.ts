/**
 * A linked brain's bearer (lib/mcp-auth.ts callerFromPeerToken): the peer
 * acts as the login it is bound to, and what only an Admin login has (the
 * owner's own peer, the risky tools named on the peer) asks the Admin pair
 * (role admin AND a user of Admin, read with the login row), never the role
 * alone. No database: the peer check and the login row are stood in, for
 * the five logins of the adminFacts cells.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  boundTo: '' as string,
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
});

describe("a peer's Admin facts (callerFromPeerToken)", () => {
  it('the owner peer and the risky tools follow the Admin pair, not the role', async () => {
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
      out: { role: 'admin', peerByOwner: false, risky: [] }, // narrower: no Admin pair
      memIn: { role: 'member', peerByOwner: false, risky: [] },
      mem: { role: 'member', peerByOwner: false, risky: [] },
    });
  });
});
