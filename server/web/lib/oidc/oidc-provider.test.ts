/**
 * The link's fresh sign-in (provider.ts identityFromCallback): with the
 * library's token exchange stood in, an auth_time older than the link's own
 * start is refused, a fresh one passes, and a provider that sends none is
 * let through (never strand anyone). A sign-in flow asks nothing of it. The
 * real round trip against a provider: server/web/scripts/oidc-flow-check.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ISSUER = 'https://idp.example.invalid/realms/company';
const h = vi.hoisted(() => ({ claims: {} as Record<string, unknown> }));

vi.mock('openid-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  discovery: async () => ({ serverMetadata: () => ({ issuer: ISSUER }) }),
  authorizationCodeGrant: async () => ({ claims: () => h.claims }),
}));

const NOW = Math.floor(Date.now() / 1000);
const flow = { state: 's', nonce: 'n', codeVerifier: 'v' };

beforeEach(() => {
  vi.stubEnv('MANTLE_OIDC_MODE', 'optional');
  vi.stubEnv('MANTLE_OIDC_ISSUER', ISSUER);
  vi.stubEnv('MANTLE_OIDC_CLIENT_ID', 'mantle');
  vi.stubEnv('MANTLE_PUBLIC_URL', 'https://brain.example.invalid');
});
afterEach(() => vi.unstubAllEnvs());

async function identity(claims: Record<string, unknown>, linkStartedAt?: number) {
  h.claims = { iss: ISSUER, sub: 'sub-1', ...claims };
  const { identityFromCallback, forgetProviderConfig } = await import('./provider');
  const { oidcSettings } = await import('./settings');
  forgetProviderConfig();
  const s = oidcSettings();
  if (s.mode === 'off') throw new Error('test settings are off');
  return identityFromCallback(
    s,
    new URLSearchParams({ code: 'c', state: 's' }),
    flow,
    linkStartedAt === undefined ? {} : { linkStartedAt },
  );
}

describe("a link's sign-in at the provider", () => {
  it('is refused when the provider says it is older than the link', async () => {
    await expect(identity({ auth_time: NOW - 3600 }, NOW)).rejects.toThrow(/older than the link/);
  });

  it('passes when it is fresh (within the clock skew too)', async () => {
    await expect(identity({ auth_time: NOW + 2 }, NOW)).resolves.toMatchObject({
      subject: 'sub-1',
    });
    await expect(identity({ auth_time: NOW - 30 }, NOW)).resolves.toMatchObject({
      subject: 'sub-1',
    });
  });

  it('passes when the provider sends no auth_time (asked, not proven)', async () => {
    await expect(identity({}, NOW)).resolves.toMatchObject({ subject: 'sub-1' });
  });

  it('a sign-in flow asks nothing of auth_time', async () => {
    await expect(identity({ auth_time: NOW - 86_400 })).resolves.toMatchObject({
      subject: 'sub-1',
    });
  });
});
