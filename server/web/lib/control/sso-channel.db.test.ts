/**
 * Company sign-in from the Control Center through the real app (createApp:
 * the gate, the signed route) on a real migrated Postgres
 * (docs/control-center.md, "The admin channel"; docs/oidc-sign-in.md). One
 * database plays both sides, as in tool-channel.db.test.ts: the CC rows and
 * the box. A stand-in provider on a loopback port answers the Test.
 *
 *  - scope none refuses all three cases, with no row made;
 *  - the mode word off refuses a save; names only while it is setup;
 *  - the CC stages tenant, client id and secret: sealed in the CC row until
 *    sent, sealed with the box's own key on the box, no value in any
 *    answer, audit row or CC row after the send;
 *  - a .env line wins over the row;
 *  - in an on mode a new secret is saved only when its Test answers ok;
 *  - a changed client id clears a secret the save does not replace;
 *  - a replay is refused; a box a release behind answers bad-call;
 *  - the boot read: required with the row's names is on, without them stops.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/web/lib/control/sso-channel.db.test.ts
 */
import { generateKeyPairSync, createPublicKey, randomUUID, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createMigratedScratchDatabase,
  ensureTestAnchor,
  superuserClient,
} from '@mantle/db/test-support';
import { publicKeyLine, signCall } from './sign';

type Egress = (
  input: unknown,
  init?: RequestInit,
  opts?: Record<string, unknown>,
) => Promise<Response>;
const egress = vi.hoisted(() => ({ handle: null as null | Egress }));
vi.mock('@mantle/std/egress', async (orig) => ({
  ...(await orig<typeof import('@mantle/std/egress')>()),
  egressFetch: (input: unknown, init?: RequestInit, opts?: Record<string, unknown>) =>
    egress.handle!(input, init, opts),
}));

vi.hoisted(() => {
  process.env.MANTLE_MASTER_KEY_NEXT ??= Buffer.alloc(32, 9).toString('base64');
});

const URL_ = process.env.MANTLE_TEST_DATABASE_URL;
type Row = Record<string, unknown>;
const BOX = 'https://brain.example.invalid';
const TENANT = '11111111-2222-4333-8444-555555555555';
const CLIENT = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const CLIENT_2 = '66666666-7777-4888-9999-bbbbbbbbbbbb';
const SECRET = `cc-secret-${randomUUID()}`;
const GOOD = `good-secret-${randomUUID()}`;
const BAD = `bad-secret-${randomUUID()}`;
const ENV_KEYS = [
  'MANTLE_CONTROL_CENTER',
  'MANTLE_CONTROL_CENTER_KEY',
  'MANTLE_CONTROL_CENTER_SCOPE',
  'MANTLE_PUBLIC_URL',
  'MANTLE_OIDC_MODE',
  'MANTLE_OIDC_ISSUER',
  'MANTLE_OIDC_CLIENT_ID',
  'MANTLE_OIDC_CLIENT_SECRET',
];

describe.skipIf(!URL_)('company sign-in from the Control Center', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let m: typeof import('@mantle/db');
  let cc: typeof import('@mantle/db/control-center');
  let config: typeof import('@mantle/config');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let app: import('hono').Hono;
  let run: typeof import('./run');
  let key: KeyObject;
  let provider: Server;
  let issuer = '';
  let ip = 0;
  let boxId = '';
  /** The box answers: the app, or a box a release behind. */
  let behind = false;

  const sealer = async () => {
    const { seal } = await import('@mantle/crypto');
    return (plain: string, aad: string) => seal(plain, aad).ciphertext.toString('base64');
  };
  const signedBody = (obj: unknown) => {
    const body = Buffer.from(JSON.stringify(obj));
    return { body, headers: signCall(key, BOX, body) };
  };
  const post = (s: { body: Buffer; headers: Record<string, string> }) =>
    Promise.resolve(
      app.request('/api/control/call', {
        method: 'POST',
        body: new Uint8Array(s.body),
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': `198.51.100.${(ip += 1) % 250}`,
          'x-forwarded-proto': 'https',
          ...s.headers,
        },
      }),
    );
  const signed = async (obj: unknown) => (await (await post(signedBody(obj))).json()) as Row;
  const set = (args: Row) =>
    signed({ op: 'sso_set', args: { nonce: randomUUID(), by: 'it@example.com', ...args } });
  const row = async () => (await sql<Row[]>`select * from sso_setup`)[0] ?? null;
  const opened = async () => {
    const r = await row();
    if (!r?.secret_enc) return null;
    const { open } = await import('@mantle/crypto');
    return open(r.secret_enc as Buffer, m.SSO_SECRET_AAD);
  };
  const env = (vals: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(vals)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  beforeAll(async () => {
    provider = createServer((req, res) => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url?.endsWith('/.well-known/openid-configuration')) {
        return send(200, {
          issuer,
          authorization_endpoint: `${issuer}/auth`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        });
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (body.includes(encodeURIComponent(GOOD))) {
          return send(200, { access_token: 'a', token_type: 'bearer' });
        }
        return send(401, { error: 'invalid_client' });
      });
      return undefined;
    });
    await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
    issuer = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/realm`;

    scratch = await createMigratedScratchDatabase(URL_!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'control-sso-db-test-secret-at-least-32';
    for (const k of ENV_KEYS) delete process.env[k];
    env({ MANTLE_PUBLIC_URL: `${BOX}/`, MANTLE_IS_CONTROL_CENTER: undefined });
    key = generateKeyPairSync('ed25519').privateKey;
    process.env.MANTLE_CONTROL_CENTER = 'https://cc.example.invalid';
    process.env.MANTLE_CONTROL_CENTER_KEY = publicKeyLine(createPublicKey(key));
    m = await import('@mantle/db');
    cc = await import('@mantle/db/control-center');
    config = await import('@mantle/config');
    sql = superuserClient(scratch.url) as unknown as typeof sql;
    await ensureTestAnchor(sql);
    const { createApp } = await import('../../server/app');
    app = await createApp();
    run = await import('./run');
    egress.handle = async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(BOX);
      if (behind) {
        // An older box: its switch has no sso_* case.
        const op = (JSON.parse(Buffer.from(init!.body as Buffer).toString('utf8')) as Row).op;
        if (String(op).startsWith('sso_')) {
          return new Response(JSON.stringify({ error: 'refused', reason: 'bad-call' }), {
            status: 400,
          });
        }
      }
      const h = new Headers(init?.headers);
      h.set('x-forwarded-for', `203.0.113.${(ip += 1) % 250}`);
      h.set('x-forwarded-proto', 'https');
      return app.request(url.pathname, {
        method: init?.method,
        headers: h,
        body: init?.body as BodyInit,
      });
    };
    boxId = (await cc.addControlBox(BOX, 'test box', 'test'))!.id;
  }, 120_000);

  afterAll(async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    provider?.close();
    await (sql as unknown as { end?: () => Promise<void> } | undefined)?.end?.();
    await m?.closeDb();
    await scratch?.drop();
  });

  it('scope none refuses all three cases, and makes no row', async () => {
    env({ MANTLE_CONTROL_CENTER_SCOPE: 'none', MANTLE_OIDC_MODE: 'setup' });
    expect(await signed({ op: 'sso_status' })).toEqual({ ok: false, reason: 'scope' });
    expect(await signed({ op: 'sso_test' })).toEqual({ ok: false, reason: 'scope' });
    expect(await set({ tenant: TENANT, secret: SECRET })).toEqual({ ok: false, reason: 'scope' });
    expect(await row()).toBeNull();
    env({ MANTLE_CONTROL_CENTER_SCOPE: undefined });
  });

  it('the mode word off: the status says off, a save and a Test are refused', async () => {
    env({ MANTLE_OIDC_MODE: undefined });
    const s = await signed({ op: 'sso_status' });
    expect(s).toMatchObject({ ok: true, status: { mode: 'off', linked: null, active: null } });
    expect(await set({ tenant: TENANT })).toMatchObject({ ok: false, reason: 'mode' });
    expect(await set({ secret: SECRET })).toMatchObject({ ok: false, reason: 'mode' });
    expect(await signed({ op: 'sso_test' })).toMatchObject({ ok: false, reason: 'mode' });
    expect(await row()).toBeNull();
  });

  it('the CC stages tenant, client id and secret: no value in any answer, audit row or CC row after the send', async () => {
    env({ MANTLE_OIDC_MODE: 'setup' });
    const seal = await sealer();
    const asked = await cc.askControlSso(
      { do: 'set', boxId, tenant: TENANT.toUpperCase(), clientId: CLIENT, secret: SECRET },
      'it@example.com',
      seal,
      0,
    );
    expect(asked.ok).toBe(true);
    const { pending } = (asked as { value: { pending: string[] } }).value;
    expect(pending).toHaveLength(1);
    const [queued] = await sql<
      Row[]
    >`select tool_job::text as j from control_boxes where id = ${boxId}`;
    expect(String(queued!.j)).not.toContain(SECRET);
    expect(String(queued!.j)).toContain('"sealed"');
    await cc.requestControlRun(boxId);
    await run.runDueBoxes(key);
    // On the box: the issuer built from the tenant, the client id, the secret
    // sealed with the box's own key.
    const r = await row();
    expect(r).toMatchObject({
      issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
      client_id: CLIENT,
      secret_set_by: null,
    });
    expect(await opened()).toBe(SECRET);
    expect(config.oidcNames()).toMatchObject({ issuerFrom: 'row', clientIdFrom: 'row' });
    // On the CC: the call's args gone, the view holds the status.
    const [after] = await sql<
      Row[]
    >`select to_jsonb(b)::text as j, sso_view from control_boxes b where id = ${boxId}`;
    expect(String(after!.j)).not.toContain(SECRET);
    expect(after!.sso_view).toMatchObject({
      reason: null,
      status: { mode: 'setup', tenant: TENANT, clientId: CLIENT, issuerFrom: 'row', secret: 'row' },
      set: { fields: ['tenant', 'clientId', 'secret'], ok: true, by: 'it@example.com' },
    });
    const got = await cc.askControlSso({ do: 'answers', callIds: pending }, 'x', seal, 0);
    const answers = (got as { value: { answers: Row[] } }).value.answers;
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ kind: 'sso', name: 'sso_set', ok: true });
    expect(JSON.stringify(answers)).not.toContain(SECRET);
    expect(JSON.stringify(await cc.listControlSso())).not.toContain(SECRET);
    expect(JSON.stringify(await cc.listControlBoxes())).not.toMatch(/ssoView|sso_view/);
    // The save's row on the box (the refusals before it have their own).
    let audits: Row[] = [];
    for (let i = 0; i < 60; i++) {
      audits = await sql<Row[]>`select detail from audit_log
        where detail->>'op' = 'sso_set' and jsonb_array_length(detail->'fields') = 3`;
      if (audits.length > 0) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(audits[0]!.detail).toMatchObject({
      by: 'it@example.com',
      fields: ['tenant', 'clientId', 'secret'],
      result: { ok: true },
    });
    const all = await sql<Row[]>`select detail::text as d from audit_log`;
    expect(JSON.stringify(all)).not.toContain(SECRET);
  });

  it('a changed client id clears the secret it does not replace; a replay is refused', async () => {
    const once = signedBody({
      op: 'sso_set',
      args: { nonce: randomUUID(), by: 'it@example.com', clientId: CLIENT_2 },
    });
    expect(await (await post(once)).json()).toMatchObject({ ok: true, secretCleared: true });
    expect(await opened()).toBeNull();
    expect((await row())!.client_id).toBe(CLIENT_2);
    expect(await (await post(once)).json()).toEqual({ ok: false, reason: 'replay' });
    // The same client again changes nothing and clears nothing.
    expect(await set({ clientId: CLIENT_2, secret: SECRET })).toMatchObject({ ok: true });
    expect(await set({ clientId: CLIENT_2 })).not.toHaveProperty('secretCleared');
    expect(await opened()).toBe(SECRET);
  });

  it('names only while the mode word is setup; a .env line wins over the row', async () => {
    env({ MANTLE_OIDC_MODE: 'optional' });
    expect(await set({ tenant: TENANT })).toMatchObject({ ok: false, reason: 'mode' });
    expect(await set({ clientId: CLIENT })).toMatchObject({ ok: false, reason: 'mode' });
    expect((await row())!.client_id).toBe(CLIENT_2);
    env({ MANTLE_OIDC_MODE: 'setup', MANTLE_OIDC_ISSUER: issuer, MANTLE_OIDC_CLIENT_ID: 'mantle' });
    expect(await set({ tenant: TENANT })).toMatchObject({ ok: false, reason: 'env-wins' });
    expect(await set({ clientId: CLIENT })).toMatchObject({ ok: false, reason: 'env-wins' });
    const s = (await signed({ op: 'sso_status' })).status as Row;
    expect(s).toMatchObject({ issuer, issuerFrom: 'env', clientId: 'mantle', clientIdFrom: 'env' });
    env({ MANTLE_OIDC_CLIENT_SECRET: 'env-secret' });
    expect(await set({ secret: GOOD })).toMatchObject({ ok: false, reason: 'env-wins' });
    expect(((await signed({ op: 'sso_status' })).status as Row).secret).toBe('env');
    env({ MANTLE_OIDC_CLIENT_SECRET: undefined });
  });

  it('in an on mode a new secret is saved only when its Test answers ok', async () => {
    env({
      MANTLE_OIDC_MODE: 'optional',
      MANTLE_OIDC_ISSUER: issuer,
      MANTLE_OIDC_CLIENT_ID: 'mantle',
    });
    const refused = await set({ secret: BAD });
    expect(refused).toMatchObject({ ok: false, reason: 'test', test: 'secret-refused' });
    expect(JSON.stringify(refused)).not.toContain(BAD);
    expect(await opened()).toBe(SECRET);
    expect(await set({ secret: GOOD })).toMatchObject({ ok: true, test: 'ok' });
    expect(await opened()).toBe(GOOD);
    expect(await signed({ op: 'sso_test' })).toMatchObject({ ok: true, test: 'ok' });
    env({
      MANTLE_OIDC_MODE: 'setup',
      MANTLE_OIDC_ISSUER: undefined,
      MANTLE_OIDC_CLIENT_ID: undefined,
    });
  });

  it('a box a release behind answers bad-call, and the view says so', async () => {
    behind = true;
    const seal = await sealer();
    expect((await cc.askControlSso({ do: 'status', boxIds: [boxId] }, 'x', seal, 0)).ok).toBe(true);
    await cc.requestControlRun(boxId);
    await run.runDueBoxes(key);
    const [r] = await sql<Row[]>`select sso_view from control_boxes where id = ${boxId}`;
    expect(r!.sso_view).toMatchObject({ reason: 'bad-call' });
    // The status from before stays.
    expect((r!.sso_view as Row).status).toBeTruthy();
    behind = false;
  });

  it('the boot read: required with the row names is on; without them it stops', async () => {
    env({
      MANTLE_OIDC_MODE: 'required',
      MANTLE_OIDC_ISSUER: undefined,
      MANTLE_OIDC_CLIENT_ID: undefined,
    });
    const warn = vi.fn();
    await m.bootOidcRowNames(warn, 1);
    expect(config.readOidcSettings().settings).toMatchObject({
      mode: 'required',
      issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
      clientId: CLIENT_2,
    });
    // A .env line wins over the row.
    env({ MANTLE_OIDC_CLIENT_ID: 'from-env' });
    expect(config.oidcNames()).toMatchObject({
      clientId: 'from-env',
      clientIdFrom: 'env',
      issuerFrom: 'row',
    });
    env({ MANTLE_OIDC_CLIENT_ID: undefined });
    await sql`update sso_setup set issuer = null, client_id = null`;
    await expect(m.bootOidcRowNames(warn, 1)).rejects.toThrow(/required/);
    // setup with no names goes on.
    env({ MANTLE_OIDC_MODE: 'setup' });
    await expect(m.bootOidcRowNames(warn, 1)).resolves.toBeUndefined();
  });
});
