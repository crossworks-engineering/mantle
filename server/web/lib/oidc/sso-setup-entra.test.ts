/**
 * The Test's own issuer check and scope on Entra's host (sso-setup.ts). The
 * library skips its issuer check on that host (handleEntraId), and a stand-in
 * provider cannot run on it, so the library's calls are stood in here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TENANT = '7d8b2c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const h = vi.hoisted(() => ({ document: '', grant: 0, scope: undefined as string | undefined }));

vi.mock('./store', () => ({ ssoSetupRow: async () => null, oidcLoginRow: async () => null }));

vi.mock('openid-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  discovery: async () => ({ serverMetadata: () => ({ issuer: h.document }) }),
  clientCredentialsGrant: async (_c: unknown, params: { scope?: string }) => {
    h.grant += 1;
    h.scope = params.scope;
    return { access_token: 'a' };
  },
}));

const { ssoSetupTest } = await import('./sso-setup');

beforeEach(() => {
  vi.stubEnv('MANTLE_OIDC_MODE', 'setup');
  vi.stubEnv('MANTLE_OIDC_ISSUER', ISSUER);
  vi.stubEnv('MANTLE_OIDC_CLIENT_ID', 'the-client');
  vi.stubEnv('MANTLE_OIDC_CLIENT_SECRET', 'from-env');
  vi.stubEnv('MANTLE_PUBLIC_URL', 'https://brain.example.invalid');
  h.grant = 0;
  h.scope = undefined;
});
afterEach(() => vi.unstubAllEnvs());

describe('the Test on Entra', () => {
  it('asks the client id .default scope', async () => {
    h.document = ISSUER;
    expect(await ssoSetupTest()).toBe('ok');
    expect(h.scope).toBe('the-client/.default');
  });

  it('a document naming another tenant reads issuer-mismatch, and sends no secret', async () => {
    h.document = ISSUER.replace('7d8b', '0000');
    expect(await ssoSetupTest()).toBe('issuer-mismatch');
    expect(h.grant).toBe(0);
  });
});
