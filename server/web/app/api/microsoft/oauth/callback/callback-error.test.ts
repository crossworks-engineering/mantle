/**
 * The Microsoft sign-in callback's failure redirect (A10 part 2, fold 2):
 * when the token exchange or the account write fails, the redirect to the
 * settings page carries a fixed sentence, never the error's own text (it
 * went into the URL before, cut at 200 characters); the text goes to the
 * server log.
 */
import { describe, expect, it, vi } from 'vitest';

const PRIVATE = 'token endpoint said: invalid_grant for tenant 1234 client secret xyz';

vi.mock('@mantle/microsoft', () => ({
  resolveOAuthConfig: async () => ({ clientId: 'c', tenant: 't' }),
  exchangeCode: async () => {
    throw new Error(PRIVATE);
  },
  fetchMe: async () => ({ upn: 'a@example.invalid', displayName: 'A', tenantId: 't' }),
  upsertAccountFromTokens: async () => undefined,
}));
vi.mock('@/lib/auth', () => ({ ownerCaller: () => ({ id: 'owner-1' }) }));

describe('GET /api/microsoft/oauth/callback, a failed connect', () => {
  it('redirects with the fixed sentence, not the error text', async () => {
    const { GET } = await import('./route');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await GET(
        new Request('http://brain.example.invalid/api/microsoft/oauth/callback?code=x&state=s', {
          headers: { cookie: 'ms_oauth_state=s; ms_oauth_verifier=v' },
        }) as never,
      );
      expect(res.status).toBe(307);
      const location = new URL(res.headers.get('location')!);
      expect(location.pathname).toBe('/settings/microsoft');
      expect(location.searchParams.get('error')).toBe(
        'Connecting your Microsoft account failed. The details are in the server log.',
      );
      expect(res.headers.get('location')).not.toMatch(/invalid_grant|secret|tenant/);
      expect(quiet).toHaveBeenCalled();
    } finally {
      quiet.mockRestore();
    }
  });
});
