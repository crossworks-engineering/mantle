/**
 * Add a person from the Control Center through the real app (createApp: the
 * gate, the signed route, POST /api/fleet/invite) on a real migrated
 * Postgres (docs/control-center.md, "Add a person from the CC"). One
 * database plays both sides, as in sso-channel.db.test.ts: the CC rows and
 * the box.
 *
 *  - a CC Admin with their password: the box makes a member invite with its
 *    own code; the link reaches the person once; the redeem makes a member
 *    login with no workspace; no CC row, audit row or any other row holds
 *    the code;
 *  - the refusals: not a CC, a member login, a bearer, no fresh password,
 *    a banned email, scope none, a former client's email, an email with a
 *    login there, a bad key, a replay, a box a release behind;
 *  - a second invite replaces the first; the owner and the Admins stay.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/web/lib/control/invite-channel.db.test.ts
 */
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  type KeyObject,
} from 'node:crypto';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createMigratedScratchDatabase,
  ensureAdminUsers,
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
const PASSWORD = `pw-${randomUUID()}`;
const ENV_KEYS = [
  'MANTLE_CONTROL_CENTER',
  'MANTLE_CONTROL_CENTER_KEY',
  'MANTLE_CONTROL_CENTER_SCOPE',
  'MANTLE_PUBLIC_URL',
  'MANTLE_IS_CONTROL_CENTER',
];
const emailOf = (tag: string) => `${tag}.${randomUUID().slice(0, 8)}@example.com`;

describe.skipIf(!URL_)('add a person from the Control Center', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let m: typeof import('@mantle/db');
  let cc: typeof import('@mantle/db/control-center');
  let content: typeof import('@mantle/content');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let app: import('hono').Hono;
  let run: typeof import('./run');
  let key: KeyObject;
  let ip = 0;
  let boxId = '';
  let anchor = '';
  const boss = randomUUID(); // a CC Admin
  const member = randomUUID(); // a plain member login
  let bossCookie = '';
  let memberCookie = '';
  /** The box answers: the app, or a box a release behind. */
  let behind = false;

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
  const rsa = () => generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');
  const invite = (email: string, k = spki(rsa().publicKey)) =>
    signed({ op: 'invite', args: { nonce: randomUUID(), by: 'it@example.com', email, key: k } });
  const invitesOf = (email: string) =>
    sql<Row[]>`select * from member_invites where email = ${email} order by created_at`;
  const fleet = (cookie: string, body: unknown, extra: Record<string, string> = {}) =>
    Promise.resolve(
      app.request('/api/fleet/invite', {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          'x-forwarded-for': `192.0.2.${(ip += 1) % 250}`,
          'x-forwarded-proto': 'https',
          ...extra,
        },
        body: JSON.stringify(body),
      }),
    );
  /** The route's ask, with the control service run while it waits. One
   *  database plays both sides: the CC flag is on for the route's checks,
   *  and off while the box answers (a CC is never a subject box). */
  const ask = async (email: string) => {
    env({ MANTLE_IS_CONTROL_CENTER: 'on' });
    const pending = fleet(bossCookie, { do: 'invite', boxId, email, password: PASSWORD });
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const [b] = await sql<Row[]>`select tool_job from control_boxes where id = ${boxId}`;
      if (b?.tool_job) break;
    }
    env({ MANTLE_IS_CONTROL_CENTER: undefined });
    await run.runDueBoxes(key);
    const res = await pending;
    return { status: res.status, body: (await res.json()) as Row };
  };
  const env = (vals: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(vals)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  /** Every row of every table in public and auth whose text holds `text`. */
  const rowsHolding = async (text: string) => {
    const tables = await sql<{ s: string; t: string }[]>`select table_schema as s, table_name as t
      from information_schema.tables
      where table_schema in ('public', 'auth') and table_type = 'BASE TABLE'`;
    const hits: string[] = [];
    for (const { s, t } of tables) {
      const [r] = await (
        sql as unknown as { unsafe: (q: string, p: string[]) => Promise<{ n: number }[]> }
      ).unsafe(`select count(*)::int as n from "${s}"."${t}" x where to_jsonb(x)::text like $1`, [
        `%${text}%`,
      ]);
      if ((r?.n ?? 0) > 0) hits.push(`${s}.${t}`);
    }
    return hits;
  };
  const admins = () =>
    sql<
      Row[]
    >`select id, role, is_owner from auth.users where role = 'admin' or is_owner order by id`;

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL_!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'control-invite-db-test-secret-at-least-32';
    for (const k of ENV_KEYS) delete process.env[k];
    env({ MANTLE_PUBLIC_URL: `${BOX}/` });
    key = generateKeyPairSync('ed25519').privateKey;
    process.env.MANTLE_CONTROL_CENTER = 'https://cc.example.invalid';
    process.env.MANTLE_CONTROL_CENTER_KEY = publicKeyLine(createPublicKey(key));
    m = await import('@mantle/db');
    cc = await import('@mantle/db/control-center');
    content = await import('@mantle/content');
    sql = superuserClient(scratch.url) as unknown as typeof sql;
    anchor = await ensureTestAnchor(sql);
    const pw = bcrypt.hashSync(PASSWORD, 4);
    await sql`insert into auth.users (id, email, password_hash, role) values
      (${boss}, ${emailOf('boss')}, ${pw}, 'admin'),
      (${member}, ${emailOf('member')}, ${pw}, 'member')`;
    await ensureAdminUsers(sql as never, [boss]);
    const tokens = await import('../auth/tokens');
    const cookieOf = async (id: string) => {
      const [e] = await sql<Row[]>`select session_epoch from auth.users where id = ${id}`;
      return `mantle_session=${
        tokens.buildSessionCookie(id, { epoch: Number(e!.session_epoch), ttlSeconds: 3600 }).value
      }`;
    };
    bossCookie = await cookieOf(boss);
    memberCookie = await cookieOf(member);
    const { createApp } = await import('../../server/app');
    app = await createApp();
    run = await import('./run');
    egress.handle = async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(BOX);
      if (behind) {
        // An older box: its switch has no invite case.
        const op = (JSON.parse(Buffer.from(init!.body as Buffer).toString('utf8')) as Row).op;
        if (op === 'invite') {
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
    await (sql as unknown as { end?: () => Promise<void> } | undefined)?.end?.();
    await m?.closeDb();
    await scratch?.drop();
  });

  it('a CC Admin adds a person: the link once, a member login with no workspace, the code in no row', async () => {
    env({ MANTLE_IS_CONTROL_CENTER: 'on' });
    const before = await admins();
    const email = emailOf('new.person');
    const { status, body } = await ask(email.toUpperCase());
    expect(status).toBe(200);
    expect(body).toMatchObject({ pending: [], gone: [] });
    const [got] = body.invites as Row[];
    expect(got).toMatchObject({ ok: true, boxId, email });
    const link = String(got!.link);
    expect(link.startsWith(`${BOX}/invite#code=`)).toBe(true);
    const code = decodeURIComponent(link.split('#code=')[1]!);
    expect(code).toHaveLength(content.MEMBER_INVITE_CODE_LENGTH);
    // On the box: one open invite, its hash only, made by the box owner.
    const [row] = await invitesOf(email);
    expect(row).toMatchObject({
      owner_id: anchor,
      created_by: anchor,
      code_hash: createHash('sha256').update(code).digest('hex'),
      redeemed_at: null,
      revoked_at: null,
    });
    const hours = (new Date(row!.expires_at as string).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(71.9);
    expect(hours).toBeLessThanOrEqual(72);
    expect(new Date(String(got!.expiresAt)).getTime()).toBe(
      new Date(row!.expires_at as string).getTime(),
    );
    // The audit rows: who, which box, which email; never the code.
    let audits: Row[] = [];
    for (let i = 0; i < 60; i++) {
      audits = await sql<Row[]>`select action, actor_email, detail from audit_log
        where action = 'fleet.user_invite' or detail->>'op' = 'invite'`;
      if (audits.length >= 2) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(audits).toContainEqual(
      expect.objectContaining({ action: 'fleet.user_invite', detail: { boxId, email } }),
    );
    expect(audits).toContainEqual(
      expect.objectContaining({
        detail: expect.objectContaining({
          via: 'control',
          op: 'invite',
          by: expect.stringContaining('@'),
          email,
          result: { ok: true, expiresAt: expect.any(String) },
        }),
      }),
    );
    // No row anywhere holds the code: not the call queue, its answer, an
    // audit row, a view. Its hash is on the invite row only.
    expect(await rowsHolding(code)).toEqual([]);
    const [queue] = await sql<Row[]>`select tool_job from control_boxes where id = ${boxId}`;
    expect(queue!.tool_job).toBeNull();
    // A second read of the answer: gone, nothing to open.
    // The redeem: a member login, not an owner, no workspace.
    const redeemed = await content.redeemMemberInvite({
      code,
      passwordHash: bcrypt.hashSync('their-own-password', 4),
    });
    expect(redeemed).toMatchObject({ email });
    const [login] = await sql<Row[]>`select role, is_owner from auth.users
      where id = ${redeemed!.loginId}`;
    expect(login).toEqual({ role: 'member', is_owner: false });
    const seats = await sql<
      Row[]
    >`select 1 from workspace_users where login_id = ${redeemed!.loginId}`;
    expect(seats).toHaveLength(0);
    // The owner and the Admins are as they were.
    expect(await admins()).toEqual(before);
    // A login now has the email: a new invite is refused, nothing made.
    const again = await ask(email);
    expect(again.body.invites).toEqual([
      expect.objectContaining({ ok: false, reason: 'email-has-login', email }),
    ]);
    expect(await invitesOf(email)).toHaveLength(1);
  });

  it('a second invite replaces the first', async () => {
    const email = emailOf('twice');
    const one = await ask(email);
    const two = await ask(email);
    const code = (r: { body: Row }) =>
      decodeURIComponent(String((r.body.invites as Row[])[0]!.link).split('#code=')[1]!);
    const [first, second] = await invitesOf(email);
    expect(first!.revoked_at).not.toBeNull();
    expect(second!.revoked_at).toBeNull();
    expect(await content.previewMemberInvite(code(one))).toBeNull();
    expect(await content.previewMemberInvite(code(two))).toMatchObject({ email });
  });

  it('refuses: not a CC, a member login, a bearer, a wrong password, a banned email', async () => {
    const email = emailOf('refused');
    const body = { do: 'invite', boxId, email, password: PASSWORD };
    env({ MANTLE_IS_CONTROL_CENTER: undefined });
    expect((await fleet(bossCookie, body)).status).toBe(404);
    env({ MANTLE_IS_CONTROL_CENTER: 'on' });
    expect((await fleet(memberCookie, body)).status).toBe(403);
    expect((await fleet('', body, { authorization: 'Bearer mntl_not_a_session' })).status).toBe(
      401,
    );
    const wrong = await fleet(bossCookie, { ...body, password: 'not-it' });
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toMatchObject({ code: 'password' });
    // A banned email: refused at the CC, no call queued.
    await sql`insert into control_bans (emails, made_by) values (${[email]}, 'it@example.com')`;
    const banned = await fleet(bossCookie, body);
    expect(banned.status).toBe(409);
    expect(await banned.json()).toMatchObject({ code: 'banned' });
    const [b] = await sql<Row[]>`select tool_job from control_boxes where id = ${boxId}`;
    expect(b!.tool_job).toBeNull();
    expect(await invitesOf(email)).toHaveLength(0);
    await sql`update control_bans set lifted_at = now() where ${email} = any(emails)`;
    env({ MANTLE_IS_CONTROL_CENTER: undefined });
    // No agent reaches it: no tool by that name, and the name is reserved.
    const tools = await import('@mantle/tools');
    expect(tools.getBuiltin('control_user_invite')).toBeFalsy();
    expect(tools.isPersonOnlyTool('control_user_invite')).toBe(true);
  });

  it('the box refuses: scope none, a former client, a bad key, a replay; a box a release behind', async () => {
    const email = emailOf('box');
    env({ MANTLE_CONTROL_CENTER_SCOPE: 'none' });
    expect(await invite(email)).toEqual({ ok: false, reason: 'scope' });
    const viaRoute = await ask(email);
    expect(viaRoute.body.invites).toEqual([
      expect.objectContaining({ ok: false, reason: 'scope' }),
    ]);
    env({ MANTLE_CONTROL_CENTER_SCOPE: undefined });
    expect(await invitesOf(email)).toHaveLength(0);
    // A former client's email.
    const former = emailOf('former');
    await sql`insert into archive_client_logins (login_id, email, created_at, session_epoch)
      values (${randomUUID()}, ${former}, now(), 0)`;
    expect(await invite(former)).toEqual({ ok: false, reason: 'email-was-client' });
    // A key that is no RSA key of 2048 bits or more: no invite made.
    const small = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey;
    expect(await invite(email, spki(small))).toEqual({ ok: false, reason: 'key' });
    expect(await invite(email, spki(generateKeyPairSync('ed25519').publicKey))).toEqual({
      ok: false,
      reason: 'key',
    });
    expect(await invitesOf(email)).toHaveLength(0);
    // A replay of the same signed call.
    const once = signedBody({
      op: 'invite',
      args: { nonce: randomUUID(), by: 'it@example.com', email, key: spki(rsa().publicKey) },
    });
    expect(await (await post(once)).json()).toMatchObject({ ok: true });
    expect(await (await post(once)).json()).toEqual({ ok: false, reason: 'replay' });
    expect(await invitesOf(email)).toHaveLength(1);
    // A box a release behind: the person reads bad-call.
    behind = true;
    const old = await ask(emailOf('old'));
    expect(old.body.invites).toEqual([expect.objectContaining({ ok: false, reason: 'bad-call' })]);
    behind = false;
  });

  it('answers: only a call this process holds a key for, and each once', async () => {
    const r = await fleet(bossCookie, { do: 'answers', callIds: [randomUUID()] });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ invites: [], pending: [] });
  });
});
