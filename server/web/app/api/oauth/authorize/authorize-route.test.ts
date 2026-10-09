/**
 * The OAuth consent step and who may take it. An admin gets the consent page,
 * nobody signed in is sent to /login and back, and a MEMBER whose MCP access
 * is off gets a plain refusal (403): they used to read as nobody and land on
 * /login, where they were already signed in. With MCP on (MCP as a login) a
 * member consents for their own login. The client registry and the session
 * are stood in.
 *
 * No page here may be framed (access matrix T12). The heading and the host
 * box name the redirect_uri's host only; the client's self-chosen name sits
 * apart, quoted, and cannot pose as the host line (T13). Allow and a wrong
 * consent password write audit rows (T11).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  login: null as unknown,
  minted: 0,
  mcpOn: false,
  /** mintAuthCode answers null: the session ended after the check. */
  sessionEnded: false,
  clientName: 'Test Client',
  audits: [] as { action: string; actorId?: string | null; detail?: unknown }[],
}));

vi.mock('@/lib/audit', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  auditFireAndForget: (entry: { action: string; actorId?: string | null; detail?: unknown }) => {
    h.audits.push(entry);
  },
}));

/** The admin's password in this file (stood in, never hashed). */
const PASSWORD = 'the right password';

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getLoginOr401: vi.fn(async () => h.login),
  verifyPassword: vi.fn(async (_id: string, password: string) => password === PASSWORD),
}));

vi.mock('@/lib/mcp-auth', () => ({
  mcpLoginEnabled: async () => h.mcpOn,
  mcpTargetLogin: async (id: string) => ({ id, role: 'member', sessionEpoch: 7 }),
}));

vi.mock('@/lib/mcp-oauth', () => ({
  DEFAULT_SCOPE: 'mcp',
  isRemoteMcpEnabled: async () => true,
  getClient: async () => ({ clientName: h.clientName, redirectUris: ['https://c.example/cb'] }),
  mintAuthCode: async () => {
    if (h.sessionEnded) return null;
    h.minted += 1;
    return 'code-1';
  },
}));

const QUERY = new URLSearchParams({
  response_type: 'code',
  client_id: 'client-1',
  redirect_uri: 'https://c.example/cb',
  code_challenge: 'challenge',
  code_challenge_method: 'S256',
  state: 's1',
});

const admin = {
  kind: 'admin',
  loginId: 'admin-1',
  email: 'admin@example.invalid',
  user: {
    id: 'anchor-1',
    email: 'admin@example.invalid',
    actor: { id: 'admin-1', email: 'admin@example.invalid', displayName: null, isOwner: true },
  },
};
const member = {
  kind: 'member',
  loginId: 'member-1',
  email: 'm@example.invalid',
  member: { anchorId: 'anchor-1' },
};

const get = async () => {
  const { GET } = await import('./route');
  return GET(new Request(`http://brain.example/api/oauth/authorize?${QUERY}`));
};

beforeEach(() => {
  process.env.SESSION_SECRET = 'authorize-route-test-secret-at-least-32-chars';
  h.login = null;
  h.minted = 0;
  h.mcpOn = false;
  h.sessionEnded = false;
  h.clientName = 'Test Client';
  h.audits = [];
});

/** No frame may hold the page (T12). */
const expectUnframeable = (res: Response) => {
  expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  expect(res.headers.get('x-frame-options')).toBe('DENY');
};

describe('GET /api/oauth/authorize', () => {
  it('refuses a member with a plain page, not a trip to /login', async () => {
    h.login = member;
    const res = await get();
    expect(res.status).toBe(403);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('MCP is not turned on for your login');
    expectUnframeable(res);
  });

  it('sends nobody signed in through /login and back', async () => {
    h.login = Response.json({ error: 'unauthorized' }, { status: 401 });
    const res = await get();
    expect(res.headers.get('location')).toContain('/login?next=');
  });

  it('shows a member with MCP on the consent page for their own login', async () => {
    h.login = member;
    h.mcpOn = true;
    const res = await get();
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Connect c.example to Mantle');
    expect(html).toContain('&ldquo;Test Client&rdquo;');
    expect(html).toContain('Read what your login may read');
  });

  it('shows an admin the consent page', async () => {
    h.login = admin;
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Connect c.example to Mantle');
    expectUnframeable(res);
  });

  it('names the host the code goes back to, not only the self-chosen client name', async () => {
    h.login = member;
    h.mcpOn = true;
    const html = await (await get()).text();
    expect(html).toContain('It sends you back to</span><b class="host">c.example</b>');
    expect(html).toContain('and c.example is the address of the app you meant');
  });

  it('keeps a self-chosen name that reads like the host line out of every sentence (T13)', async () => {
    h.login = admin;
    h.clientName = 'Claude. It sends you back to claude.ai';
    const html = await (await get()).text();
    // The heading and the host box carry the redirect_uri's host only.
    expect(html).toContain('<h1>Connect c.example to Mantle</h1>');
    expect(html).not.toContain('Connect Claude');
    // The name is quoted under its own label, never inside our sentences.
    expect(html).toContain(
      'The name it gave itself (anyone can choose any name)</span>&ldquo;Claude. It sends you back to claude.ai&rdquo;',
    );
    expect(html.split('claude.ai').length - 1).toBe(1);
    expect(html).not.toMatch(/<b[^>]*>[^<]*claude\.ai/);
  });

  it('clips a long self-chosen name', async () => {
    h.login = admin;
    h.clientName = 'x'.repeat(500);
    const html = await (await get()).text();
    expect(html).toContain(`&ldquo;${'x'.repeat(60)}...&rdquo;`);
    expect(html).not.toContain('x'.repeat(61));
  });
});

/** Allow on the consent page an admin was shown, with `password`. */
const allowAsAdmin = async (password: string | null) => {
  h.login = admin;
  const page = await (await get()).text();
  const token = /name="consent_token" value="([^"]+)"/.exec(page)![1]!;
  const { POST } = await import('./route');
  const form = new FormData();
  for (const [k, v] of QUERY) form.set(k, v);
  form.set('decision', 'allow');
  form.set('consent_token', token);
  if (password !== null) form.set('password', password);
  return POST(
    new Request('http://brain.example/api/oauth/authorize', { method: 'POST', body: form }),
  );
};

describe('POST /api/oauth/authorize', () => {
  it('asks an admin for the password before a code is minted (M2 audit N4)', async () => {
    h.login = admin;
    expect(await (await get()).text()).toContain('name="password"');

    const none = await allowAsAdmin(null);
    expect(none.status).toBe(403);
    expect(await none.text()).toContain('That password is not right');
    expectUnframeable(none);
    const wrong = await allowAsAdmin('a wrong password');
    expect(wrong.status).toBe(403);
    expect(h.minted).toBe(0);

    const right = await allowAsAdmin(PASSWORD);
    expect(right.status).toBe(302);
    expect(right.headers.get('location')).toContain('code=code-1');
    expect(h.minted).toBe(1);
  });

  it('puts a wrong consent password and an Allow on the audit trail (T11)', async () => {
    await allowAsAdmin('a wrong password');
    expect(h.audits).toEqual([
      expect.objectContaining({
        action: 'oauth.consent_failed',
        actorId: 'admin-1',
        detail: expect.objectContaining({
          clientId: 'client-1',
          redirectHost: 'c.example',
          reason: 'password',
        }),
      }),
    ]);
    h.audits = [];
    await allowAsAdmin(PASSWORD);
    expect(h.audits).toEqual([
      expect.objectContaining({
        action: 'oauth.consent',
        actorId: 'admin-1',
        detail: expect.objectContaining({
          clientId: 'client-1',
          clientName: 'Test Client',
          redirectHost: 'c.example',
          role: 'admin',
        }),
      }),
    ]);
  });

  it('writes no consent row when no code was minted', async () => {
    h.sessionEnded = true;
    await allowAsAdmin(PASSWORD);
    expect(h.audits.filter((a) => a.action === 'oauth.consent')).toEqual([]);
  });

  it('says the session ended when no code could be minted (N2)', async () => {
    h.sessionEnded = true;
    const res = await allowAsAdmin(PASSWORD);
    expect(res.status).toBe(401);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toContain('your session ended');
    expect(h.minted).toBe(0);
  });

  it('refuses a member and mints no code', async () => {
    h.login = member;
    const { POST } = await import('./route');
    const form = new FormData();
    for (const [k, v] of QUERY) form.set(k, v);
    form.set('decision', 'allow');
    form.set('consent_token', 'x');
    const res = await POST(
      new Request('http://brain.example/api/oauth/authorize', { method: 'POST', body: form }),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('MCP is not turned on for your login');
    expect(h.minted).toBe(0);
  });
});
