/**
 * OAuth2 client-credentials token fetch, against a mock token server on
 * loopback: the request shape (RFC 6749 §4.4 + §2.3.1), the in-memory cache,
 * single-flight, expiry with a safety margin, the 401 stale-token refresh,
 * and that no error ever carries the client id, the secret or a raw body.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { ToolGroupOauth2 } from '@mantle/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearClientCredentialsCache,
  getClientCredentialsToken,
  tokenLifetimeMs,
} from './oauth2-client-credentials';

// The SSRF guard is covered by ssrf-guard.test.ts; here it must let loopback in.
const allowLoopback = async () => {};

const CLIENT_ID = 'client-abc';
const CLIENT_SECRET = 's3cr3t+/=&value';

type Seen = { auth: string | undefined; contentType: string | undefined; form: URLSearchParams };
const seen: Seen[] = [];
let respond: (req: Seen) => { status: number; body: string; delayMs?: number } = () => ({
  status: 200,
  body: JSON.stringify({ access_token: 'tok-1', token_type: 'Bearer', expires_in: 3600 }),
});

let server: Server;
let tokenUrl = '';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res) => {
    let data = '';
    req.on('data', (c: Buffer) => (data += c.toString('utf8')));
    req.on('end', () => res(data));
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const s: Seen = {
      auth: req.headers.authorization,
      contentType: req.headers['content-type'],
      form: new URLSearchParams(await readBody(req)),
    };
    seen.push(s);
    const out = respond(s);
    if (out.delayMs) await new Promise((r) => setTimeout(r, out.delayMs));
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(out.body);
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  tokenUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/oauth/token`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  seen.length = 0;
  clearClientCredentialsCache();
  respond = () => ({
    status: 200,
    body: JSON.stringify({ access_token: 'tok-1', token_type: 'Bearer', expires_in: 3600 }),
  });
});

function config(over: Partial<ToolGroupOauth2> = {}): ToolGroupOauth2 {
  return {
    grant: 'client_credentials',
    tokenUrl,
    clientIdRef: 'svc/client-id',
    clientSecretRef: 'svc/client-secret',
    ...over,
  };
}

function request(over: Partial<Parameters<typeof getClientCredentialsToken>[0]> = {}) {
  return {
    ownerId: 'o1',
    groupSlug: 'g1',
    config: config(),
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    ...over,
  };
}

describe('getClientCredentialsToken', () => {
  it('posts grant_type=client_credentials with HTTP Basic client auth', async () => {
    const token = await getClientCredentialsToken(
      request({ config: config({ scope: 'read write', audience: 'api://x' }) }),
      { guard: allowLoopback },
    );
    expect(token).toBe('tok-1');
    expect(seen).toHaveLength(1);
    const s = seen[0]!;
    expect(s.contentType).toBe('application/x-www-form-urlencoded');
    expect(s.form.get('grant_type')).toBe('client_credentials');
    expect(s.form.get('scope')).toBe('read write');
    expect(s.form.get('audience')).toBe('api://x');
    expect(s.form.get('client_secret')).toBeNull();
    // §2.3.1: each part form-urlencoded, then base64 of "id:secret".
    const decoded = Buffer.from(s.auth!.replace(/^Basic /, ''), 'base64').toString('utf8');
    expect(decoded).toBe(`${encodeURIComponent(CLIENT_ID)}:${encodeURIComponent(CLIENT_SECRET)}`);
  });

  it("sends the credentials in the form body when client_auth is 'body'", async () => {
    await getClientCredentialsToken(request({ config: config({ clientAuth: 'body' }) }), {
      guard: allowLoopback,
    });
    const s = seen[0]!;
    expect(s.auth).toBeUndefined();
    expect(s.form.get('client_id')).toBe(CLIENT_ID);
    expect(s.form.get('client_secret')).toBe(CLIENT_SECRET);
  });

  it('caches the token until the safety margin before expiry', async () => {
    let t = 1_000_000;
    const deps = { guard: allowLoopback, now: () => t };
    expect(await getClientCredentialsToken(request(), deps)).toBe('tok-1');
    respond = () => ({
      status: 200,
      body: JSON.stringify({ access_token: 'tok-2', expires_in: 3600 }),
    });
    expect(await getClientCredentialsToken(request(), deps)).toBe('tok-1');
    expect(seen).toHaveLength(1);
    // 3600 s lifetime, 60 s margin: still cached just inside it, refetched after.
    t += 3_539_000;
    expect(await getClientCredentialsToken(request(), deps)).toBe('tok-1');
    t += 2_000;
    expect(await getClientCredentialsToken(request(), deps)).toBe('tok-2');
    expect(seen).toHaveLength(2);
  });

  it('runs one token fetch for many parallel callers (single-flight)', async () => {
    respond = () => ({
      status: 200,
      body: JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }),
      delayMs: 50,
    });
    const all = await Promise.all(
      Array.from({ length: 8 }, () =>
        getClientCredentialsToken(request(), { guard: allowLoopback }),
      ),
    );
    expect(new Set(all)).toEqual(new Set(['tok-1']));
    expect(seen).toHaveLength(1);
  });

  it('misses the cache when the secret is rotated or the scope changes', async () => {
    const deps = { guard: allowLoopback };
    await getClientCredentialsToken(request(), deps);
    await getClientCredentialsToken(request({ clientSecret: 'rotated' }), deps);
    await getClientCredentialsToken(request({ config: config({ scope: 'other' }) }), deps);
    await getClientCredentialsToken(request({ groupSlug: 'g2' }), deps);
    expect(seen).toHaveLength(4);
  });

  it('replaces a token the API rejected, but reuses one another caller already refreshed', async () => {
    const deps = { guard: allowLoopback };
    expect(await getClientCredentialsToken(request(), deps)).toBe('tok-1');
    respond = () => ({
      status: 200,
      body: JSON.stringify({ access_token: 'tok-2', expires_in: 3600 }),
    });
    // The cached token got a 401: fetch a new one.
    expect(await getClientCredentialsToken(request({ staleToken: 'tok-1' }), deps)).toBe('tok-2');
    // A late caller still holding tok-1 gets tok-2 without another fetch.
    expect(await getClientCredentialsToken(request({ staleToken: 'tok-1' }), deps)).toBe('tok-2');
    expect(seen).toHaveLength(2);
  });

  it('passes on only the OAuth error fields, scrubbed, never the raw body', async () => {
    respond = () => ({
      status: 401,
      body: JSON.stringify({
        error: 'invalid_client',
        error_description: `bad secret ${CLIENT_SECRET} for ${CLIENT_ID}`,
        debug: 'RAW-BODY-MARKER',
      }),
    });
    const err = await getClientCredentialsToken(request(), { guard: allowLoopback }).catch(
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain('HTTP 401');
    expect(msg).toContain('invalid_client');
    expect(msg).not.toContain(CLIENT_SECRET);
    expect(msg).not.toContain(CLIENT_ID);
    expect(msg).not.toContain('RAW-BODY-MARKER');
  });

  it('does not cache a failure', async () => {
    respond = () => ({ status: 500, body: 'oops' });
    await expect(getClientCredentialsToken(request(), { guard: allowLoopback })).rejects.toThrow(
      /HTTP 500/,
    );
    respond = () => ({ status: 200, body: JSON.stringify({ access_token: 'tok-ok' }) });
    expect(await getClientCredentialsToken(request(), { guard: allowLoopback })).toBe('tok-ok');
  });

  it('refuses a response with no access_token (a login page, say)', async () => {
    respond = () => ({ status: 200, body: '<html>sign in</html>' });
    await expect(getClientCredentialsToken(request(), { guard: allowLoopback })).rejects.toThrow(
      /without an access_token/,
    );
  });

  it('refuses a non-bearer token type', async () => {
    respond = () => ({
      status: 200,
      body: JSON.stringify({ access_token: 'tok-1', token_type: 'mac' }),
    });
    await expect(getClientCredentialsToken(request(), { guard: allowLoopback })).rejects.toThrow(
      /only bearer tokens/,
    );
  });

  it('applies the egress guard to the token URL', async () => {
    const refuse = async () => {
      throw new Error('blocked private address');
    };
    await expect(getClientCredentialsToken(request(), { guard: refuse })).rejects.toThrow(
      /could not reach .*blocked private address/,
    );
    expect(seen).toHaveLength(0);
  });
});

describe('tokenLifetimeMs', () => {
  it('takes a tenth off as margin, capped at a minute', () => {
    expect(tokenLifetimeMs(3600)).toBe(3_540_000);
    expect(tokenLifetimeMs(100)).toBe(90_000);
    expect(tokenLifetimeMs('300')).toBe(270_000);
  });
  it('assumes five minutes when expires_in is missing or junk, and caps at a day', () => {
    expect(tokenLifetimeMs(undefined)).toBe(270_000);
    expect(tokenLifetimeMs(-5)).toBe(270_000);
    expect(tokenLifetimeMs(10 * 86_400)).toBe(86_400_000 - 60_000);
  });
});
