/**
 * The one-way raise of company sign-in's mode from the Control Center
 * (docs/oidc-sign-in.md, "From the Control Center"; docs/control-center.md),
 * through the real app (createApp: the gate, the signed route) on a real
 * migrated Postgres. One database plays both sides, as in
 * sso-channel.db.test.ts: the CC rows and the box.
 *
 *  - a .env mode line wins (env-wins), `off` included, and nothing is written;
 *  - one step only: no skip, no step down, no same step; scope none and a
 *    replay are refused;
 *  - off, setup, optional through the CC's queue and the signed route, the
 *    status names the row as the source, the CC view keeps the raise, the
 *    audit rows name who and the modes, never a secret;
 *  - optional to required is refused while required cannot work, and once
 *    it is raised the sessions the rule refuses end once; a later re-read
 *    ends nothing more;
 *  - the 60-second re-read: another process picks up the new mode; with a
 *    .env mode line it never reads the row; into required that cannot work
 *    it throws (the process stops); a failed read keeps the last mode;
 *  - the boot read stops when the row cannot be read and the mode may be
 *    required;
 *  - a box a release behind answers bad-call;
 *  - the revert file clears the mode: an older image reads off.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/web/lib/control/sso-mode.db.test.ts
 */
import { generateKeyPairSync, createPublicKey, randomUUID, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const SECRET = `cc-secret-${randomUUID()}`;
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

describe.skipIf(!URL_)('the one-way raise of the sign-in mode from the Control Center', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let m: typeof import('@mantle/db');
  let cc: typeof import('@mantle/db/control-center');
  let config: typeof import('@mantle/config');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let app: import('hono').Hono;
  let run: typeof import('./run');
  let key: KeyObject;
  let ip = 0;
  let boxId = '';
  let behind = false;
  const linked = randomUUID();
  const unlinked = randomUUID();

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
  const raise = (mode: string) =>
    signed({ op: 'sso_mode', args: { nonce: randomUUID(), by: 'it@example.com', mode } });
  const rowMode = async () =>
    ((await sql<Row[]>`select mode from sso_setup`)[0]?.mode as string | null | undefined) ?? null;
  const epochs = async () =>
    Object.fromEntries(
      (
        await sql<Row[]>`select id, session_epoch from auth.users
          where id in (${linked}, ${unlinked})`
      ).map((r) => [r.id as string, Number(r.session_epoch)]),
    );
  const env = (vals: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(vals)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  /** The CC asks, its control service sends, and the view is read back. */
  const raiseFromCc = async (mode: string) => {
    const asked = await cc.askControlSso(
      { do: 'mode', boxId, mode },
      'it@example.com',
      await sealer(),
      0,
    );
    expect(asked.ok).toBe(true);
    await cc.requestControlRun(boxId);
    await run.runDueBoxes(key);
    const [r] = await sql<Row[]>`select sso_view from control_boxes where id = ${boxId}`;
    return r!.sso_view as Row;
  };

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL_!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'control-sso-mode-db-test-secret-at-least-32';
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
    await sql`insert into auth.users (id, email, password_hash, role, display_name) values
      (${linked}, ${`${linked}@example.com`}, 'x', 'member', 'Linked'),
      (${unlinked}, ${`${unlinked}@example.com`}, 'x', 'member', 'Unlinked')`;
    await sql`insert into oidc_signin_links (login_id, issuer, subject)
      values (${linked}, ${ISSUER}, 'sub-linked')`;
    const { createApp } = await import('../../server/app');
    app = await createApp();
    run = await import('./run');
    egress.handle = async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(BOX);
      if (behind) {
        const op = (JSON.parse(Buffer.from(init!.body as Buffer).toString('utf8')) as Row).op;
        if (op === 'sso_mode') {
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
    config?.setOidcRow({});
    await (sql as unknown as { end?: () => Promise<void> } | undefined)?.end?.();
    await m?.closeDb();
    await scratch?.drop();
  });

  it('a .env mode line wins, off included: env-wins, and nothing is written', async () => {
    for (const line of ['off', 'setup', 'optional', 'required']) {
      env({ MANTLE_OIDC_MODE: line });
      for (const mode of ['setup', 'optional', 'required']) {
        expect(await raise(mode), `${line} ${mode}`).toMatchObject({
          ok: false,
          reason: 'env-wins',
        });
      }
    }
    expect(await rowMode()).toBeNull();
    env({ MANTLE_OIDC_MODE: undefined });
  });

  it('scope none refuses the raise; a replay is refused; the mode is checked by shape', async () => {
    env({ MANTLE_CONTROL_CENTER_SCOPE: 'none' });
    expect(await raise('setup')).toEqual({ ok: false, reason: 'scope' });
    env({ MANTLE_CONTROL_CENTER_SCOPE: undefined });
    // Down to off is no case at all: the shape refuses it.
    const bad = await post(
      signedBody({ op: 'sso_mode', args: { nonce: randomUUID(), by: 'x', mode: 'off' } }),
    );
    expect(bad.status).toBe(400);
    expect(await rowMode()).toBeNull();
    const once = signedBody({
      op: 'sso_mode',
      args: { nonce: randomUUID(), by: 'it@example.com', mode: 'optional' },
    });
    expect(await (await post(once)).json()).toMatchObject({ ok: false, reason: 'mode' });
    expect(await (await post(once)).json()).toEqual({ ok: false, reason: 'replay' });
  });

  it('one step only: no skip, no same step, no step down', async () => {
    expect(await raise('optional')).toMatchObject({ ok: false, reason: 'mode', from: 'off' });
    expect(await raise('required')).toMatchObject({ ok: false, reason: 'mode', from: 'off' });
    expect(await rowMode()).toBeNull();
  });

  it('off to setup to optional through the CC, the status says row, the view keeps the raise', async () => {
    const v1 = await raiseFromCc('setup');
    expect(v1).toMatchObject({
      reason: null,
      status: { mode: 'setup', modeFrom: 'row' },
      mode: { to: 'setup', from: 'off', ok: true, by: 'it@example.com' },
    });
    expect(await rowMode()).toBe('setup');
    expect(config.oidcModeWord()).toBe('setup');
    // Same step, a skip and a step down are refused from setup.
    expect(await raise('setup')).toMatchObject({ ok: false, reason: 'mode', from: 'setup' });
    expect(await raise('required')).toMatchObject({ ok: false, reason: 'mode', from: 'setup' });
    // The names, staged while the row says setup.
    const seal = await sealer();
    expect(
      (
        await cc.askControlSso(
          { do: 'set', boxId, tenant: TENANT, clientId: CLIENT, secret: SECRET },
          'it@example.com',
          seal,
          0,
        )
      ).ok,
    ).toBe(true);
    await cc.requestControlRun(boxId);
    await run.runDueBoxes(key);
    const v2 = await raiseFromCc('optional');
    expect(v2).toMatchObject({
      status: { mode: 'optional', modeFrom: 'row', issuerFrom: 'row' },
      mode: { to: 'optional', from: 'setup', ok: true },
    });
    expect(config.readOidcSettings().settings).toMatchObject({ mode: 'optional', issuer: ISSUER });
    // The names are locked now: the CC cannot go back to setup.
    expect(
      await signed({
        op: 'sso_set',
        args: { nonce: randomUUID(), by: 'x', clientId: randomUUID() },
      }),
    ).toMatchObject({ ok: false, reason: 'mode' });
    expect(await raise('setup')).toMatchObject({ ok: false, reason: 'mode', from: 'optional' });
    // The box's audit rows: who, the mode asked, the mode before. No secret
    // anywhere on either side.
    let audits: Row[] = [];
    for (let i = 0; i < 60; i++) {
      audits = await sql<Row[]>`select detail from audit_log
        where detail->>'op' = 'sso_mode' and detail->'result'->>'ok' = 'true'`;
      if (audits.length >= 2) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(audits.map((a) => a.detail)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          by: 'it@example.com',
          mode: 'optional',
          result: expect.objectContaining({ from: 'setup' }),
        }),
      ]),
    );
    const all = await sql<Row[]>`select detail::text as d from audit_log`;
    expect(JSON.stringify(all)).not.toContain(SECRET);
    const [ccRow] = await sql<Row[]>`select to_jsonb(b)::text as j from control_boxes b`;
    expect(String(ccRow!.j)).not.toContain(SECRET);
  });

  it('another process re-reads the row: it reads the new mode; with a .env line it never reads it', async () => {
    // As a worker would: the row says optional; drop this process's copy.
    config.setOidcRow({});
    expect(config.oidcModeWord()).toBe('off');
    expect(await m.rereadOidcRow(() => {})).toEqual({ before: 'off', after: 'optional' });
    // A .env line: the row is never read.
    env({ MANTLE_OIDC_MODE: 'setup' });
    await sql`update sso_setup set mode = 'required'`;
    expect(await m.rereadOidcRow(() => {})).toEqual({ before: 'setup', after: 'setup' });
    await sql`update sso_setup set mode = 'optional'`;
    env({ MANTLE_OIDC_MODE: undefined });
    // A failed read keeps the last mode (logged).
    const warn = vi.fn();
    await sql`alter table sso_setup rename column mode to mode_gone`;
    try {
      expect(await m.rereadOidcRow(warn)).toEqual({ before: 'optional', after: 'optional' });
    } finally {
      await sql`alter table sso_setup rename column mode_gone to mode`;
    }
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not be read again/));
  });

  it('optional to required is refused while required cannot work', async () => {
    // A .env issuer required cannot use (the box URL itself must stay: the
    // signed route answers for it).
    try {
      env({ MANTLE_OIDC_ISSUER: 'ftp://idp.example.invalid' });
      expect(await raise('required')).toMatchObject({
        ok: false,
        reason: 'mode',
        from: 'optional',
      });
      env({ MANTLE_OIDC_ISSUER: 'http://idp.example.invalid/realm' });
      expect(await raise('required')).toMatchObject({
        ok: false,
        reason: 'mode',
        from: 'optional',
      });
    } finally {
      env({ MANTLE_OIDC_ISSUER: undefined });
    }
    expect(await rowMode()).toBe('optional');
  });

  it('optional to required ends the sessions the rule refuses, once; a later re-read ends nothing more', async () => {
    const before = await epochs();
    const v = await raiseFromCc('required');
    expect(v).toMatchObject({
      status: { mode: 'required', modeFrom: 'row', linked: 1 },
      mode: { to: 'required', from: 'optional', ok: true },
    });
    expect(config.readOidcSettings().settings.mode).toBe('required');
    const after = await epochs();
    // Both refused: the linked login (company sign-in only) and the
    // unlinked one (held to a link step); the original account is not here.
    expect(after[linked]).toBe(before[linked]! + 1);
    expect(after[unlinked]).toBe(before[unlinked]! + 1);
    expect((await sql<Row[]>`select mode from oidc_mode_state`)[0]?.mode).toBe('required');
    const { oidcApplyRow } = await import('../oidc/boot');
    await oidcApplyRow();
    await oidcApplyRow();
    expect(await epochs()).toEqual(after);
    // Never down from the CC, and no step above required.
    expect(await raise('optional')).toMatchObject({ ok: false, reason: 'mode', from: 'required' });
    expect(await raise('required')).toMatchObject({ ok: false, reason: 'mode', from: 'required' });
  });

  it('a re-read into required that cannot work throws, so the process stops', async () => {
    config.setOidcRow({});
    try {
      env({ MANTLE_PUBLIC_URL: undefined });
      await expect(m.rereadOidcRow(() => {})).rejects.toThrow(/required but cannot work/);
    } finally {
      env({ MANTLE_PUBLIC_URL: `${BOX}/` });
    }
    expect((await m.rereadOidcRow(() => {})).after).toBe('required');
  });

  it('the boot read stops when the row cannot be read and the mode may be required', async () => {
    await sql`alter table sso_setup rename column mode to mode_gone`;
    try {
      await expect(m.bootOidcRow(() => {}, 1)).rejects.toThrow();
      // A .env line of optional with its names: no read, the boot goes on.
      env({
        MANTLE_OIDC_MODE: 'optional',
        MANTLE_OIDC_ISSUER: ISSUER,
        MANTLE_OIDC_CLIENT_ID: CLIENT,
      });
      await expect(m.bootOidcRow(() => {}, 1)).resolves.toBeUndefined();
    } finally {
      await sql`alter table sso_setup rename column mode_gone to mode`;
      env({
        MANTLE_OIDC_MODE: undefined,
        MANTLE_OIDC_ISSUER: undefined,
        MANTLE_OIDC_CLIENT_ID: undefined,
      });
    }
  });

  it('a box a release behind answers bad-call, and the view says so', async () => {
    behind = true;
    const v = await raiseFromCc('required');
    expect(v).toMatchObject({ reason: 'bad-call', mode: { to: 'required', ok: false } });
    behind = false;
  });

  it('the revert file clears the mode: an older image, or this one, then reads off', async () => {
    const text = readFileSync(
      new URL('../../../../packages/db/rollback/0372_sso_mode_from_cc.revert.sql', import.meta.url),
      'utf8',
    );
    await (sql as unknown as { begin: (f: (t: unknown) => Promise<void>) => Promise<void> }).begin(
      async (t) => {
        for (const part of text.split('--> statement-breakpoint')) {
          const stmt = part
            .split('\n')
            .filter((l) => !l.startsWith('--'))
            .join('\n')
            .trim();
          // A scratch database has no migration ledger to take 0372 off.
          if (!stmt || stmt.includes('__drizzle_migrations')) continue;
          await (t as { unsafe: (s: string) => Promise<unknown> }).unsafe(stmt);
        }
      },
    );
    expect(text).toContain(
      'DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792010000000;',
    );
    expect(await rowMode()).toBeNull();
    await m.loadOidcRow();
    expect(config.oidcModeWord()).toBe('off');
    expect(config.readOidcSettings().settings).toEqual({ mode: 'off' });
    // Re-runnable: 0372 again keeps the column.
    const mig = readFileSync(
      new URL('../../../../packages/db/migrations/0372_sso_mode_from_cc.sql', import.meta.url),
      'utf8',
    );
    await (sql as unknown as { begin: (f: (t: unknown) => Promise<void>) => Promise<void> }).begin(
      async (t) => {
        for (const part of mig.split('--> statement-breakpoint')) {
          const stmt = part
            .split('\n')
            .filter((l) => !l.startsWith('--'))
            .join('\n')
            .trim();
          if (stmt) await (t as { unsafe: (s: string) => Promise<unknown> }).unsafe(stmt);
        }
      },
    );
    await expect(sql`update sso_setup set mode = 'off'`).rejects.toThrow(/sso_setup_mode_check/);
  });
});
