/**
 * The OAuth consent step and who may take it. An admin gets the consent page,
 * nobody signed in is sent to /login and back, and a MEMBER whose MCP access
 * is off gets a plain refusal (403): they used to read as nobody and land on
 * /login, where they were already signed in. With MCP on (MCP as a login) a
 * member consents for their own login. The client registry and the session
 * are stood in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  login: null as unknown,
  minted: 0,
  mcpOn: false,
}));

/** The admin's password in this file (stood in, never hashed). */
const PASSWORD = 'the right password';

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getLoginOr401: vi.fn(async () => h.login),
  verifyPassword: vi.fn(async (_id: string, password: string) => password === PASSWORD),
  loginSessionEpoch: vi.fn(async () => 0),
}));

vi.mock('@/lib/mcp-auth', () => ({
  mcpLoginEnabled: async () => h.mcpOn,
  mcpTargetLogin: async (id: string) => ({ id, role: 'member', sessionEpoch: 7 }),
}));

vi.mock('@/lib/mcp-oauth', () => ({
  DEFAULT_SCOPE: 'mcp',
  isRemoteMcpEnabled: async () => true,
  getClient: async () => ({ clientName: 'Test Client', redirectUris: ['https://c.example/cb'] }),
  mintAuthCode: async () => {
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
});

describe('GET /api/oauth/authorize', () => {
  it('refuses a member with a plain page, not a trip to /login', async () => {
    h.login = member;
    const res = await get();
    expect(res.status).toBe(403);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('MCP is not turned on for your login');
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
    expect(html).toContain('Connect Test Client to Mantle');
    expect(html).toContain('Read what your login may read');
  });

  it('shows an admin the consent page', async () => {
    h.login = admin;
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Connect Test Client to Mantle');
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
    const wrong = await allowAsAdmin('a wrong password');
    expect(wrong.status).toBe(403);
    expect(h.minted).toBe(0);

    const right = await allowAsAdmin(PASSWORD);
    expect(right.status).toBe(302);
    expect(right.headers.get('location')).toContain('code=code-1');
    expect(h.minted).toBe(1);
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
