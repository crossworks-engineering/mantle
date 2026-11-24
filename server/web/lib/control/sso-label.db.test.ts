/**
 * The sign-in button's label from the Control Center (0399;
 * docs/oidc-sign-in.md, "From the Control Center"; docs/control-center.md),
 * through the real app (createApp: the gate, the signed route) on a real
 * migrated Postgres. One database plays both sides, as in
 * sso-mode.db.test.ts: the CC rows and the box.
 *
 *  - sso_set { label } in setup, optional and required; off refuses it
 *    (`mode`); a MANTLE_OIDC_LABEL line wins (`env-wins`); a label that does
 *    not fit the pattern is no call at all (bad-call), never stored; '' clears;
 *  - through the CC's queue: the view keeps the status with the label and
 *    its source, the save names the field; the box's audit row names the
 *    label, never a secret;
 *  - an older CC: a call without `withLabel` gets a status with no label
 *    fields, so its strict reading still takes it;
 *  - an older box: refuses `withLabel` and `label` (bad-call); the CC asks a
 *    status once more without the flag; a save with a label is refused
 *    whole, nothing written;
 *  - another process picks the label up at its 60-second re-read, with a
 *    .env mode line too;
 *  - the revert file clears the label; 0399 runs again.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/web/lib/control/sso-label.db.test.ts
 */
import { generateKeyPairSync, createPublicKey, randomUUID, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMigratedScratchDatabase, superuserClient } from '@mantle/db/test-support';
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
const ENV_KEYS = [
  'MANTLE_CONTROL_CENTER',
  'MANTLE_CONTROL_CENTER_KEY',
  'MANTLE_CONTROL_CENTER_SCOPE',
  'MANTLE_PUBLIC_URL',
  'MANTLE_OIDC_MODE',
  'MANTLE_OIDC_ISSUER',
  'MANTLE_OIDC_CLIENT_ID',
  'MANTLE_OIDC_CLIENT_SECRET',
  'MANTLE_OIDC_LABEL',
];

/** The status fields a CC before 0399 takes (tool-calls.ts SsoStatus then). */
const OLD_STATUS_KEYS = [
  'mode',
  'modeFrom',
  'tenant',
  'issuer',
  'issuerFrom',
  'clientId',
  'clientIdFrom',
  'secret',
  'secretSetAt',
  'redirectUri',
  'missing',
  'linked',
  'active',
].sort();

describe.skipIf(!URL_)('the sign-in label from the Control Center', () => {
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
  /** Plays a box a release behind: refuses what it does not know. */
  let behind = false;
  const sent: Row[] = [];

  const sealer = async () => {
    const { seal } = await import('@mantle/crypto');
    return (plain: string, aad: string) => seal(plain, aad).ciphertext.toString('base64');
  };
  const post = (obj: unknown) => {
    const body = Buffer.from(JSON.stringify(obj));
    return Promise.resolve(
      app.request('/api/control/call', {
        method: 'POST',
        body: new Uint8Array(body),
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': `198.51.100.${(ip += 1) % 250}`,
          'x-forwarded-proto': 'https',
          ...signCall(key, BOX, body),
        },
      }),
    );
  };
  const signed = async (obj: unknown) => (await (await post(obj)).json()) as Row;
  const setLabel = (label: string, more: Row = {}) =>
    signed({
      op: 'sso_set',
      args: { nonce: randomUUID(), by: 'it@example.com', label, withLabel: true, ...more },
    });
  const rowLabel = async () =>
    ((await sql<Row[]>`select label from sso_setup`)[0]?.label as string | null | undefined) ??
    null;
  const env = (vals: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(vals)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  /** The CC asks, its control service sends, and the view is read back. */
  const fromCc = async (ask: Parameters<typeof cc.askControlSso>[0]) => {
    const asked = await cc.askControlSso(ask, 'it@example.com', await sealer(), 0);
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
    process.env.SESSION_SECRET = 'control-sso-label-db-test-secret-at-least-32';
    for (const k of ENV_KEYS) delete process.env[k];
    env({ MANTLE_PUBLIC_URL: `${BOX}/`, MANTLE_IS_CONTROL_CENTER: undefined });
    key = generateKeyPairSync('ed25519').privateKey;
    process.env.MANTLE_CONTROL_CENTER = 'https://cc.example.invalid';
    process.env.MANTLE_CONTROL_CENTER_KEY = publicKeyLine(createPublicKey(key));
    m = await import('@mantle/db');
    cc = await import('@mantle/db/control-center');
    config = await import('@mantle/config');
    sql = superuserClient(scratch.url) as unknown as typeof sql;
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    await ensureTestAnchor(sql);
    const { createApp } = await import('../../server/app');
    app = await createApp();
    run = await import('./run');
    egress.handle = async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(BOX);
      const call = JSON.parse(Buffer.from(init!.body as Buffer).toString('utf8')) as {
        op: string;
        args?: Row;
      };
      sent.push(call);
      if (behind && call.args && ('withLabel' in call.args || 'label' in call.args)) {
        return new Response(JSON.stringify({ error: 'refused', reason: 'bad-call' }), {
          status: 400,
        });
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

  it('off refuses a label; a label that does not fit is no call; nothing is written', async () => {
    expect(await setLabel('Microsoft')).toMatchObject({ ok: false, reason: 'mode' });
    env({ MANTLE_OIDC_MODE: 'setup' });
    for (const bad of ['<b>x</b>', 'a\nb', 'x'.repeat(61), 'a: b']) {
      const res = await post({
        op: 'sso_set',
        args: { nonce: randomUUID(), by: 'x', label: bad },
      });
      expect(res.status, bad).toBe(400);
      expect(await res.json()).toMatchObject({ reason: 'bad-call' });
    }
    expect(await rowLabel()).toBeNull();
    // The CC refuses it first, before anything is queued.
    expect(cc.checkSsoSet({ label: '<b>x</b>' }).ok).toBe(false);
    expect(cc.checkSsoSet({ label: ' Microsoft ' })).toEqual({
      ok: true,
      value: { label: 'Microsoft' },
    });
    // The CC's ask puts the label in NFC, as the box stores it.
    expect(cc.checkSsoSet({ label: 'Socie\u0301te\u0301' })).toEqual({
      ok: true,
      value: { label: 'Société' },
    });
    expect(cc.checkSsoSet({ label: 'Okta\u202E' }).ok).toBe(false);
  });

  it('a label in setup, optional and required; the .env wins; an empty one clears', async () => {
    for (const mode of ['setup', 'optional', 'required']) {
      env({ MANTLE_OIDC_MODE: mode });
      const r = await setLabel(`Microsoft ${mode}`);
      expect(r, mode).toMatchObject({ ok: true });
      expect(await rowLabel()).toBe(`Microsoft ${mode}`);
      // In setup the issuer and the client are missing: the status still
      // names the label.
      expect((r.status as Row).label).toBe(`Microsoft ${mode}`);
      expect((r.status as Row).labelFrom).toBe('row');
    }
    // The box's signed case puts a label in NFC too; marks after letters fit.
    expect(await setLabel('e\u0301'.repeat(60))).toMatchObject({ ok: true });
    expect(await rowLabel()).toBe('é'.repeat(60));
    expect(await setLabel('தமிழ்')).toMatchObject({ ok: true });
    expect(await rowLabel()).toBe('தமிழ்');
    const rtl = await post({
      op: 'sso_set',
      args: { nonce: randomUUID(), by: 'x', label: 'Okta\u200F' },
    });
    expect(rtl.status).toBe(400);
    expect(await setLabel('Microsoft required')).toMatchObject({ ok: true });
    env({ MANTLE_OIDC_LABEL: 'Company account' });
    expect(await setLabel('Okta')).toMatchObject({ ok: false, reason: 'env-wins' });
    expect(await rowLabel()).toBe('Microsoft required');
    env({ MANTLE_OIDC_LABEL: undefined });
    expect(await setLabel('')).toMatchObject({ ok: true, status: { labelFrom: 'none' } });
    expect(await rowLabel()).toBeNull();
    env({ MANTLE_OIDC_MODE: 'optional' });
  });

  it('an older CC asks without the flag: the status has no field it does not know', async () => {
    const r = await signed({ op: 'sso_status' });
    expect(Object.keys(r.status as Row).sort()).toEqual(OLD_STATUS_KEYS);
    const set = await signed({
      op: 'sso_set',
      args: { nonce: randomUUID(), by: 'x', secret: 'not-used' },
    });
    // An on mode tests a new secret first; the answer's status is the old shape.
    expect(Object.keys(set.status as Row).sort()).toEqual(OLD_STATUS_KEYS);
  });

  it('through the CC queue: the view keeps the label and its source, the audit row names it', async () => {
    const v = await fromCc({ do: 'set', boxId, label: 'Microsoft' });
    expect(v).toMatchObject({
      reason: null,
      status: { label: 'Microsoft', labelFrom: 'row' },
      set: { fields: ['label'], ok: true },
    });
    expect(await rowLabel()).toBe('Microsoft');
    const s = await fromCc({ do: 'status', boxIds: [boxId] });
    expect(s).toMatchObject({ status: { label: 'Microsoft', labelFrom: 'row' } });
    let found: Row[] = [];
    for (let i = 0; i < 60 && found.length === 0; i++) {
      found = await sql<Row[]>`select detail from audit_log
                                where detail->>'op' = 'sso_set' and detail->>'label' = 'Microsoft'`;
      if (found.length === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(found[0]?.detail).toMatchObject({ fields: ['label'], label: 'Microsoft' });
  });

  it('an older box: a status is asked again without the flag; a save with a label is refused whole', async () => {
    behind = true;
    try {
      sent.length = 0;
      const s = await fromCc({ do: 'status', boxIds: [boxId] });
      expect(s).toMatchObject({ reason: null, status: { mode: 'optional' } });
      expect(
        sent
          .filter((c) => c.op === 'sso_status')
          .map((c) => 'withLabel' in ((c.args as Row) ?? {})),
      ).toEqual([true, false]);
      const v = await fromCc({ do: 'set', boxId, label: 'Okta' });
      expect(v).toMatchObject({ reason: 'bad-call', set: { fields: ['label'], ok: false } });
      expect(await rowLabel()).toBe('Microsoft');
    } finally {
      behind = false;
    }
  });

  it('another process picks the label up at its re-read, with a .env mode line too', async () => {
    await sql`update sso_setup set label = 'Entra ID'`;
    // As a worker would: its own copy is the old one.
    config.setOidcRow({ label: 'Microsoft' });
    env({ MANTLE_OIDC_MODE: 'optional' });
    await m.rereadOidcRow(() => {});
    expect(config.oidcLabelInUse()).toEqual({ label: 'Entra ID', labelFrom: 'row' });
    // A .env mode of off: never read.
    env({ MANTLE_OIDC_MODE: 'off' });
    await sql`update sso_setup set label = 'Not read'`;
    await m.rereadOidcRow(() => {});
    expect(config.oidcLabelInUse().label).toBe('Entra ID');
    env({ MANTLE_OIDC_MODE: 'optional' });
    // A boot whose read is for the label alone (.env mode and both names)
    // goes on when the row cannot be read.
    env({
      MANTLE_OIDC_MODE: 'required',
      MANTLE_OIDC_ISSUER: 'https://login.microsoftonline.com/x/v2.0',
      MANTLE_OIDC_CLIENT_ID: 'c',
    });
    await sql`alter table sso_setup rename column label to label_gone`;
    try {
      const warn = vi.fn();
      await expect(m.bootOidcRow(warn, 1)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not be read/));
    } finally {
      await sql`alter table sso_setup rename column label_gone to label`;
      env({
        MANTLE_OIDC_MODE: 'optional',
        MANTLE_OIDC_ISSUER: undefined,
        MANTLE_OIDC_CLIENT_ID: undefined,
      });
    }
  });

  it('the revert file clears the label; 0399 runs again and keeps the length check', async () => {
    const stmts = (text: string) =>
      text
        .split('--> statement-breakpoint')
        .map((part) =>
          part
            .split('\n')
            .filter((l) => !l.startsWith('--'))
            .join('\n')
            .trim(),
        )
        // A scratch database has no migration ledger to take 0399 off.
        .filter((st) => st && !st.includes('__drizzle_migrations'));
    const runAll = (text: string) =>
      (sql as unknown as { begin: (f: (t: unknown) => Promise<void>) => Promise<void> }).begin(
        async (t) => {
          for (const st of stmts(text)) {
            await (t as { unsafe: (s: string) => Promise<unknown> }).unsafe(st);
          }
        },
      );
    const revert = readFileSync(
      new URL('../../../../packages/db/rollback/0399_sso_label.revert.sql', import.meta.url),
      'utf8',
    );
    expect(revert).toContain(
      'DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792340300000;',
    );
    await runAll(revert);
    expect(await rowLabel()).toBeNull();
    await m.loadOidcRow();
    expect(config.oidcLabelInUse()).toEqual({ label: 'Single sign-on', labelFrom: 'none' });
    await runAll(
      readFileSync(
        new URL('../../../../packages/db/migrations/0399_sso_label.sql', import.meta.url),
        'utf8',
      ),
    );
    await expect(sql`update sso_setup set label = ''`).rejects.toThrow(/sso_setup_label_check/);
    await expect(sql`update sso_setup set label = ${'x'.repeat(61)}`).rejects.toThrow(
      /sso_setup_label_check/,
    );
  });
});
