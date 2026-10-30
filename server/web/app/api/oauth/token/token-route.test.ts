/**
 * The token endpoint and the RFC 8707 `resource` value (corporate plan,
 * phase 3). ChatGPT sends `resource` on the code exchange and the
 * refresh; a Claude connector may send none, and an old host name sends
 * a value that names the old host. Every one of them gets its tokens: a
 * value that does not name this box's MCP endpoint is logged, never
 * refused (plan section 2.1: a box that changes nothing behaves as
 * today). The grant logic itself is stood in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ exchanged: 0, refreshed: 0 }));

vi.mock('@/lib/audit', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  auditFireAndForget: () => {},
}));

const TOKENS = {
  access_token: 'at',
  refresh_token: 'rt',
  token_type: 'Bearer',
  expires_in: 3600,
  scope: 'mcp',
};

vi.mock('@/lib/mcp-oauth', () => ({
  isRemoteMcpEnabled: async () => true,
  exchangeAuthCode: async () => {
    h.exchanged += 1;
    return { ok: true, tokens: TOKENS, login: { id: 'l1', email: 'a@example.invalid' }, clientId: 'c1' };
  },
  refreshAccessToken: async () => {
    h.refreshed += 1;
    return { ok: true, tokens: TOKENS, login: { id: 'l1', email: 'a@example.invalid' }, clientId: 'c1' };
  },
}));

const post = async (form: Record<string, string>) => {
  const { POST } = await import('./route');
  return POST(
    new Request('https://brain.example/api/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    }),
  );
};

const CODE = {
  grant_type: 'authorization_code',
  code: 'code-1',
  redirect_uri: 'https://c.example/cb',
  client_id: 'c1',
  code_verifier: 'v',
};
const REFRESH = { grant_type: 'refresh_token', refresh_token: 'rt-0', client_id: 'c1' };

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  process.env.MANTLE_PUBLIC_URL = 'https://brain.example';
  h.exchanged = 0;
  h.refreshed = 0;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

/** The `[mcp-oauth] resource` lines logged so far. */
const resourceWarnings = () =>
  warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[mcp-oauth] resource'));

describe('POST /api/oauth/token and the resource value', () => {
  it('a Claude-style exchange and refresh with no resource get tokens', async () => {
    const res = await post(CODE);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ access_token: 'at', refresh_token: 'rt' });
    expect((await post(REFRESH)).status).toBe(200);
    expect([h.exchanged, h.refreshed]).toEqual([1, 1]);
  });

  it('an old host name gets tokens', async () => {
    const resource = 'https://old-name.example/api/mcp';
    expect((await post({ ...CODE, resource })).status).toBe(200);
    expect((await post({ ...REFRESH, resource })).status).toBe(200);
    expect([h.exchanged, h.refreshed]).toEqual([1, 1]);
  });

  it('a value that is not a URL at all gets tokens', async () => {
    expect((await post({ ...CODE, resource: 'not a url' })).status).toBe(200);
    expect(h.exchanged).toBe(1);
  });

  it('the value ChatGPT sends (the protected resource metadata) gets tokens', async () => {
    const resource = 'https://brain.example/api/mcp';
    expect((await post({ ...CODE, resource })).status).toBe(200);
    expect((await post({ ...REFRESH, resource })).status).toBe(200);
    expect(resourceWarnings()).toEqual([]);
  });

  it('logs a value that names another server, once per grant, and no absent value', async () => {
    await post(CODE);
    await post(REFRESH);
    expect(resourceWarnings()).toEqual([]);
    await post({ ...CODE, resource: 'https://old-name.example/api/mcp' });
    await post({ ...REFRESH, resource: 'https://old-name.example/api/mcp' });
    const lines = resourceWarnings();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('at code exchange');
    expect(lines[1]).toContain('at refresh');
    expect(lines[0]).toContain('https://brain.example/api/mcp');
  });

  it('takes the host the request came in on as this box', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      new Request('https://old-name.example/api/oauth/token', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          host: 'old-name.example',
          'x-forwarded-proto': 'https',
        },
        body: new URLSearchParams({ ...CODE, resource: 'https://old-name.example/api/mcp' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(resourceWarnings()).toEqual([]);
  });
});
