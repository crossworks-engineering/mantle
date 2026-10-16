/**
 * The MCP consent step through the full pipeline (runRoute), with the
 * remote MCP switch ON (A4 hand batch B fix round 1, L2): the login GET and
 * POST /api/oauth/authorize read is the one the gate answers at the read
 * (publicLoginCaller), from a real session cookie or device token, not a
 * stand-in of the reader. The guard sweep drives this row with the switch
 * off (every credential gets the off answer); authorize-route.test.ts
 * stands the reader in. Here: an Admin user, a member with MCP off and on,
 * nobody, and a revoked device token, on both methods.
 */
import { createHmac } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { runRoute } from '@/server/run-route';
import { standInLogin } from '@/server/run-route-stand-ins';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const SECRET = 'authorize-pipeline-test-secret-at-least-32-chars';
const REVOKED_JTI = '00000001-0000-4000-8000-000000000001';

const h = vi.hoisted(() => ({ mcpOn: false, minted: 0 }));

vi.mock('@/lib/auth/login-row', async () => {
  const standIn = (await import('@/server/run-route-stand-ins')).loginRowStandIn;
  return {
    ...standIn,
    // The one device token here: an Admin user's, revoked.
    loadBearerToken: async (jti: string) =>
      jti === REVOKED_JTI
        ? { userId: ANCHOR, revokedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000) }
        : null,
  };
});
// The switch on, one registered client, no database.
vi.mock('@/lib/mcp-oauth', () => ({
  DEFAULT_SCOPE: 'mcp',
  isRemoteMcpEnabled: async () => true,
  getClient: async () => ({ clientName: 'Test Client', redirectUris: ['https://c.example/cb'] }),
  mintAuthCode: async () => {
    h.minted += 1;
    return 'code-1';
  },
}));
vi.mock('@/lib/mcp-auth', () => ({
  mcpLoginEnabled: async () => h.mcpOn,
  mcpTargetLogin: async (id: string) => ({ id, role: 'member', sessionEpoch: 0 }),
}));
vi.mock('@/lib/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit')>()),
  auditFireAndForget: vi.fn(),
}));

const PARAMS = {
  client_id: 'client-1',
  redirect_uri: 'https://c.example/cb',
  code_challenge: 'x'.repeat(43),
  code_challenge_method: 'S256',
  state: 's1',
};
const QUERY = new URLSearchParams({ response_type: 'code', ...PARAMS }).toString();

/** The consent token the page hands the login it shows (route.ts). */
const consentToken = (loginId: string) =>
  createHmac('sha256', SECRET)
    .update(`${loginId}:${PARAMS.client_id}:${PARAMS.redirect_uri}:${PARAMS.code_challenge}`)
    .digest('base64url');

let revokedBearer: Record<string, string>;

beforeAll(async () => {
  process.env.SESSION_SECRET = SECRET;
  standInLogin({ id: ANCHOR, role: 'admin', isOwner: true });
  standInLogin({ id: MEMBER, role: 'member' });
  const { buildMobileToken } = await import('@/lib/auth/tokens');
  revokedBearer = {
    authorization: `Bearer ${buildMobileToken(ANCHOR, REVOKED_JTI, 3600, 0).value}`,
  };
});

const get = (login: string | null, headers: Record<string, string> = {}) =>
  runRoute(login, 'GET', `/api/oauth/authorize?${QUERY}`, undefined, { headers });

const post = (
  login: string | null,
  form: Record<string, string>,
  headers: Record<string, string> = {},
) =>
  runRoute(login, 'POST', '/api/oauth/authorize', undefined, {
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    rawBody: new URLSearchParams({ ...PARAMS, ...form }).toString(),
  });

describe('GET /api/oauth/authorize through the pipeline, switch on', () => {
  it('an Admin user gets the consent page', async () => {
    const res = await get(ANCHOR);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Connect c.example to Mantle');
  });

  it('a member: refused with a page while its MCP is off, the consent page once on', async () => {
    h.mcpOn = false;
    const off = await get(MEMBER);
    expect(off.status).toBe(403);
    expect(off.headers.get('location')).toBeNull();
    expect(await off.text()).toContain('MCP is not turned on for your login');
    h.mcpOn = true;
    const on = await get(MEMBER);
    expect(on.status).toBe(200);
    expect(await on.text()).toContain('Read what your login may read');
    h.mcpOn = false;
  });

  it('nobody, and a revoked device token, go through /login and back', async () => {
    for (const res of [await get(null), await get(null, revokedBearer)]) {
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toContain(
        `/login?next=${encodeURIComponent(`/api/oauth/authorize?${QUERY}`)}`,
      );
    }
  });
});

describe('POST /api/oauth/authorize through the pipeline, switch on', () => {
  it("an Admin user's decision: its own consent token is honoured, another login's is not", async () => {
    const deny = await post(ANCHOR, { consent_token: consentToken(ANCHOR), decision: 'deny' });
    expect(deny.status).toBe(302);
    const to = new URL(deny.headers.get('location')!);
    expect(to.origin + to.pathname).toBe(PARAMS.redirect_uri);
    expect(to.searchParams.get('error')).toBe('access_denied');
    expect(to.searchParams.get('state')).toBe('s1');
    const forged = await post(ANCHOR, { consent_token: consentToken(MEMBER), decision: 'deny' });
    expect(forged.status).toBe(400);
    expect(await forged.text()).toContain('consent could not be verified');
  });

  it('a member: refused while its MCP is off; once on, its own decision is honoured', async () => {
    h.mcpOn = false;
    const off = await post(MEMBER, { consent_token: consentToken(MEMBER), decision: 'deny' });
    expect(off.status).toBe(403);
    expect(await off.text()).toContain('MCP is not turned on for your login');
    h.mcpOn = true;
    const on = await post(MEMBER, { consent_token: consentToken(MEMBER), decision: 'deny' });
    expect(on.status).toBe(302);
    expect(new URL(on.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
    h.mcpOn = false;
  });

  it('nobody, and a revoked device token: the session expired', async () => {
    for (const res of [
      await post(null, { consent_token: consentToken(ANCHOR), decision: 'allow' }),
      await post(null, { consent_token: consentToken(ANCHOR), decision: 'allow' }, revokedBearer),
    ]) {
      expect(res.status).toBe(401);
      expect(await res.text()).toContain('your session expired');
    }
    expect(h.minted).toBe(0);
  });
});
