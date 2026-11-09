/**
 * The setup screen's Test and status (sso-setup.ts), against a stand-in
 * provider on a loopback port, through the real library: each answer the
 * provider can give, and the one code the screen reads. What a stand-in cannot
 * prove: how Entra itself answers (the IT box test reports that).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as client from 'openid-client';
import { errorMessage } from '@mantle/std';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  readFails: false,
  discovery: 'ok' as 'ok' | '401' | '404' | 'html' | 'bad-json' | 'other-issuer',
  token: 'ok' as 'ok' | '401' | '401-plain' | 'invalid_client' | '400' | '500' | '302' | 'bad-json',
  tokenBodies: [] as string[],
  tokenEndpoint: null as string | null,
}));

vi.mock('./store', () => ({
  ssoSetupRow: async () => {
    if (h.readFails) throw new Error('the database is gone');
    return h.row;
  },
  oidcLoginRow: async () => ({ email: 'admin@example.invalid' }),
}));

const { seal } = await import('@mantle/crypto');
const { SSO_SECRET_AAD } = await import('@mantle/db');
const { discoveryFailure, issuerAgrees, ssoSetupStatus, ssoSetupTest, tokenFailure } =
  await import('./sso-setup');
const { forgetProviderConfig, oidcClientSecret, providerConfig } = await import('./provider');

const SECRET = 'the-row-secret-value';
const PROVIDER_TEXT = 'AADSTS-PROVIDER-TEXT-MUST-NOT-TRAVEL';
let server: Server;
let issuer = '';

beforeAll(async () => {
  vi.stubEnv('MANTLE_MASTER_KEY', Buffer.alloc(32, 7).toString('base64'));
  server = createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url?.endsWith('/.well-known/openid-configuration')) {
      if (h.discovery === '401') return json(401, { error: 'no' });
      if (h.discovery === '404') return json(404, {});
      if (h.discovery === 'html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<html></html>');
      }
      if (h.discovery === 'bad-json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{');
      }
      return json(200, {
        issuer: h.discovery === 'other-issuer' ? `${issuer}/other` : issuer,
        authorization_endpoint: `${issuer}/auth`,
        token_endpoint: h.tokenEndpoint ?? `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      });
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      h.tokenBodies.push(body);
      const t = h.token;
      if (t === 'ok') return json(200, { access_token: 'a', token_type: 'bearer' });
      if (t === '401')
        return json(401, { error: 'invalid_client', error_description: PROVIDER_TEXT });
      if (t === '401-plain') {
        res.writeHead(401, { 'content-type': 'text/plain' });
        return res.end(PROVIDER_TEXT);
      }
      if (t === 'invalid_client') {
        return json(400, { error: 'invalid_client', error_description: PROVIDER_TEXT });
      }
      if (t === '400') {
        return json(400, { error: 'unauthorized_client', error_description: PROVIDER_TEXT });
      }
      if (t === '500') return json(500, { error: 'server_error' });
      if (t === 'bad-json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{');
      }
      res.writeHead(302, { location: 'https://elsewhere.example.invalid/steal' });
      return res.end();
    });
    return undefined;
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/realm`;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  // SCIM runs on a Control Center only (docs/control-center.md).
  vi.stubEnv('MANTLE_IS_CONTROL_CENTER', 'on');
  vi.stubEnv('MANTLE_MASTER_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubEnv('MANTLE_OIDC_MODE', 'setup');
  vi.stubEnv('MANTLE_OIDC_ISSUER', issuer);
  vi.stubEnv('MANTLE_OIDC_CLIENT_ID', 'mantle');
  vi.stubEnv('MANTLE_OIDC_CLIENT_SECRET', '');
  vi.stubEnv('MANTLE_PUBLIC_URL', 'https://brain.example.invalid');
  vi.stubEnv('MANTLE_SCIM_TOKEN_HASH', '');
  h.row = { secretEnc: seal(SECRET, SSO_SECRET_AAD).ciphertext };
  h.readFails = false;
  h.discovery = 'ok';
  h.token = 'ok';
  h.tokenBodies = [];
  h.tokenEndpoint = null;
  forgetProviderConfig();
});
afterEach(() => vi.unstubAllEnvs());

describe('the Test', () => {
  it('ok: sends the row secret in the POST body, with no scope off Entra', async () => {
    expect(await ssoSetupTest()).toBe('ok');
    const sent = new URLSearchParams(h.tokenBodies[0]);
    expect(sent.get('client_id')).toBe('mantle');
    expect(sent.get('client_secret')).toBe(SECRET);
    expect(sent.get('grant_type')).toBe('client_credentials');
    expect(sent.has('scope')).toBe(false);
  });

  it('a secret in the .env wins over the row', async () => {
    vi.stubEnv('MANTLE_OIDC_CLIENT_SECRET', 'the-env-secret');
    expect(await ssoSetupTest()).toBe('ok');
    expect(new URLSearchParams(h.tokenBodies[0]).get('client_secret')).toBe('the-env-secret');
  });

  it.each([
    ['401', 'secret-refused'],
    ['401-plain', 'secret-refused'],
    ['invalid_client', 'secret-refused'],
    ['400', 'unclear'],
    ['500', 'unclear'],
    ['302', 'unclear'],
  ] as const)('a token answer of %s reads %s, and calls nothing else', async (token, want) => {
    h.token = token;
    expect(await ssoSetupTest()).toBe(want);
    expect(h.tokenBodies).toHaveLength(1);
  });

  it('a token answer the library cannot read tells the admin to look at the provider', async () => {
    h.token = 'bad-json';
    expect(['unclear', 'unreachable']).toContain(await ssoSetupTest());
  });

  // No secret was sent at discovery, so a status there says nothing of it.
  it.each(['401', '404', 'html', 'bad-json'] as const)(
    'a discovery answer of %s reads unreachable, and sends no secret',
    async (discovery) => {
      h.discovery = discovery;
      expect(await ssoSetupTest()).toBe('unreachable');
      expect(h.tokenBodies).toEqual([]);
    },
  );

  it('a document naming another issuer reads issuer-mismatch, and sends no secret', async () => {
    h.discovery = 'other-issuer';
    expect(await ssoSetupTest()).toBe('issuer-mismatch');
    expect(h.tokenBodies).toEqual([]);
  });

  it('nobody listening reads unreachable', async () => {
    vi.stubEnv('MANTLE_OIDC_ISSUER', 'http://127.0.0.1:9/realm');
    expect(await ssoSetupTest()).toBe('unreachable');
  });

  it('a token endpoint nobody listens on reads unreachable, through the real library', async () => {
    h.tokenEndpoint = 'http://127.0.0.1:9/token';
    expect(await ssoSetupTest()).toBe('unreachable');
  });

  it('a missing .env line reads env-missing, with no read', async () => {
    vi.stubEnv('MANTLE_OIDC_CLIENT_ID', '');
    h.readFails = true;
    expect(await ssoSetupTest()).toBe('env-missing');
  });

  it('no secret anywhere reads no-secret, and calls no provider', async () => {
    h.row = null;
    expect(await ssoSetupTest()).toBe('no-secret');
    expect(h.tokenBodies).toEqual([]);
  });

  it('a read that fails reads secret-unreadable', async () => {
    h.readFails = true;
    expect(await ssoSetupTest()).toBe('secret-unreadable');
  });

  it('a secret the key cannot open reads secret-unreadable, and sends nothing', async () => {
    h.row = { secretEnc: seal(SECRET, 'another:binding').ciphertext };
    expect(await ssoSetupTest()).toBe('secret-unreadable');
    expect(h.tokenBodies).toEqual([]);
  });

  it('a fix shows at once: the next Test uses the new secret', async () => {
    h.token = '401';
    expect(await ssoSetupTest()).toBe('secret-refused');
    h.token = 'ok';
    h.row = { secretEnc: seal('a-new-secret', SSO_SECRET_AAD).ciphertext };
    expect(await ssoSetupTest()).toBe('ok');
    expect(new URLSearchParams(h.tokenBodies[1]).get('client_secret')).toBe('a-new-secret');
  });
});

describe('how a failure reads', () => {
  it('a discovery failure is unreachable, whatever status it holds', () => {
    expect(discoveryFailure({ cause: { status: 401 } })).toBe('unreachable');
    expect(discoveryFailure(new TypeError('fetch failed'))).toBe('unreachable');
    expect(discoveryFailure({ code: 'OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED' })).toBe(
      'issuer-mismatch',
    );
  });

  it('a token failure with no status is unreachable, whatever its type', () => {
    expect(tokenFailure(new TypeError('fetch failed'))).toBe('unreachable');
    expect(tokenFailure(new Error('connection refused'))).toBe('unreachable');
    expect(tokenFailure(null)).toBe('unreachable');
    expect(tokenFailure({ status: 401 })).toBe('secret-refused');
    expect(tokenFailure({ cause: { status: 401 } })).toBe('secret-refused');
    expect(tokenFailure({ status: 400, error: 'invalid_client' })).toBe('secret-refused');
    expect(tokenFailure({ status: 400, error: 'invalid_scope' })).toBe('unclear');
    expect(tokenFailure({ cause: { status: 503 } })).toBe('unclear');
  });

  it('the issuer check keeps a real sign-in rule: one trailing slash is no difference', () => {
    const entra = 'https://login.microsoftonline.com/7d8b2c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f/v2.0';
    expect(issuerAgrees(entra, entra)).toBe(true);
    expect(issuerAgrees(`${entra}/`, entra)).toBe(true);
    expect(issuerAgrees(entra.replace('7d8b', '0000'), entra)).toBe(false);
  });

  // The flow logs errorMessage(err) (flow.ts): the provider's own text stays
  // in error_description and cause, and is never printed.
  it.each(['401', '401-plain', 'invalid_client', '400'] as const)(
    'a provider answer of %s puts none of its text in the message',
    async (token) => {
      h.token = token;
      const config = await providerConfig({
        mode: 'optional',
        issuer,
        clientId: 'mantle',
        clientSecret: SECRET,
        label: 'x',
        sessionSeconds: 1,
        redirectUri: 'https://brain.example.invalid/cb',
        outsideAllowed: true,
      });
      const err = await client.clientCredentialsGrant(config, {}).catch((e: unknown) => e);
      expect(errorMessage(err)).not.toContain(PROVIDER_TEXT);
      expect(errorMessage(err)).not.toContain(SECRET);
    },
  );
});

describe('the secret read', () => {
  const on = (clientSecret: string | null) =>
    ({
      mode: 'optional',
      issuer,
      clientId: 'mantle',
      clientSecret,
      label: 'x',
      sessionSeconds: 1,
      redirectUri: 'https://brain.example.invalid/cb',
      outsideAllowed: true,
    }) as const;

  it('.env first, with no read; then the row; then a public client', async () => {
    h.readFails = true;
    expect(await oidcClientSecret(on('from-env'))).toBe('from-env');
    h.readFails = false;
    expect(await oidcClientSecret(on(null))).toBe(SECRET);
    h.row = null;
    expect(await oidcClientSecret(on(null))).toBeNull();
    h.row = { secretEnc: null };
    expect(await oidcClientSecret(on(null))).toBeNull();
  });

  it('a new secret finds a new client: the discovery cache is keyed on it', async () => {
    const first = await providerConfig(on(null));
    expect(await providerConfig(on(null))).toBe(first);
    h.row = { secretEnc: seal('a-new-secret', SSO_SECRET_AAD).ciphertext };
    const second = await providerConfig(on(null));
    expect(second).not.toBe(first);
    await client.clientCredentialsGrant(second, {});
    expect(new URLSearchParams(h.tokenBodies.at(-1)).get('client_secret')).toBe('a-new-secret');
  });

  it('a failed read or open rejects providerConfig: never a public client', async () => {
    h.readFails = true;
    await expect(providerConfig(on(null))).rejects.toThrow('the database is gone');
    h.readFails = false;
    h.row = { secretEnc: Buffer.from('not sealed at all, not sealed at all') };
    await expect(providerConfig(on(null))).rejects.toThrow();
  });
});

describe('the status', () => {
  it('holds no value of the secret, and names what is missing', async () => {
    vi.stubEnv('MANTLE_OIDC_CLIENT_ID', '');
    h.row = {
      secretEnc: seal(SECRET, SSO_SECRET_AAD).ciphertext,
      secretSetBy: '00000000-0000-4000-8000-000000000001',
      secretSetAt: new Date('2026-11-06T00:00:00Z'),
      scimTokenHash: 'ab'.repeat(32),
      scimSetBy: null,
      scimSetAt: new Date('2026-11-06T00:00:00Z'),
    };
    const status = await ssoSetupStatus();
    expect(status).toMatchObject({
      mode: 'setup',
      clientId: '',
      redirectUri: 'https://brain.example.invalid/api/auth/oidc/callback',
      scimUrl: 'https://brain.example.invalid/scim/v2',
      envMissing: ['MANTLE_OIDC_CLIENT_ID'],
      secret: 'row',
      scim: 'row',
      secretSet: { by: 'admin@example.invalid', at: '2026-11-06T00:00:00.000Z' },
      scimSet: { by: null, at: '2026-11-06T00:00:00.000Z' },
    });
    const text = JSON.stringify(status);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('ab'.repeat(32));
  });

  it('the .env wins, and a stop reads env-off', async () => {
    vi.stubEnv('MANTLE_OIDC_CLIENT_SECRET', 'from-env');
    vi.stubEnv('MANTLE_SCIM_TOKEN_HASH', 'cd'.repeat(32));
    expect(await ssoSetupStatus()).toMatchObject({ secret: 'env', scim: 'env' });
    vi.stubEnv('MANTLE_SCIM_TOKEN_HASH', 'off');
    expect(await ssoSetupStatus()).toMatchObject({ scim: 'env-off' });
    expect(JSON.stringify(await ssoSetupStatus())).not.toContain('from-env');
  });

  it('a missing public URL leaves both URLs empty, and is named', async () => {
    vi.stubEnv('MANTLE_PUBLIC_URL', '');
    expect(await ssoSetupStatus()).toMatchObject({
      redirectUri: '',
      scimUrl: '',
      envMissing: ['MANTLE_PUBLIC_URL'],
    });
  });

  it('off a Control Center: not-cc, no SCIM URL and no setter, whatever the .env holds', async () => {
    vi.stubEnv('MANTLE_IS_CONTROL_CENTER', '');
    vi.stubEnv('MANTLE_SCIM_TOKEN_HASH', 'cd'.repeat(32));
    h.row = { scimTokenHash: 'ab'.repeat(32), scimSetAt: new Date('2026-11-06T00:00:00Z') };
    expect(await ssoSetupStatus()).toMatchObject({ scim: 'not-cc', scimUrl: '', scimSet: null });
  });

  it('a row value that is no sha256 reads none, as SCIM itself does', async () => {
    h.row = { scimTokenHash: 'abc' };
    expect(await ssoSetupStatus()).toMatchObject({ scim: 'none' });
  });

  it('a public URL that is no URL leaves the redirect empty, and does not throw', async () => {
    vi.stubEnv('MANTLE_PUBLIC_URL', 'https://');
    expect(await ssoSetupStatus()).toMatchObject({ redirectUri: '' });
  });
});
