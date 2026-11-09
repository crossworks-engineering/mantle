/**
 * The Control Center's fleet user ban through the real app (createApp: the
 * gate, the route policies, the rate limits) on a real migrated Postgres
 * (docs/control-center.md). One database plays both sides: the CC rows
 * (control_boxes, control_bans) and the box. The control service's run
 * (lib/control/run.ts) calls the box route through a fetch that hands the
 * request to the app, so the whole path runs: the match at the CC, the
 * signed call, check 1 (signature), check 2 (the switch), the users area's
 * disable.
 *
 *  - no .env lines: the route answers 404;
 *  - a bad signature, another origin, 61 seconds off, a body over 64 KB, a
 *    bad call: refused with a reason code, before any write;
 *  - a ban disables the matched login at once: its device bearer, API key
 *    and MCP grant end; the box owner is never disabled and is reported;
 *  - a login made after the ban is disabled at the next run;
 *  - a lift enables only what the CC disabled: never a login a box Admin
 *    disabled by hand, nor one disabled again by hand after the CC;
 *  - an archive: disabled, archived_at set, the marker gone; the CC's lift
 *    and a retired archive ban never enable it; a box Admin's Enable does
 *    and clears archived_at; the email stays;
 *  - the Fleet routes answer 404 off a CC;
 *  - key (phase 2): a provider key set through the vault, tested; a service
 *    not on the box's list sets nothing; a failed test puts the old key
 *    back; the answer never holds the key. At the CC: POST /api/fleet/keys
 *    queues it sealed, the run sends it and clears the job, the box row
 *    keeps the answer only.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/web/lib/control/control.db.test.ts
 */
import { createHash, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createMigratedScratchDatabase,
  ensureAdminUsers,
  ensureTestAnchor,
  runWorkspacesSwitch,
  superuserClient,
} from '@mantle/db/test-support';
import { publicKeyLine, signCall } from './sign';

// The control service's outbound call reaches the app in this process: the
// box is this same database (its address resolves nowhere).
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

// The key case's provider test, held by the test when it says so (a real
// provider is never called from here).
const probe = vi.hoisted(() => ({ answer: null as null | { ok: boolean; adapter: string } }));
vi.mock('@mantle/api-keys', async (orig) => {
  const actual = await orig<typeof import('@mantle/api-keys')>();
  return {
    ...actual,
    testVaultKey: (...args: Parameters<typeof actual.testVaultKey>) =>
      probe.answer
        ? Promise.resolve({ ...probe.answer, message: '', provider: '', name: 'x', kind: 'token' })
        : actual.testVaultKey(...args),
  };
});

const URL_ = process.env.MANTLE_TEST_DATABASE_URL;
type Row = Record<string, unknown>;
const BOX = 'https://brain.example.invalid';

describe.skipIf(!URL_)('the fleet user ban through the app', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let m: typeof import('@mantle/db');
  let cc: typeof import('@mantle/db/control-center');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let app: import('hono').Hono;
  let run: typeof import('./run');
  let key: KeyObject;
  let anchor = '';
  let anchorEmail = '';
  let boxId = '';
  const tag = `cc-${randomUUID().slice(0, 8)}`;
  const pat = randomUUID(); // banned, then lifted
  const hal = randomUUID(); // disabled by hand by a box Admin
  const arc = randomUUID(); // archived
  const late = randomUUID(); // made after the ban
  const boss = randomUUID(); // an Admin user
  const emailOf = (id: string) => `${tag}-${id.slice(0, 8)}@example.com`;
  let ip = 0;

  const row = async (id: string) =>
    (
      await sql<Row[]>`select u.disabled_at, u.archived_at, u.email, d.disabled_at as marker
        from auth.users u left join control_disables d on d.login_id = u.id where u.id = ${id}`
    )[0]!;
  const post = (body: Buffer, headers: Record<string, string>) =>
    Promise.resolve(
      app.request('/api/control/call', {
        method: 'POST',
        body: new Uint8Array(body),
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': `198.51.100.${(ip += 1) % 250}`,
          'x-forwarded-proto': 'https',
          ...headers,
        },
      }),
    );
  const signed = (obj: unknown, opts: { origin?: string; at?: number; k?: KeyObject } = {}) => {
    const body = Buffer.from(JSON.stringify(obj));
    return post(body, signCall(opts.k ?? key, opts.origin ?? BOX, body, opts.at));
  };
  const runNow = async () => {
    await cc.requestControlRun();
    await run.runDueBoxes(key);
  };
  const giveCredentials = async (id: string) => {
    const client = randomUUID();
    await sql`insert into mobile_tokens (id, user_id, label, expires_at)
              values (${randomUUID()}, ${id}, ${tag}, now() + interval '1 day')`;
    const keyHash = createHash('sha256').update(`key-${id}`).digest('hex');
    await sql`insert into access_keys (name, login_id, key_prefix, key_hash, access)
              values (${tag}, ${id}, ${keyHash.slice(0, 8)}, ${keyHash}, 'read')`;
    await sql`insert into oauth_clients (id, client_name, redirect_uris)
              values (${client}, ${tag}, '{https://client.example/cb}')`;
    await sql`insert into oauth_access_tokens (token_hash, owner_id, actor_id, client_id, expires_at)
              values (${`t-${id}`}, ${anchor}, ${id}, ${client}, now() + interval '1 hour')`;
  };
  const liveCredentials = async (id: string) =>
    (
      await sql<Row[]>`select
        (select count(*)::int from mobile_tokens where user_id = ${id} and revoked_at is null) as devices,
        (select count(*)::int from access_keys where login_id = ${id} and revoked_at is null) as keys,
        (select count(*)::int from oauth_access_tokens where actor_id = ${id} and revoked_at is null) as grants`
    )[0];

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL_!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'control-db-test-secret-at-least-32-chars';
    process.env.MANTLE_PUBLIC_URL = `${BOX}/`;
    delete process.env.MANTLE_IS_CONTROL_CENTER;
    delete process.env.MANTLE_CONTROL_CENTER;
    delete process.env.MANTLE_CONTROL_CENTER_KEY;
    m = await import('@mantle/db');
    cc = await import('@mantle/db/control-center');
    sql = superuserClient(scratch.url) as unknown as typeof sql;
    anchor = await ensureTestAnchor(sql);
    anchorEmail = String(
      (await sql<Row[]>`select email from auth.users where id = ${anchor}`)[0]!.email,
    );
    await sql`insert into auth.users (id, email, password_hash, role) values
      (${pat}, ${emailOf(pat)}, '', 'member'),
      (${hal}, ${emailOf(hal)}, '', 'member'),
      (${arc}, ${emailOf(arc)}, '', 'member'),
      (${boss}, ${emailOf(boss)}, '', 'admin')`;
    await runWorkspacesSwitch(scratch.url);
    await ensureAdminUsers(sql as never, [boss]);
    await giveCredentials(pat);
    key = generateKeyPairSync('ed25519').privateKey;
    const { createApp } = await import('../../server/app');
    app = await createApp();
    run = await import('./run');
    egress.handle = async (input, init, opts) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(BOX);
      expect(opts).toMatchObject({ redirect: 'error' });
      // The key call waits for the box's provider test; every other, 10 s.
      expect([10_000, 45_000]).toContain(opts?.timeoutMs);
      const h = new Headers(init?.headers);
      h.set('x-forwarded-for', `203.0.113.${(ip += 1) % 250}`);
      h.set('x-forwarded-proto', 'https');
      return app.request(url.pathname, {
        method: init?.method,
        headers: h,
        body: init?.body as BodyInit,
      });
    };
  }, 120_000);

  afterAll(async () => {
    delete process.env.MANTLE_CONTROL_CENTER;
    delete process.env.MANTLE_CONTROL_CENTER_KEY;
    delete process.env.MANTLE_IS_CONTROL_CENTER;
    delete process.env.MANTLE_PUBLIC_URL;
    await (sql as unknown as { end?: () => Promise<void> } | undefined)?.end?.();
    await m?.closeDb();
    await scratch?.drop();
  });

  it('no .env lines: the route answers 404 and nothing is read', async () => {
    const res = await signed({ op: 'hello' });
    expect(res.status).toBe(404);
  });

  it('check 1: refused with a reason code before the JSON is read', async () => {
    process.env.MANTLE_CONTROL_CENTER = 'https://cc.example.invalid';
    process.env.MANTLE_CONTROL_CENTER_KEY = publicKeyLine(
      (await import('node:crypto')).createPublicKey(key),
    );
    const reason = async (res: Response) => [res.status, ((await res.json()) as Row).reason];
    expect(
      await reason(await signed({ op: 'hello' }, { origin: 'https://other.example.invalid' })),
    ).toEqual([401, 'sig']);
    const stranger = generateKeyPairSync('ed25519').privateKey;
    expect(await reason(await signed({ op: 'hello' }, { k: stranger }))).toEqual([401, 'sig']);
    expect(await reason(await signed({ op: 'hello' }, { at: Date.now() - 61_000 }))).toEqual([
      401,
      'time',
    ]);
    expect(await reason(await signed({ op: 'hello' }, { at: Date.now() + 61_000 }))).toEqual([
      401,
      'time',
    ]);
    expect(await reason(await post(Buffer.from('{"op":"hello"}'), {}))).toEqual([401, 'time']);
    const big = Buffer.alloc(65 * 1024, 32);
    expect((await post(big, signCall(key, BOX, big))).status).toBe(413);
    // Signed, but not a call of the switch: no sixth case.
    const junk = Buffer.from('not json');
    expect(await reason(await post(junk, signCall(key, BOX, junk)))).toEqual([400, 'bad-call']);
    expect(await reason(await signed({ op: 'user_update', args: {} }))).toEqual([400, 'bad-call']);
    expect(
      await reason(await signed({ op: 'disable', args: { loginIds: [pat], role: 'admin' } })),
    ).toEqual([400, 'bad-call']);
    expect((await row(pat)).disabled_at).toBeNull();
    // A good call: hello.
    const ok = await signed({ op: 'hello' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true });
  });

  it('logins: ids, lowercase emails and flags only', async () => {
    const res = await signed({ op: 'logins' });
    const { logins } = (await res.json()) as { logins: Row[] };
    const mine = logins.find((l) => l.id === pat)!;
    expect(Object.keys(mine).sort()).toEqual([
      'archived',
      'disabled',
      'email',
      'id',
      'links',
      'marked',
      'owner',
    ]);
    expect(logins.find((l) => l.id === anchor)!.owner).toBe(true);
  });

  it('a ban disables at once, every way in ends, the owner stays and is reported', async () => {
    const box = await cc.addControlBox(BOX, 'test box', 'test');
    boxId = box!.id;
    await sql`update auth.users set disabled_at = now() where id = ${hal}`; // a box Admin's
    await cc.makeControlBan(
      {
        kind: 'disable',
        emails: [emailOf(pat), emailOf(hal), anchorEmail.toLowerCase()],
        issuer: null,
        oid: null,
        reason: 'test',
      },
      'test',
    );
    await run.runDueBoxes(key);
    const p = await row(pat);
    expect(p.disabled_at).not.toBeNull();
    expect(new Date(p.marker as string).getTime()).toBe(
      new Date(p.disabled_at as string).getTime(),
    );
    expect(await liveCredentials(pat)).toEqual({ devices: 0, keys: 0, grants: 0 });
    expect((await row(anchor)).disabled_at).toBeNull();
    expect((await row(hal)).marker).toBeNull();
    const [b] = await sql<
      Row[]
    >`select last_reason, last_result from control_boxes where id = ${boxId}`;
    expect(b!.last_reason).toBeNull();
    expect((b!.last_result as Row).owner).toEqual([anchor]);
    const [r] = await sql<
      Row[]
    >`select matched, owner_ids from control_results where box_id = ${boxId}`;
    expect(r).toEqual({ matched: 3, owner_ids: [anchor] });
  });

  it('a login made after the ban is disabled at the next run; an alias is not matched', async () => {
    await cc.makeControlBan(
      { kind: 'disable', emails: [emailOf(late)], issuer: null, oid: null, reason: null },
      'test',
    );
    await run.runDueBoxes(key);
    const alias = randomUUID();
    await sql`insert into auth.users (id, email, password_hash, role) values
      (${late}, ${emailOf(late)}, '', 'member'),
      (${alias}, ${emailOf(late).replace('@', '+x@')}, '', 'member')`;
    await runNow();
    expect((await row(late)).disabled_at).not.toBeNull();
    // An alias is not the ban's email: a box Admin's to disable by hand.
    expect((await row(alias)).disabled_at).toBeNull();
  });

  it('a lift enables only what the CC disabled', async () => {
    const [ban] = await sql<Row[]>`select id from control_bans where ${emailOf(pat)} = any(emails)`;
    // `late` is disabled by the CC, then disabled again by a box Admin (the
    // Users screen's "Disable again", the users area's own change on a login
    // already disabled): a new disabled_at, so the marker no longer matches.
    const before = (await row(late)).disabled_at;
    await new Promise((r) => setTimeout(r, 5));
    const { applyLoginChange, loadLoginTarget } = await import('@/lib/login-update');
    const again = await applyLoginChange(
      {
        id: anchor,
        email: emailOf(boss),
        actor: { id: boss, email: emailOf(boss), displayName: null, isOwner: false },
      } as never,
      (await loadLoginTarget(late))!,
      { disabled: true },
    );
    expect(again.ok).toBe(true);
    const ms = (v: unknown) => (v instanceof Date ? v.getTime() : Date.parse(String(v)));
    expect(ms((await row(late)).disabled_at)).toBeGreaterThan(ms(before));
    const [lateBan] = await sql<
      Row[]
    >`select id from control_bans where ${emailOf(late)} = any(emails)`;
    await cc.liftControlBan(String(ban!.id), 'test');
    await cc.liftControlBan(String(lateBan!.id), 'test');
    await run.runDueBoxes(key);
    expect((await row(pat)).disabled_at).toBeNull();
    expect((await row(pat)).marker).toBeNull();
    expect((await row(hal)).disabled_at).not.toBeNull();
    expect((await row(late)).disabled_at).not.toBeNull();
    // A direct enable of a login with no marker is refused by the box too.
    const res = await signed({ op: 'enable', args: { loginIds: [hal, late] } });
    expect(await res.json()).toEqual({ enabled: 0, notMarked: 2, notFound: 0 });
  });

  it('an archive: disabled, archived, the marker gone; only a box Admin restores it', async () => {
    await cc.makeControlBan(
      { kind: 'disable', emails: [emailOf(arc)], issuer: null, oid: null, reason: null },
      'test',
    );
    await runNow();
    expect((await row(arc)).marker).not.toBeNull();
    const archiveBan = await cc.makeControlBan(
      { kind: 'archive', emails: [emailOf(arc)], issuer: null, oid: null, reason: null },
      'test',
    );
    await run.runDueBoxes(key);
    const a = await row(arc);
    expect(a.archived_at).not.toBeNull();
    expect(a.disabled_at).not.toBeNull();
    expect(a.marker).toBeNull();
    expect(a.email).toBe(emailOf(arc));
    // The CC cannot undo it: lift every ban, retire the archive ban.
    for (const b of await cc.listControlBans()) await cc.liftControlBan(b.id, 'test');
    await runNow();
    expect((await row(arc)).archived_at).not.toBeNull();
    const res = await signed({ op: 'enable', args: { loginIds: [arc] } });
    expect(await res.json()).toEqual({ enabled: 0, notMarked: 1, notFound: 0 });
    expect(archiveBan.kind).toBe('archive');
    // A second login with that email cannot be made: the column is unique.
    await expect(
      sql`insert into auth.users (id, email, password_hash, role) values (${randomUUID()}, ${emailOf(arc)}, '', 'member')`,
    ).rejects.toThrow();
    // A box Admin's Enable restores it and clears archived_at.
    const { applyLoginChange, loadLoginTarget } = await import('@/lib/login-update');
    const actor = {
      id: anchor,
      email: emailOf(boss),
      actor: { id: boss, email: emailOf(boss), displayName: null, isOwner: false },
    };
    const r = await applyLoginChange(actor as never, (await loadLoginTarget(arc))!, {
      disabled: false,
    });
    expect(r.ok).toBe(true);
    expect(await row(arc)).toMatchObject({ disabled_at: null, archived_at: null });
  });

  it('key: sets a provider key through the vault and answers ok or a reason only', async () => {
    const { getApiKey } = await import('@mantle/api-keys');
    // The vault seals with the master key (the test lanes set none).
    const masterBefore = process.env.MANTLE_MASTER_KEY;
    process.env.MANTLE_MASTER_KEY = Buffer.alloc(32, 9).toString('base64');
    const call = async (service: string, value: string) =>
      (await signed({ op: 'key', args: { service, value } })).json();
    // Not on the box's list: nothing set.
    expect(await call('nosuch-service', 'v1')).toEqual({
      service: 'nosuch-service',
      ok: false,
      reason: 'service',
    });
    expect(await getApiKey(anchor, 'nosuch-service')).toBeNull();
    // A service with no test: set, and said so.
    const fc = await call('firecrawl', 'fc-fleet-1');
    expect(fc).toEqual({ service: 'firecrawl', ok: false, reason: 'untested' });
    expect((await getApiKey(anchor, 'firecrawl'))?.apiKey).toBe('fc-fleet-1');
    expect(JSON.stringify(fc)).not.toContain('fc-fleet-1');
    // A passed test: ok.
    probe.answer = { ok: true, adapter: 'test' };
    expect(await call('openrouter', 'or-fleet-good')).toEqual({ service: 'openrouter', ok: true });
    expect((await getApiKey(anchor, 'openrouter'))?.apiKey).toBe('or-fleet-good');
    // A failed test: the key the box had before is put back.
    probe.answer = { ok: false, adapter: 'test' };
    expect(await call('openrouter', 'or-fleet-wrong')).toEqual({
      service: 'openrouter',
      ok: false,
      reason: 'failed',
    });
    expect((await getApiKey(anchor, 'openrouter'))?.apiKey).toBe('or-fleet-good');
    // A failed test where the box had no key: the new row goes again, so a
    // key under another label is used again.
    expect(await getApiKey(anchor, 'anthropic')).toBeNull();
    expect(await call('anthropic', 'an-fleet-wrong')).toEqual({
      service: 'anthropic',
      ok: false,
      reason: 'failed',
    });
    expect(await getApiKey(anchor, 'anthropic')).toBeNull();
    probe.answer = null;
    // A name that holds a password is never overwritten.
    const { setVaultKey, listApiKeys } = await import('@mantle/api-keys');
    await m.runAsSystem('test:vault', () =>
      setVaultKey({ loginId: anchor, email: 'test', via: 'web' }, anchor, {
        ref: { name: 'openai' },
        kind: 'password',
        value: 'pw-kept-1',
      }),
    );
    expect(await call('openai', 'oa-fleet-1')).toEqual({
      service: 'openai',
      ok: false,
      reason: 'refused',
    });
    const pw = (await listApiKeys(anchor)).find((k) => k.name === 'openai');
    expect(pw?.kind).toBe('password');
    // The vault wrote its own audit rows, and the control row names the case.
    const rows = await sql<Row[]>`select action, detail from audit_log
      where action in ('vault.key.set', 'user.update') and actor_email = 'control-center'
      order by id desc limit 20`;
    expect(rows.some((r) => r.action === 'vault.key.set')).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/or-fleet|fc-fleet/);
    if (masterBefore === undefined) delete process.env.MANTLE_MASTER_KEY;
    else process.env.MANTLE_MASTER_KEY = masterBefore;
  });

  it('the owner is refused by the box too', async () => {
    const res = await signed({ op: 'archive', args: { loginIds: [anchor] } });
    expect(await res.json()).toEqual({ archived: 0, already: 0, notFound: 0, owner: [anchor] });
    const res2 = await signed({ op: 'disable', args: { loginIds: [anchor, randomUUID()] } });
    expect(await res2.json()).toMatchObject({ disabled: 0, notFound: 1, owner: [anchor] });
    expect((await row(anchor)).disabled_at).toBeNull();
  });

  it('every write leaves an audit row naming the Control Center', async () => {
    let rows: Row[] = [];
    for (let i = 0; i < 60; i++) {
      rows = await sql<Row[]>`select actor_email, detail from audit_log
        where actor_email = 'control-center' and detail->>'via' = 'control'`;
      if (rows.length >= 3) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });

  it('a box that answers 404 is off; a failure is a reason code', async () => {
    delete process.env.MANTLE_CONTROL_CENTER_KEY;
    await runNow();
    const [b] = await sql<Row[]>`select last_reason from control_boxes where id = ${boxId}`;
    expect(b!.last_reason).toBe('off');
  });

  it('the Fleet routes: 404 off a CC; on a CC an Admin links, bans with a preview, and lifts', async () => {
    const tokens = await import('../auth/tokens');
    const [e] = await sql<Row[]>`select session_epoch from auth.users where id = ${boss}`;
    const cookie = `mantle_session=${
      tokens.buildSessionCookie(boss, { epoch: Number(e!.session_epoch), ttlSeconds: 3600 }).value
    }`;
    const fleet = (path: string, method = 'GET', body?: unknown) =>
      Promise.resolve(
        app.request(path, {
          method,
          headers: {
            cookie,
            'content-type': 'application/json',
            'x-forwarded-for': `192.0.2.${(ip += 1) % 250}`,
            'x-forwarded-proto': 'https',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
    delete process.env.MANTLE_IS_CONTROL_CENTER;
    expect((await fleet('/api/fleet')).status).toBe(404);
    expect((await fleet('/api/fleet/bans', 'POST', { emails: ['x@example.com'] })).status).toBe(
      404,
    );
    expect(
      (await fleet('/api/fleet/keys', 'POST', { service: 'firecrawl', value: 'x' })).status,
    ).toBe(404);
    process.env.MANTLE_IS_CONTROL_CENTER = 'on';
    try {
      const added = await fleet('/api/fleet/boxes', 'POST', {
        url: 'https://two.example.invalid/',
      });
      expect(added.status).toBe(201);
      const box = ((await added.json()) as { box: Row }).box;
      expect(box.url).toBe('https://two.example.invalid');
      expect(
        (await fleet('/api/fleet/boxes', 'POST', { url: 'https://two.example.invalid' })).status,
      ).toBe(409);
      expect(
        (await fleet('/api/fleet/boxes', 'POST', { url: 'http://three.example.invalid' })).status,
      ).toBe(400);
      const preview = await fleet('/api/fleet/bans', 'POST', {
        emails: [emailOf(pat).toUpperCase()],
        preview: true,
      });
      expect(preview.status).toBe(200);
      const p = ((await preview.json()) as { preview: { boxes: Row[]; unknown: number } }).preview;
      expect(p.boxes.find((b) => b.url === BOX)!.matched).toBe(1);
      expect(p.unknown).toBe(1);
      expect(
        await sql<
          Row[]
        >`select 1 from control_bans where ${emailOf(pat)} = any(emails) and lifted_at is null`,
      ).toHaveLength(0);
      const made = await fleet('/api/fleet/bans', 'POST', {
        emails: [emailOf(pat).toUpperCase()],
        reason: 'route test',
      });
      expect(made.status).toBe(201);
      const ban = ((await made.json()) as { ban: Row }).ban;
      expect(ban.emails).toEqual([emailOf(pat)]);
      expect(ban.madeBy).toBe(emailOf(boss));
      const overview = (await (await fleet('/api/fleet')).json()) as Row;
      expect(Object.keys(overview).sort()).toEqual([
        'bans',
        'boxes',
        'envLines',
        'results',
        'service',
      ]);
      // A provider key on the fleet: queued sealed, sent at the run, then gone.
      const masterBefore = process.env.MANTLE_MASTER_KEY;
      process.env.MANTLE_MASTER_KEY = Buffer.alloc(32, 9).toString('base64');
      try {
        const [here] = await sql<Row[]>`select id from control_boxes where url = ${BOX}`;
        const set = await fleet('/api/fleet/keys', 'POST', {
          service: 'firecrawl',
          value: 'fc-fleet-route',
          boxIds: [String(here!.id)],
        });
        expect(set.status).toBe(200);
        const queued = (await set.json()) as Row;
        expect(queued).toEqual({ service: 'firecrawl', queued: 1, boxIds: [String(here!.id)] });
        const [job] = await sql<
          Row[]
        >`select key_job from control_boxes where id = ${String(here!.id)}`;
        expect(JSON.stringify(job)).not.toContain('fc-fleet-route');
        const seen = JSON.stringify(await (await fleet('/api/fleet')).json());
        expect(seen).toContain('keyPending');
        expect(seen).not.toContain('sealed');
        // One database plays both sides: the box side answers only while
        // this process is no CC.
        delete process.env.MANTLE_IS_CONTROL_CENTER;
        process.env.MANTLE_CONTROL_CENTER_KEY = publicKeyLine(
          (await import('node:crypto')).createPublicKey(key),
        );
        await run.runDueBoxes(key);
        delete process.env.MANTLE_CONTROL_CENTER_KEY;
        process.env.MANTLE_IS_CONTROL_CENTER = 'on';
        const [after] = await sql<Row[]>`select key_job, key_result from control_boxes
          where id = ${String(here!.id)}`;
        expect(after!.key_job).toBeNull();
        expect(after!.key_result).toMatchObject({
          service: 'firecrawl',
          ok: false,
          reason: 'untested',
          by: emailOf(boss),
        });
        const { getApiKey } = await import('@mantle/api-keys');
        expect((await getApiKey(anchor, 'firecrawl'))?.apiKey).toBe('fc-fleet-route');
        // A job older than an hour is deleted unsent, and says so.
        await sql`update control_boxes set key_job = jsonb_build_object('service', 'firecrawl',
          'sealed', 'x', 'by', 'test', 'at', '2000-01-01T00:00:00.000Z')
          where id = ${String(here!.id)}`;
        await run.runDueBoxes(key);
        const [old] = await sql<Row[]>`select key_job, key_result from control_boxes
          where id = ${String(here!.id)}`;
        expect(old!.key_job).toBeNull();
        expect(old!.key_result).toMatchObject({
          service: 'firecrawl',
          ok: false,
          reason: 'expired',
        });
        expect((await getApiKey(anchor, 'firecrawl'))?.apiKey).toBe('fc-fleet-route');
        expect(
          (await fleet('/api/fleet/keys', 'POST', { service: 'Not A Name', value: 'x' })).status,
        ).toBe(400);
      } finally {
        if (masterBefore === undefined) delete process.env.MANTLE_MASTER_KEY;
        else process.env.MANTLE_MASTER_KEY = masterBefore;
      }
      const lift = await fleet(`/api/fleet/bans/${String(ban.id)}/lift`, 'POST');
      expect(lift.status).toBe(200);
      expect((await fleet(`/api/fleet/bans/${String(ban.id)}/lift`, 'POST')).status).toBe(404);
      expect((await fleet(`/api/fleet/boxes/${String(box.id)}`, 'DELETE')).status).toBe(200);
    } finally {
      delete process.env.MANTLE_IS_CONTROL_CENTER;
    }
  });
});
