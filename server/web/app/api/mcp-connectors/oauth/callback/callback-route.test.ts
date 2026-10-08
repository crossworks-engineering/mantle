/**
 * GET /api/mcp-connectors/oauth/callback (M4 audit, medium 3): a sign-in as
 * the account signed in before keeps the connector's read-only marks; another
 * account voids them; a sign-in that names no account keeps them and asks the
 * admin to re-check, only when there are marks to re-check.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const t = vi.hoisted(() => ({
  account: 'same' as 'same' | 'changed' | 'unknown',
  marks: 0,
  clear: vi.fn(async () => {}),
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({ id: 'anchor-1' })),
}));
vi.mock('@mantle/tools', () => ({
  abandonMcpOAuth: vi.fn(async () => 'refused'),
  clearConnectorExternalAccess: t.clear,
  completeMcpOAuth: vi.fn(async () => ({ account: t.account })),
  connectorMarkCount: vi.fn(async () => t.marks),
  dbMcpOAuthStore: vi.fn(() => ({})),
  findConnectorByOAuthState: vi.fn(async () => 'mcp-site'),
  syncMcpConnector: vi.fn(async () => ({ toolSlugs: ['a', 'b'] })),
}));

const call = async () => {
  const { GET } = await import('./route');
  const res = await GET(
    new Request('http://localhost/api/mcp-connectors/oauth/callback?state=s1&code=c1'),
  );
  return { status: res.status, text: await res.text() };
};

describe('GET /api/mcp-connectors/oauth/callback', () => {
  beforeEach(() => {
    t.clear.mockClear();
    t.marks = 2;
  });

  it('a reconnect as the same account keeps the marks', async () => {
    t.account = 'same';
    const res = await call();
    expect(res.status).toBe(200);
    expect(t.clear).not.toHaveBeenCalled();
    expect(res.text).not.toContain('check them again');
  });

  it('another account voids them', async () => {
    t.account = 'changed';
    expect((await call()).status).toBe(200);
    expect(t.clear).toHaveBeenCalledWith('anchor-1', 'mcp-site');
  });

  it('an account it cannot tell keeps them and asks the admin to re-check', async () => {
    t.account = 'unknown';
    const res = await call();
    expect(t.clear).not.toHaveBeenCalled();
    expect(res.text).toContain('check them again');
    // Nothing marked: nothing to re-check.
    t.marks = 0;
    expect((await call()).text).not.toContain('check them again');
  });
});
