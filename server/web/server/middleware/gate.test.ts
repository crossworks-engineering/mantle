import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gate } from './gate';

const SECRET = 's'.repeat(48);

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Mint a token in the app's signed format: b64url(payload).b64url(hmac). */
function mint(payload: Record<string, unknown>, secret = SECRET): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

const future = () => Math.floor(Date.now() / 1000) + 3600;
const past = () => Math.floor(Date.now() / 1000) - 3600;

function makeApp() {
  const app = new Hono();
  app.use('*', gate());
  app.get('/api/notes', (c) => c.json({ ok: true }));
  app.get('/api/version', (c) => c.json({ v: 'test' })); // PUBLIC_PATHS entry
  app.get('/api/auth/me', (c) => c.json({ me: true })); // public prefix
  app.get('/api/files/files/f1', (c) => c.json({ bytes: true }));
  app.get('/api/attachments/a1', (c) => c.json({ bytes: true }));
  app.get('/s/tok123/bundle', (c) => c.json({ broker: true }));
  app.get('/settings', (c) => c.text('page'));
  return app;
}

const env = process.env;
beforeEach(() => {
  process.env = { ...env, SESSION_SECRET: SECRET };
  delete process.env.MANTLE_API_CORS_ORIGINS;
  delete process.env.MANTLE_DETACHED_DEV;
});
afterEach(() => {
  process.env = env;
});

describe('gate: session & bearer', () => {
  it('lets public paths through without any credential', async () => {
    const app = makeApp();
    expect((await app.request('/api/version')).status).toBe(200);
    expect((await app.request('/api/auth/me')).status).toBe(200);
  });

  it('401s /api without a credential (JSON, no-store)', async () => {
    const res = await makeApp().request('/api/notes');
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('accepts a valid kindless session cookie', async () => {
    const res = await makeApp().request('/api/notes', {
      headers: { cookie: `mantle_session=${mint({ exp: future() })}` },
    });
    expect(res.status).toBe(200);
  });

  it('rejects expired, tampered, and kinded cookies', async () => {
    const app = makeApp();
    for (const bad of [
      mint({ exp: past() }),
      mint({ exp: future() }) + 'x',
      mint({ exp: future() }, 'w'.repeat(48)),
      mint({ exp: future(), k: 'm' }), // mobile token reused as cookie
      mint({ exp: future(), k: 'a' }), // asset token reused as cookie
      'garbage',
    ]) {
      const res = await app.request('/api/notes', { headers: { cookie: `mantle_session=${bad}` } });
      expect(res.status, bad).toBe(401);
    }
  });

  it("accepts a k:'m' bearer; 401s any other bearer without redirect", async () => {
    const app = makeApp();
    const ok = await app.request('/api/notes', {
      headers: { authorization: `Bearer ${mint({ exp: future(), k: 'm' })}` },
    });
    expect(ok.status).toBe(200);

    for (const bad of [mint({ exp: future() }), mint({ exp: past(), k: 'm' }), 'junk']) {
      const res = await app.request('/settings', {
        headers: { authorization: `Bearer ${bad}` },
      });
      expect(res.status, bad).toBe(401); // API-style 401 even on a page path
    }
  });

  it("accepts ?at= asset tokens only on asset paths, GET only, kind 'a' only", async () => {
    const app = makeApp();
    const at = mint({ exp: future(), k: 'a' });
    expect((await app.request(`/api/files/files/f1?at=${at}`)).status).toBe(200);
    expect((await app.request(`/api/attachments/a1?at=${at}`)).status).toBe(200);
    // Wrong path
    expect((await app.request(`/api/notes?at=${at}`)).status).toBe(401);
    // Wrong kind
    const m = mint({ exp: future(), k: 'm' });
    expect((await app.request(`/api/files/files/f1?at=${m}`)).status).toBe(401);
  });

  it('redirects an uncredentialed page nav to /login?next= via proxy headers', async () => {
    const res = await makeApp().request('https://internal:3000/settings', {
      headers: { 'x-forwarded-host': 'brain.example.com', 'x-forwarded-proto': 'https' },
    });
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://brain.example.com/login?next=%2Fsettings');
  });

  it('500s everything when SESSION_SECRET is missing/short (except public)', async () => {
    process.env.SESSION_SECRET = 'short';
    const app = makeApp();
    expect((await app.request('/api/notes')).status).toBe(500);
    expect((await app.request('/api/version')).status).toBe(200);
  });

  it('lets page navs through in detached dev; APIs still 401', async () => {
    process.env.MANTLE_DETACHED_DEV = '1';
    const app = makeApp();
    expect((await app.request('/settings')).status).toBe(200);
    expect((await app.request('/api/notes')).status).toBe(401);
  });
});

describe('gate: CORS', () => {
  const ORIGIN = 'http://localhost:3901';

  it('emits no CORS headers when unconfigured', async () => {
    const res = await makeApp().request('/api/version', { headers: { origin: ORIGIN } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers preflight 204 with CORS before auth', async () => {
    process.env.MANTLE_API_CORS_ORIGINS = ORIGIN;
    const res = await makeApp().request('/api/notes', {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('access-control-allow-headers')).toContain('Idempotency-Key');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('reflects allowlisted origins on responses, including 401s', async () => {
    process.env.MANTLE_API_CORS_ORIGINS = ORIGIN;
    const app = makeApp();
    const ok = await app.request('/api/version', { headers: { origin: ORIGIN } });
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(ok.headers.get('vary')).toContain('Origin');
    const unauth = await app.request('/api/notes', { headers: { origin: ORIGIN } });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it("wildcard reflects any origin on data APIs but NEVER on credential-minting paths", async () => {
    process.env.MANTLE_API_CORS_ORIGINS = '*';
    const app = makeApp();
    const data = await app.request('/api/version', { headers: { origin: 'https://any.example' } });
    expect(data.headers.get('access-control-allow-origin')).toBe('https://any.example');
    for (const path of ['/api/auth/me', '/api/team/auth', '/api/team/sso']) {
      const res = await app.request(path, { headers: { origin: 'https://any.example' } });
      expect(res.headers.get('access-control-allow-origin'), path).toBeNull();
    }
  });

  it('treats the /s app brokers as CORS-eligible, other /s paths not', async () => {
    process.env.MANTLE_API_CORS_ORIGINS = ORIGIN;
    const app = makeApp();
    const broker = await app.request('/s/tok123/bundle', { headers: { origin: ORIGIN } });
    expect(broker.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const pre = await app.request('/s/tok123/bundle', {
      method: 'OPTIONS',
      headers: { origin: ORIGIN },
    });
    expect(pre.status).toBe(204);
  });
});
