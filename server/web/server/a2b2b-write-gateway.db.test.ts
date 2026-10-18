/**
 * Arch A2b2b: the login write gateway (packages/db/src/client.ts). A scoped
 * login write runs on the write role (mantle_write_user) in every actor
 * check mode (plan v3 S3: the mode decides refuse or report, never the
 * pool; before S3 off ran it on the system pool).
 * Through the real app (createApp) on a migrated scratch database; which
 * role sent each write to `nodes` is read from a statement trigger that
 * records session_user (this scratch database only).
 *
 *  - login: a member's create runs on the write role in warn and on, and
 *    lands in its private workspace (made on the first create, after the
 *    request's scope was read: the gateway adds it to the write scope);
 *  - off: the same create runs on the write role too (S3);
 *  - an Admin user's write request runs on the write role (F4), off too;
 *  - what the database refuses and the app would let through: off and warn
 *    report it and run it, on refuses it with a scope-write refusal (a 403);
 *  - assistant, link and contact actors with a write scope: on the role, a
 *    create in a workspace they moderate goes through, one with no
 *    Moderator of its home is refused; system work in the same scope stays
 *    on the system pool;
 *  - S3: profiles and app_table_exports (the two gap tables until S3) are
 *    write-role tables: each login writes its own profile row, the brain's
 *    only with the Settings area, a member's turn never; an export row
 *    only a manager of the app, member-negative cells in warn and on;
 *  - grants (0279): the home move is one call (manage of the old home and a
 *    Moderator of the new one), and the role writes the derived grant
 *    columns only through the definer.
 *  - fix round 1: a column or a function denial is an error, never run
 *    again (H1); a transaction runs once, one commit and one commit hook,
 *    a refused item write stays refused (M1, one path since S3); writes
 *    inside an open write transaction join it and the pool's
 *    wait is bounded (M2); the visibility confirm reads in the transaction,
 *    past the scope through the definers (M3); a grant's audit row is held
 *    to the scope (L5).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/a2b2b-write-gateway.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const WRITER = /^mantle_write_user/;

type Json = Record<string, unknown>;
type Mode = 'off' | 'warn' | 'on';

/** Rolls a direct write-role transaction back after its checks. */
class Rollback extends Error {}

describe.skipIf(!URL)('A2b2b: the login write gateway', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let app: import('hono').Hono;
  let cookieOf: (id: string) => string;
  let writer: ReturnType<typeof postgres> | undefined;
  let dir = '';
  const testKey = process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';
  const owner = randomUUID(); // the anchor, an Admin user
  const mem = randomUUID(); // a member: Moderator of Team, reads Ro
  const mem2 = randomUUID(); // a member: makes Ro
  const tag = `a2b2b${randomUUID().slice(0, 6)}`;
  let team = '';
  let adminWs = '';
  let ro = '';
  const roNote = randomUUID();
  const teamNote = randomUUID();

  /** A fixture only the superuser may run (a box mode, a table, a trigger):
   *  the app's pool may log in as the runtime role (arch A9). */
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);
  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const email = (who: string) => `${tag}-${who}@example.invalid`;
  const call = async (
    p: string,
    as: string,
    method = 'GET',
    body?: unknown,
  ): Promise<{ status: number; text: string; json: Json }> => {
    const res = await app.request(p, {
      method,
      headers: { 'content-type': 'application/json', cookie: cookieOf(as) },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    });
    const text = await res.text();
    let json: Json = {};
    try {
      json = JSON.parse(text) as Json;
    } catch {
      /* not json */
    }
    return { status: res.status, text, json };
  };
  const homeIn = async (id: string, ws: string) => {
    await m.withHeads([id], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${id}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
                           values (${id}, ${ws}, true)`);
    });
  };
  const privateOf = async (login: string) =>
    (
      await x<{ ws: string }>(
        sql`select workspace_id::text as ws from private_workspaces where login_id = ${login}`,
      )
    )[0]?.ws;
  /** Who sent the writes to nodes that `fn` caused (session_user each). */
  const writersOf = async (fn: () => Promise<unknown>): Promise<string[]> => {
    const [top] = await x<{ n: number }>(
      sql`select coalesce(max(id), 0)::int as n from a2b2b_seen`,
    );
    await fn();
    const rows = await x<{ who: string }>(
      sql`select who from a2b2b_seen where id > ${top!.n} order by id`,
    );
    return rows.map((r) => r.who);
  };
  const setMode = (mode: Mode) => {
    process.env.MANTLE_ACTOR_CHECK = mode;
  };
  /** `fn` in `login`'s mutating request scope, as the session guard enters
   *  it (no HTTP route in between: the app's own checks are skipped). */
  const inRequest = async <T>(login: string, fn: () => Promise<T>): Promise<T> => {
    const scope = await m.viewerScopeFor({ login });
    return m.runAsActor(m.loginActor(login, 'rw'), () =>
      m.runInRequestSlot(async () => {
        expect(m.enterRequestScope(scope, { writes: true, drafts: false })).toBe(true);
        return fn();
      }),
    );
  };
  const titleOf = async (id: string) =>
    (await x<{ t: string }>(sql`select title as t from nodes where id = ${id}`))[0]?.t;

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'a2b2b-gateway-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'a2b2b-write-gateway-secret-at-least-32-chars!';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${email('owner')}, 'x', true, 'admin', 'Olive Owner'),
      (${mem}, ${email('mem')}, 'x', false, 'member', 'Mia Member'),
      (${mem2}, ${email('mem2')}, 'x', false, 'member', 'Max Member')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
    const ws = await x<{ id: string; key: string | null }>(sql`
      select id::text as id, (case when is_admin then 'admin' when name = 'Team' then 'team' end) as key from workspaces where owner_id = ${owner}`);
    team = ws.find((w) => w.key === 'team')!.id;
    adminWs = ws.find((w) => w.key === 'admin')!.id;
    // Which role sent each write to nodes (this scratch database only).
    await su(sql`create table a2b2b_seen (id bigserial primary key, who text not null, op text)`);
    await su(
      sql.raw(`create function a2b2b_seen_trg() returns trigger language plpgsql
      security definer set search_path = public as $$
      begin insert into a2b2b_seen (who, op) values (session_user, tg_op); return null; end $$`),
    );
    await su(sql`create trigger zz_a2b2b_seen after insert or update or delete on nodes
      for each statement execute function a2b2b_seen_trg()`);
    const tokens = await import('../lib/auth/tokens');
    cookieOf = (id) => `mantle_session=${tokens.buildSessionCookie(id).value}`;
    const { createApp } = await import('./app');
    app = await createApp();
    ro = (await call('/api/workspaces', mem2, 'POST', { name: 'Ro' })).json.id as string;
    expect(ro).toBeTruthy();
    // mem moderates Team; it reads Ro (no Moderator, no Write).
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
                values (${team}, ${mem}, true)
                on conflict (workspace_id, login_id) do update set moderator = true`);
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
                values (${ro}, ${mem}, false)`);
    await x(sql`insert into nodes (id, owner_id, type, title, path) values
      (${roNote}, ${owner}, 'note', ${`${tag} ro note`}, 'notes'),
      (${teamNote}, ${owner}, 'note', ${`${tag} team note`}, 'notes')`);
    await homeIn(roNote, ro);
    await homeIn(teamNote, team);
    writer = postgres(
      (await import('@mantle/db/viewer')).viewerDatabaseUrl(
        scratch.url,
        'write',
        (await import('@mantle/db/viewer')).viewerRolePassword(testKey, 'write'),
      ),
      { max: 1, prepare: false, onnotice: () => {} },
    );
  }, 240_000);

  afterEach(() => setMode('warn'));

  afterAll(async () => {
    setMode('warn');
    await writer?.end();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('login: a member’s create runs on the write role in warn and on, into its private workspace', async () => {
    expect(await privateOf(mem)).toBeUndefined();
    for (const mode of ['warn', 'on'] as const) {
      setMode(mode);
      let res: Awaited<ReturnType<typeof call>> | undefined;
      const who = await writersOf(async () => {
        res = await call('/api/notes', mem, 'POST', { title: `${tag} ${mode} note` });
      });
      expect(res!.status, res!.text.slice(0, 200)).toBe(201);
      // The note's own insert is the write role's (a missing kind root is
      // the system's, repair:kind-root).
      expect(
        who.some((w) => WRITER.test(w)),
        `${mode}: ${who.join(',')}`,
      ).toBe(true);
      const id = ((res!.json.note as Json | undefined)?.id ?? res!.json.id) as string;
      const [row] = await x<{ home: string }>(
        sql`select home_ws::text as home from nodes where id = ${id}`,
      );
      expect(row!.home).toBe(await privateOf(mem));
      // An edit of its own item, on the role too.
      const edits = await writersOf(async () => {
        const r = await call(`/api/notes/${id}`, mem, 'PATCH', { title: `${tag} ${mode} edited` });
        expect(r.status, r.text.slice(0, 200)).toBe(200);
      });
      expect(edits.length).toBeGreaterThan(0);
      expect(
        edits.every((w) => WRITER.test(w)),
        edits.join(','),
      ).toBe(true);
    }
  });

  it('off: the same create runs on the write role too (plan v3 S3: the mode never picks the pool)', async () => {
    // Changed in S3: before it, off ran this create on the system pool.
    setMode('off');
    let status = 0;
    const who = await writersOf(async () => {
      status = (await call('/api/notes', mem, 'POST', { title: `${tag} off note` })).status;
    });
    expect(status).toBe(201);
    expect(
      who.some((w) => WRITER.test(w)),
      who.join(','),
    ).toBe(true);
  });

  it('an Admin user’s write request runs on the write role too (F4: its reads in its scope)', async () => {
    // Before F4 it stayed on the system pool, its reads unscoped; it enters
    // its request scope now (session.ts enterLoginWrite), as a member's.
    for (const mode of ['warn', 'on'] as const) {
      setMode(mode);
      const who = await writersOf(async () => {
        const r = await call('/api/notes', owner, 'POST', { title: `${tag} ${mode} admin note` });
        expect(r.status, r.text.slice(0, 200)).toBe(201);
      });
      expect(
        who.some((w) => WRITER.test(w)),
        `${mode}: ${who.join(',')}`,
      ).toBe(true);
    }
    // Off too since plan v3 S3 (it was the system pool before).
    setMode('off');
    const off = await writersOf(async () => {
      const r = await call('/api/notes', owner, 'POST', { title: `${tag} off admin note` });
      expect(r.status, r.text.slice(0, 200)).toBe(201);
    });
    expect(
      off.some((w) => WRITER.test(w)),
      off.join(','),
    ).toBe(true);
  });

  it('what only the database refuses: off and warn report and run it, on refuses it (a scope-write refusal, 403)', async () => {
    // mem reads the Ro note (no Write): the app's item check would refuse
    // this edit; called past it, only the write check stands.
    const edit = (title: string) =>
      inRequest(mem, () =>
        m.db
          .update(m.nodes)
          .set({ title })
          .where(eq(m.nodes.id, roNote))
          .returning({ id: m.nodes.id }),
      );
    // Off since plan v3 S3: on the write role, the check reports as warn
    // does (0278's gate); before S3 off ran it on the system pool unseen.
    for (const mode of ['off', 'warn'] as const) {
      setMode(mode);
      expect(await edit(`${tag} ${mode} edit`)).toHaveLength(1);
      expect(await titleOf(roNote)).toBe(`${tag} ${mode} edit`);
      expect(m.takeActorMisses().map((x) => x.check)).toContain(
        'UPDATE on nodes: no edit of the item (refused when the check is on)',
      );
    }
    setMode('on');
    const err = await edit(`${tag} on edit`).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err, 'refused in on').not.toBeNull();
    expect(m.isScopeWriteRefusal(err)).toBe(true);
    expect(m.pgErrorCode(err)).toBe('42501');
    expect(await titleOf(roNote)).toBe(`${tag} warn edit`);
  });

  it('assistant, link and contact writes with a scope run on the write role; system work there does not', async () => {
    const actors = [
      { kind: 'assistant' as const, actor: { kind: 'assistant' as const, agentId: null } },
      { kind: 'link' as const, actor: { kind: 'link' as const } },
      { kind: 'link' as const, actor: { kind: 'contact' as const, canWrite: true } },
    ];
    const create = (title: string) =>
      m.withNodeInsertHeads(owner, [{ type: 'note', path: 'notes' }], (tx) =>
        tx
          .insert(m.nodes)
          .values({ ownerId: owner, type: 'note', title, path: 'notes', data: {} })
          .returning({ id: m.nodes.id, home: m.nodes.homeWs }),
      );
    // With the edit check on (pnpm test:edit-on, arch A3a) an assistant with
    // no user and a public link write nothing: the read-only refusal; and a
    // contact share with Can write writes its app's data only, no item
    // (0294, A8 F9), refused with the same detail.
    const editOn = process.env.MANTLE_TEST_EDIT_CHECK === 'on';
    for (const mode of ['warn', 'on'] as const) {
      setMode(mode);
      for (const a of actors) {
        const name = `${mode} ${a.actor.kind}`;
        if (editOn && (m.writeModeOf(a.actor) === 'ro' || a.actor.kind === 'contact')) {
          const ro = await m
            .runAsActor(a.actor, () =>
              m.withTurnScope(
                { kind: a.kind, loginId: null, ws: [team], modWs: [team] },
                () =>
                  m.withCreateHome({ createWs: team, privateWs: null }, () =>
                    create(`${tag} ${name} read only`),
                  ),
                { writes: true },
              ),
            )
            .then(
              () => null,
              (e: unknown) => e,
            );
          expect(m.editRefusalDetail(ro), name).toBe('ro_actor');
          m.takeActorMisses();
          continue;
        }
        // A Moderator of the workspace it creates in: allowed, on the role.
        let made: { id: string; home: string | null }[] = [];
        const who = await writersOf(() =>
          m.runAsActor(a.actor, () =>
            m.withTurnScope(
              { kind: a.kind, loginId: null, ws: [team], modWs: [team] },
              () =>
                m.withCreateHome({ createWs: team, privateWs: null }, async () => {
                  made = await create(`${tag} ${name} made`);
                }),
              { writes: true },
            ),
          ),
        );
        expect(made[0]?.home, name).toBe(team);
        expect(who.length, name).toBeGreaterThan(0);
        expect(
          who.every((w) => WRITER.test(w)),
          `${name}: ${who.join(',')}`,
        ).toBe(true);
        // No Moderator of its home (Admin, the default): refused, by the
        // write check or the row rule (the scope reads no Admin row).
        const refused = await m
          .runAsActor(a.actor, () =>
            m.withTurnScope(
              { kind: a.kind, loginId: null, ws: [team], modWs: [] },
              () => create(`${tag} ${name} refused`),
              { writes: true },
            ),
          )
          .then(
            () => null,
            (e: unknown) => e,
          );
        expect(refused, name).not.toBeNull();
        expect(m.isScopeWriteRefusal(refused), `${name}: ${String(refused)}`).toBe(true);
        m.takeActorMisses();
      }
    }
    // System work in the same scope: the system pool.
    setMode('warn');
    const sys = await writersOf(() =>
      m.runAsActor({ kind: 'assistant', agentId: null }, () =>
        m.withTurnScope(
          { kind: 'assistant', loginId: null, ws: [team], modWs: [] },
          () => m.runAsSystem('test:a2b2b', () => create(`${tag} system made`)),
          { writes: true },
        ),
      ),
    );
    expect(sys.length).toBeGreaterThan(0);
    expect(sys.filter((w) => WRITER.test(w))).toEqual([]);
  });

  it('S3: profiles on the write role: each login writes its own row, the brain’s only with the Settings area (off, warn, on)', async () => {
    // Owner decision 2026-10-17. Changed in S3: before it, profiles was a
    // gap table, rerun on the system pool (warn) or as the gap writer
    // (on), so any scoped login wrote any row.
    const c = await import('@mantle/content');
    const adm = randomUUID(); // an Admin user, not the anchor, with Settings
    const admNo = randomUUID(); // an Admin user without the Settings area
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${adm}, ${email('adm')}, 'x', false, 'admin', 'Ada Admin'),
      (${admNo}, ${email('admno')}, 'x', false, 'admin', 'Abe Admin')`);
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator, limits) values
      (${adminWs}, ${adm}, true, '{}'::jsonb),
      (${adminWs}, ${admNo}, true, ${JSON.stringify({ areas: { settings: false } })}::jsonb)
      on conflict (workspace_id, login_id) do update set limits = excluded.limits`);
    const tzOf = async (login: string) =>
      (
        await x<{ tz: string | null }>(
          sql`select preferences->>'timezone' as tz from profiles where user_id = ${login}`,
        )
      )[0]?.tz ?? null;
    /** set_timezone's write (updateProfilePreferences of a row) in
     *  `login`'s write scope: 'ok' or the error code. */
    const setTz = (login: string, row: string, tz: string) =>
      inRequest(login, () => c.updateProfilePreferences(row, { timezone: tz })).then(
        () => 'ok',
        (e: unknown) => m.pgErrorCode(e) ?? String(e),
      );
    for (const mode of ['off', 'warn', 'on'] as const) {
      setMode(mode);
      m.takeWriteRoleGaps();
      // Each login writes its own row (the anchor's own is the brain's).
      for (const who of [mem, adm, admNo, owner]) {
        expect(await setTz(who, who, 'Africa/Johannesburg'), `${mode} own`).toBe('ok');
        expect(await tzOf(who)).toBe('Africa/Johannesburg');
      }
      // An Admin user who is not the anchor, with Settings: the brain's row.
      expect(await setTz(adm, owner, 'Europe/Berlin'), `${mode} adm`).toBe('ok');
      expect(await tzOf(owner)).toBe('Europe/Berlin');
      // Without Settings, a member (a member's turn), and another login's
      // row for anyone: refused, nothing changes.
      expect(await setTz(admNo, owner, 'Asia/Tokyo'), `${mode} admNo`).toBe('42501');
      expect(await setTz(mem, owner, 'Asia/Tokyo'), `${mode} member`).toBe('42501');
      expect(await setTz(adm, mem, 'Asia/Tokyo'), `${mode} other row`).toBe('42501');
      expect(await tzOf(owner)).toBe('Europe/Berlin');
      expect(await tzOf(mem)).toBe('Africa/Johannesburg');
      // No right is missing on the role: nothing noted, nothing run again.
      expect(m.takeWriteRoleGaps(), mode).toEqual([]);
    }
  });

  it('S3: a member’s turn calls set_timezone over its MCP: refused, the brain’s row unchanged (off, warn, on)', async () => {
    const ls = await import('@mantle/mcp-core');
    const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
    const { Client } = await import('@modelcontextprotocol/client');
    const before = await x<{ p: unknown }>(
      sql`select preferences as p from profiles where user_id = ${owner}`,
    );
    for (const mode of ['off', 'warn', 'on'] as const) {
      setMode(mode);
      const server = new McpServer({ name: 'test', version: '0' });
      ls.registerPreparedTools(
        server,
        await ls.prepareCallerTools({
          role: 'member',
          anchorId: owner,
          loginId: mem,
          via: 'oauth',
          write: true,
        }),
      );
      const [ta, tb] = InMemoryTransport.createLinkedPair();
      const cl = new Client({ name: 's3', version: '0' });
      await Promise.all([server.connect(ta), cl.connect(tb)]);
      try {
        const out = await cl
          .callTool({ name: 'set_timezone', arguments: { timezone: 'Asia/Tokyo' } })
          .then(
            (r) => (r as { isError?: boolean }).isError === true,
            () => true,
          );
        expect(out, `${mode}: refused`).toBe(true);
      } finally {
        await cl.close();
      }
      expect(
        await x<{ p: unknown }>(
          sql`select preferences as p from profiles where user_id = ${owner}`,
        ),
      ).toEqual(before);
    }
    m.takeActorMisses();
  });

  it('S3: app_table_exports on the write role: a manager of the app writes its export row; member-negative refused (off, warn, on)', async () => {
    // Changed in S3: before it, a scoped typed write of an export row went
    // to the system pool up front (no row rule), a transaction's ran again
    // there; now the row rule and the write check ask manage of the app.
    const mem3 = randomUUID(); // an outsider: in no workspace of the app
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
                values (${mem3}, ${email('mem3')}, 'x', false, 'member', 'Ola Outsider')`);
    const appId = randomUUID();
    const tableId = randomUUID();
    const sib = randomUUID();
    await x(sql`insert into nodes (id, owner_id, type, title, path) values
      (${appId}, ${owner}, 'app', ${`${tag} s3 app`}, 'apps'),
      (${tableId}, ${owner}, 'table', ${`${tag} s3 export`}, 'tables'),
      (${sib}, ${owner}, 'note', ${`${tag} s3 sibling`}, 'notes')`);
    for (const id of [appId, tableId, sib]) await homeIn(id, ro);
    // mem reads Ro (the app: a read grant) and has Write on a sibling item
    // (Team, which it moderates, holds the sibling with Write).
    await x(
      sql`insert into item_grants (node_id, workspace_id, write) values (${sib}, ${team}, true)`,
    );
    const [row] = await x<{ id: string }>(sql`insert into app_table_exports
      (owner_id, app_node_id, sqlite_table, table_node_id)
      values (${owner}, ${appId}, 'tasks', ${tableId}) returning id::text as id`);
    const exportId = row!.id;
    const stateOf = async () =>
      JSON.stringify(
        await x(sql`select * from app_table_exports where app_node_id = ${appId} order by id`),
      );
    const update = (login: string, id: string) =>
      inRequest(login, () =>
        m.db
          .update(m.appTableExports)
          .set({ lastError: `${tag} ${login}` })
          .where(eq(m.appTableExports.id, id))
          .returning({ id: m.appTableExports.id }),
      );
    const remove = (login: string, id: string) =>
      inRequest(login, () =>
        m.db
          .delete(m.appTableExports)
          .where(eq(m.appTableExports.id, id))
          .returning({ id: m.appTableExports.id }),
      );
    const insert = (login: string, app: string) =>
      inRequest(login, () =>
        m.db.insert(m.appTableExports).values({
          ownerId: owner,
          appNodeId: app,
          sqliteTable: `${tag}_other`,
          tableNodeId: tableId,
        }),
      ).then(
        () => 'ok',
        // The answer a caller sees (THE mapper: a scope-write refusal, 403).
        // The database's own text differs in on (the write check of an app
        // that exists, the row rule of one that does not), as on every
        // write-check table.
        (e: unknown) => `${m.pgErrorCode(e)} refusal=${m.isScopeWriteRefusal(e)}`,
      );
    // Off too (fix round 3): the row rule holds in every mode (row level
    // security does not read the mode), so off answers as warn.
    for (const mode of ['off', 'warn', 'on'] as const) {
      setMode(mode);
      const before = await stateOf();
      for (const who of [mem3, mem]) {
        // Byte-equal to a random id's answer: the row is not there for it.
        expect(JSON.stringify(await update(who, exportId)), `${mode} update`).toBe(
          JSON.stringify(await update(who, randomUUID())),
        );
        expect(JSON.stringify(await remove(who, exportId)), `${mode} delete`).toBe(
          JSON.stringify(await remove(who, randomUUID())),
        );
        const made = await insert(who, appId);
        expect(made, `${mode} insert`).toBe('42501 refusal=true');
        expect(made).toBe(await insert(who, randomUUID()));
      }
      expect(await stateOf(), mode).toBe(before);
      // The app's Moderator (mem2 made Ro): its own export row.
      expect(await update(mem2, exportId)).toEqual([{ id: exportId }]);
    }
    expect(m.takeWriteRoleGaps()).toEqual([]);
    m.takeActorMisses();
  });

  it('S3 fix round 3: an editor of the app who does not manage it: app_table_export_set leaves no Table, remove answers the refusal (off, warn, on)', async () => {
    // Changed in fix round 3: before it, the set made the Table first and
    // the link insert was then refused (an orphan Table each try), and a
    // remove answered "no export link exists" (the read rule hid the link).
    const c = await import('@mantle/content/app-table-exports');
    const appId = randomUUID();
    const tableId = randomUUID();
    await x(sql`insert into nodes (id, owner_id, type, title, path) values
      (${appId}, ${owner}, 'app', ${`${tag} fr3 app`}, 'apps'),
      (${tableId}, ${owner}, 'table', ${`${tag} fr3 export`}, 'tables')`);
    for (const id of [appId, tableId]) await homeIn(id, ro);
    // mem may edit the app (Team holds it with Write), not manage it (only
    // reads Ro, its home).
    await x(
      sql`insert into item_grants (node_id, workspace_id, write) values (${appId}, ${team}, true)`,
    );
    await x(sql`insert into app_table_exports (owner_id, app_node_id, sqlite_table, table_node_id)
                values (${owner}, ${appId}, 'tasks', ${tableId})`);
    const tables = async () =>
      (
        await x<{ n: number }>(
          sql`select count(*)::int as n from nodes where owner_id = ${owner} and type = 'table'`,
        )
      )[0]!.n;
    const links = async () =>
      JSON.stringify(
        await x(sql`select * from app_table_exports where app_node_id = ${appId} order by id`),
      );
    const answer = (e: unknown) => `${m.pgErrorCode(e)} ${e instanceof Error ? e.message : e}`;
    for (const mode of ['off', 'warn', 'on'] as const) {
      setMode(mode);
      const [n0, l0] = [await tables(), await links()];
      for (const table of ['tasks', 'other']) {
        const set = await inRequest(mem, () => c.createAppTableExport(owner, appId, table)).then(
          () => 'ok',
          answer,
        );
        expect(set, `${mode} set ${table}`).toBe(`42501 ${c.APP_EXPORT_MANAGE_ERROR}`);
      }
      const removed = await inRequest(mem, () =>
        c.removeAppTableExport(owner, appId, 'tasks'),
      ).then((r) => `ok ${r}`, answer);
      expect(removed, `${mode} remove`).toBe(`42501 ${c.APP_EXPORT_MANAGE_ERROR}`);
      // No orphan Table, the link unchanged.
      expect(await tables(), mode).toBe(n0);
      expect(await links(), mode).toBe(l0);
    }
    // The tool throws the refusal (dispatch's mapper answers it), not "no
    // export link".
    const tools = await import('@mantle/tools');
    const remove = tools.BUILTIN_TOOLS.find((t) => t.slug === 'app_table_export_remove');
    expect(remove).toBeTruthy();
    const out = await inRequest(mem, () =>
      remove!.handler({ id: appId, table: 'tasks' }, {
        ownerId: owner,
        surface: { kind: 'web' },
      } as unknown as Parameters<NonNullable<typeof remove>['handler']>[1]),
    ).then(
      (r) => JSON.stringify(r),
      (e: unknown) => answer(e),
    );
    expect(out).toBe(`42501 ${c.APP_EXPORT_MANAGE_ERROR}`);
    m.takeActorMisses();
  });

  it('S3 fix round 3: PUT /api/profile/reminder-channel writes the brain’s row for the owner and an Admin user with Settings; one without gets a 403', async () => {
    // Owner decision 2026-10-17. Changed in fix round 3: before it, any
    // Admin user reached the brain's row (the database refused one without
    // Settings, a 500).
    const withS = randomUUID();
    const noS = randomUUID();
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${withS}, ${email('rcs')}, 'x', false, 'admin', 'Rhea Admin'),
      (${noS}, ${email('rcn')}, 'x', false, 'admin', 'Rex Admin')`);
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator, limits) values
      (${adminWs}, ${withS}, true, '{}'::jsonb),
      (${adminWs}, ${noS}, true, ${JSON.stringify({ areas: { settings: false } })}::jsonb)
      on conflict (workspace_id, login_id) do update set limits = excluded.limits`);
    const channelOf = async () =>
      (
        await x<{ c: string | null }>(
          sql`select preferences->>'reminderChannel' as c from profiles where user_id = ${owner}`,
        )
      )[0]?.c ?? null;
    for (const mode of ['off', 'warn', 'on'] as const) {
      setMode(mode);
      const put = (who: string, ch: string) =>
        call('/api/profile/reminder-channel', who, 'PUT', { reminderChannel: ch });
      const a = await put(owner, 'mobile');
      expect(a.status, `${mode} owner: ${a.text.slice(0, 200)}`).toBe(200);
      expect(await channelOf()).toBe('mobile');
      const b = await put(withS, 'telegram');
      expect(b.status, `${mode} settings: ${b.text.slice(0, 200)}`).toBe(200);
      expect(await channelOf()).toBe('telegram');
      const r = await put(noS, 'mobile');
      expect(r.status, `${mode} no settings`).toBe(403);
      expect(String(r.json.error)).toMatch(
        /^The brain's reminder delivery is changed by the brain owner or a user with the settings area/,
      );
      expect(await channelOf()).toBe('telegram');
    }
    m.takeActorMisses();
  });

  it('S3 fix round 3: read-only callers (a read key, an assistant with no user) and their profile rows (warn, on)', async () => {
    const c = await import('@mantle/content');
    // With the edit check on (pnpm test:edit-on) the read-only refusal on
    // profiles (0302) refuses the read key's own row; off, nothing does.
    const editOn = process.env.MANTLE_TEST_EDIT_CHECK === 'on';
    const rowOf = async (login: string) =>
      JSON.stringify(await x(sql`select preferences from profiles where user_id = ${login}`));
    await x(sql`insert into profiles (user_id) values (${mem}), (${owner}) on conflict do nothing`);
    const seen: unknown[] = [];
    for (const mode of ['warn', 'on'] as const) {
      setMode(mode);
      const [memBefore, ownerBefore] = [await rowOf(mem), await rowOf(owner)];
      // A read key: login(ro), its own row, in its request scope (no write
      // scope, as the session enters a read key's) and in a write scope.
      // The request slot names its own actor (the HTTP gate's, then the
      // session guard's), so the key is named inside it before the scope
      // is entered, as the session guard names a read key (session.ts
      // nameRequestLogin); an actor bound outside the slot does not reach
      // the write (fix round 4: it ran as login:rw).
      const scope = await m.viewerScopeFor({ login: mem });
      // A time zone per mode, so a write in on changes the row warn wrote.
      const tz = mode === 'warn' ? 'Asia/Tokyo' : 'Europe/Oslo';
      const asKey = (writes: boolean) =>
        m
          .runInRequestSlot(async () => {
            m.setRequestActor(m.loginActor(mem, 'ro'));
            m.enterRequestScope(scope, { writes, drafts: false });
            return c.updateProfilePreferences(mem, { timezone: tz });
          })
          .then(
            () => 'ok',
            (e: unknown) =>
              `${m.pgErrorCode(e) ?? String(e)} ${m.editRefusalDetail(e) ?? ''}`.trim(),
          );
      const key = await asKey(false);
      const keyMisses = m.takeActorMisses().length;
      const keyChanged = (await rowOf(mem)) !== memBefore;
      const keyW = await asKey(true);
      const keyWMisses = m.takeActorMisses().length;
      // An assistant turn with no user: the brain's row.
      const turn = await m
        .runAsActor({ kind: 'assistant', agentId: null }, () =>
          m.withTurnScope(
            { kind: 'assistant', loginId: null, ws: [team], modWs: [] },
            () => c.updateProfilePreferences(owner, { timezone: tz }),
            { writes: true },
          ),
        )
        .then(
          () => 'ok',
          (e: unknown) => m.pgErrorCode(e) ?? String(e),
        );
      const turnMisses = m.takeActorMisses().length;
      const ownerChanged = (await rowOf(owner)) !== ownerBefore;
      seen.push({ mode, key, keyW, misses: keyMisses + keyWMisses + turnMisses, turn });
      expect(ownerChanged, mode).toBe(false);
      expect(keyChanged, mode).toBe(!editOn);
    }
    // Pinned as they answer (fix round 4: the key now runs as login(ro)).
    // Edit check off: the read key's own row is written by the library in
    // warn and on, its request scope with or without writes (as main, where
    // profiles was a gap table rerun for any caller); nothing in the
    // database holds it, the gates above do (its requests carry no write
    // scope, its tools are read only). Edit check on: the read-only
    // refusal on profiles (0302) refuses it, 42501 ro_actor, in both actor
    // modes (the edit check's box mode decides, not the actor check's).
    // The brain's row from an assistant turn with no user: the row rule
    // refuses it in both (no login, no Settings area).
    const key = editOn ? '42501 ro_actor' : 'ok';
    expect(seen).toEqual([
      { mode: 'warn', key, keyW: key, misses: 0, turn: '42501' },
      { mode: 'on', key, keyW: key, misses: 0, turn: '42501' },
    ]);
  });

  /** A transaction on the write role as `login` in `mode`: the scope and the
   *  heads of `ids` first. Rolled back unless `commit`. */
  const asWriter = async <T>(
    login: string,
    mode: Mode,
    ids: string[],
    fn: (tx: postgres.TransactionSql) => Promise<T>,
    commit = false,
  ): Promise<{ value?: T; code?: string; message?: string; notices: string[] }> => {
    const scope = await m.viewerScopeFor({ login });
    const notices: string[] = [];
    const conn = postgres(
      (await import('@mantle/db/viewer')).viewerDatabaseUrl(
        scratch!.url,
        'write',
        (await import('@mantle/db/viewer')).viewerRolePassword(testKey, 'write'),
      ),
      { max: 1, prepare: false, onnotice: (n) => notices.push(String(n.message ?? '')) },
    );
    let out: { value?: T; code?: string; message?: string } = {};
    try {
      await conn.begin(async (tx) => {
        await tx`select set_config('mantle.actor', ${`login:rw:${login}`}, true),
                        set_config('mantle.write_mode', 'rw', true),
                        set_config('mantle.actor_check', ${mode}, true),
                        set_config('mantle.ws', ${`{${scope.ws.join(',')}}`}, true),
                        set_config('mantle.mod_ws', ${`{${scope.modWs.join(',')}}`}, true),
                        set_config('mantle.login_id', ${login}, true)`;
        await tx`select mantle_lock_heads(${`{${ids.join(',')}}`}::uuid[], 'update')`;
        try {
          out = { value: await fn(tx) };
        } catch (err) {
          const e = err as { code?: string; message?: string };
          out = { code: e.code ?? '?', message: e.message };
          throw new Rollback();
        }
        if (!commit) throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    } finally {
      await conn.end();
    }
    return { ...out, notices };
  };
  const homesOf = async (id: string) =>
    x<{ ws: string; home: boolean; by: string | null }>(
      sql`select workspace_id::text as ws, is_home as home, granted_by::text as by
            from item_grants where node_id = ${id} order by is_home desc, workspace_id`,
    );

  it('the home move is one call on the role: manage of the old home and a Moderator of the new one', async () => {
    const priv = await privateOf(mem);
    expect(priv).toBeTruthy();
    const item = randomUUID();
    await x(sql`insert into nodes (id, owner_id, type, title, path)
                values (${item}, ${owner}, 'note', ${`${tag} moved`}, 'notes')`);
    await homeIn(item, team);
    const move = (to: string) => (tx: postgres.TransactionSql) =>
      tx`select mantle_grant_move_home(${item}::uuid, ${to}::uuid, false, ${mem}::uuid)`;
    // Not a Moderator of the new home (mem only reads Ro): refused in on,
    // and in warn too since A6 round 2 (0291, A8 matrix F7 b: a grant change
    // the rule refuses is refused in every mode); warn still reports it.
    const roOn = await asWriter(mem, 'on', [item], move(ro));
    expect(roOn.code).toBe('42501');
    expect(roOn.message).toBe('not allowed to grant to that workspace');
    const roWarn = await asWriter(mem, 'warn', [item], move(ro));
    expect(roWarn.code).toBe('42501');
    expect(roWarn.message).toBe('not allowed to grant to that workspace');
    expect(roWarn.notices.join('\n')).toMatch(/a home move, not a Moderator of the workspace/);
    // Not a manager of the old home: mem only reads Ro.
    const inRo = randomUUID();
    await x(sql`insert into nodes (id, owner_id, type, title, path)
                values (${inRo}, ${owner}, 'note', ${`${tag} in ro`}, 'notes')`);
    await homeIn(inRo, ro);
    const notManager = await asWriter(
      mem,
      'on',
      [inRo],
      (tx) => tx`select mantle_grant_move_home(${inRo}::uuid, ${priv!}::uuid, false, ${mem}::uuid)`,
    );
    expect(notManager.code).toBe('42501');
    expect(notManager.message).toBe('not allowed to move this item');
    // Both: one call, one home after it (never two at once: 23505).
    const ok = await asWriter(mem, 'on', [item], move(priv!), true);
    expect(ok.code, ok.message).toBeUndefined();
    const after = await homesOf(item);
    expect(after.filter((g) => g.home).map((g) => g.ws)).toEqual([priv]);
    expect(after.map((g) => g.ws)).not.toContain(team);
    expect(after.find((g) => g.home)!.by).toBe(mem);
  });

  it('grants on the role: the derived columns only through the definer', async () => {
    const item = randomUUID();
    await x(sql`insert into nodes (id, owner_id, type, title, path)
                values (${item}, ${owner}, 'note', ${`${tag} granted`}, 'notes')`);
    await homeIn(item, team);
    const direct = await asWriter(
      mem,
      'on',
      [item],
      (tx) => tx`update item_grants set granted_by = ${mem}::uuid where node_id = ${item}`,
    );
    expect(direct.code).toBe('42501');
    expect(direct.message).toMatch(/^permission denied for table item_grants/);
    const priv = (await privateOf(mem))!;
    const add = await asWriter(
      mem,
      'on',
      [item],
      (tx) =>
        tx`select mantle_grant_change('add', ${item}::uuid, ${priv}::uuid, true, ${mem}::uuid)`,
      true,
    );
    expect(add.code, add.message).toBeUndefined();
    const row = (await homesOf(item)).find((g) => g.ws === priv);
    expect(row?.by).toBe(mem);
    // A grant to a workspace it does not moderate: refused in on.
    const toRo = await asWriter(
      mem,
      'on',
      [item],
      (tx) =>
        tx`select mantle_grant_change('add', ${item}::uuid, ${ro}::uuid, false, ${mem}::uuid)`,
    );
    expect(toRo.code).toBe('42501');
    expect(toRo.message).toBe('not allowed to grant to that workspace');
    void adminWs;
  });
  // ── Fix round 1 ───────────────────────────────────────────────────────────

  /** A note owned by the anchor, homed in `ws`. */
  const noteIn = async (ws: string, title: string) => {
    const id = randomUUID();
    await x(sql`insert into nodes (id, owner_id, type, title, path)
                values (${id}, ${owner}, 'note', ${title}, 'notes')`);
    await homeIn(id, ws);
    return id;
  };
  const failure = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: unknown) => e as Error & { code?: string; cause?: unknown },
    );
  /** The driver's own error under drizzle's wrapper. */
  const root = (e: (Error & { cause?: unknown }) | null) =>
    (e?.cause ?? e) as (Error & { code?: string }) | null;
  const profilesOf = async (login: string) =>
    (
      await x<{ n: number }>(sql`select count(*)::int as n from profiles where user_id = ${login}`)
    )[0]!.n;

  it('H1: a column or a function the role may not use is an error, never run again', async () => {
    setMode('warn');
    m.takeWriteRoleGaps();
    const by = async () =>
      (
        await x<{ by: string | null }>(
          sql`select granted_by::text as by from item_grants where node_id = ${teamNote} and is_home`,
        )
      )[0]?.by ?? null;
    const before = await by();
    // A column of a column-limited table (Postgres names the table).
    const column = await failure(
      inRequest(mem, () =>
        m.db.transaction(async (tx) => {
          await tx.execute(
            sql`update item_grants set granted_by = ${mem}::uuid where node_id = ${teamNote}`,
          );
        }),
      ),
    );
    expect(root(column)?.message).toMatch(/^permission denied for table item_grants/);
    expect(await by()).toBe(before);
    // A function the role holds no right on: on the system pool it would
    // run (and return nothing for a table that is not there).
    const fn = await failure(
      inRequest(mem, () =>
        m.db.transaction(async (tx) => {
          await tx.execute(
            sql`select mantle_write_role_sync_table('public.a2b2b_no_such_table', false, null)`,
          );
        }),
      ),
    );
    expect(root(fn)?.message).toMatch(
      /^permission denied for function mantle_write_role_sync_table/,
    );
    // Both noted (the suite fails on such a note left behind).
    expect(m.takeWriteRoleGaps()).toEqual([
      'permission denied for table item_grants',
      'permission denied for function mantle_write_role_sync_table',
    ]);
  });

  it('M1 (one path since plan v3 S3): in on a transaction runs once on the role: a refused item write stays refused, one commit, one hook', async () => {
    setMode('on');
    m.takeWriteRoleGaps();
    const roTitle = await titleOf(roNote);
    const own = await noteIn(team, `${tag} m1 own`);
    // Its own profile row (a gap table until S3), then an item write the
    // role refuses: the whole transaction is refused.
    const refused = await failure(
      inRequest(mem, () =>
        m.db.transaction(async (tx) => {
          await tx
            .insert(m.profiles)
            .values({ userId: mem, preferences: {} })
            .onConflictDoNothing();
          await tx
            .update(m.nodes)
            .set({ title: `${tag} m1 a` })
            .where(eq(m.nodes.id, roNote));
        }),
      ),
    );
    expect(m.isScopeWriteRefusal(refused), String(refused)).toBe(true);
    expect(await titleOf(roNote)).toBe(roTitle);
    // A refused item write (caught in a savepoint), then its own profile
    // row: the rest commits once (it ran twice while profiles was a gap).
    let runs = 0;
    await inRequest(mem, () =>
      m.db.transaction(async (tx) => {
        runs += 1;
        await tx
          .transaction((sp) =>
            sp
              .update(m.nodes)
              .set({ title: `${tag} m1 b` })
              .where(eq(m.nodes.id, roNote)),
          )
          .catch(() => undefined);
        await tx.insert(m.profiles).values({ userId: mem, preferences: {} }).onConflictDoNothing();
        await tx
          .update(m.nodes)
          .set({ title: `${tag} m1 own b` })
          .where(eq(m.nodes.id, own));
      }),
    );
    expect(runs).toBe(1);
    expect(await titleOf(roNote)).toBe(roTitle);
    expect(await titleOf(own)).toBe(`${tag} m1 own b`);
    expect(await profilesOf(mem)).toBe(1);
    // A system transaction (heads) that creates, registers a commit hook and
    // writes its profile row: one row, one hook.
    let hooks = 0;
    const title = `${tag} m1 once`;
    await inRequest(mem, () =>
      m.withCreateHome({ createWs: team, privateWs: null }, () =>
        m.withNodeInsertHeads(owner, [{ type: 'note', path: 'notes' }], async (tx) => {
          await tx
            .insert(m.nodes)
            .values({ ownerId: owner, type: 'note', title, path: 'notes', data: {} });
          await m.afterCommit(() => {
            hooks += 1;
          });
          await tx
            .insert(m.profiles)
            .values({ userId: mem, preferences: {} })
            .onConflictDoNothing();
        }),
      ),
    );
    expect(hooks).toBe(1);
    const made = await x<{ home: string }>(
      sql`select home_ws::text as home from nodes where title = ${title}`,
    );
    expect(made.map((r) => r.home)).toEqual([team]);
    expect(m.takeWriteRoleGaps()).toEqual([]);
    m.takeActorMisses();
  });

  it('L6 (one path since plan v3 S3): a profile write in a savepoint runs once, nothing noted', async () => {
    setMode('warn');
    m.takeWriteRoleGaps();
    await x(sql`delete from profiles where user_id = ${mem}`);
    let runs = 0;
    await inRequest(mem, () =>
      m.db.transaction(async (tx) => {
        runs += 1;
        await tx
          .transaction((sp) => sp.insert(m.profiles).values({ userId: mem, preferences: {} }))
          .catch(() => undefined);
      }),
    );
    expect(runs).toBe(1);
    expect(await profilesOf(mem)).toBe(1);
    expect(m.takeWriteRoleGaps()).toEqual([]);
  });

  it('M2: a write inside an open write transaction joins it; a pool of 3 never hangs', async () => {
    setMode('warn');
    const client = await import('@mantle/db/client');
    client.setWritePoolWaitForTests(3_000);
    try {
      const ids = await Promise.all(
        Array.from({ length: 6 }, (_, i) => noteIn(team, `${tag} m2 ${i}`)),
      );
      // Six at once, each with a top-level write and a system transaction
      // inside its own: before the fix each took a second connection of 3.
      const who = await writersOf(() =>
        Promise.all(
          ids.map((id, i) =>
            inRequest(mem, () =>
              m.db.transaction(async (tx) => {
                await tx
                  .update(m.nodes)
                  .set({ title: `${tag} m2 ${i} a` })
                  .where(eq(m.nodes.id, id));
                await m.db
                  .update(m.nodes)
                  .set({ title: `${tag} m2 ${i} b` })
                  .where(eq(m.nodes.id, id));
                await m.withHeads([id], 'update', (s) =>
                  s
                    .update(m.nodes)
                    .set({ title: `${tag} m2 ${i} c` })
                    .where(eq(m.nodes.id, id)),
                );
              }),
            ),
          ),
        ),
      );
      for (const [i, id] of ids.entries()) expect(await titleOf(id)).toBe(`${tag} m2 ${i} c`);
      expect(who.length).toBeGreaterThan(0);
      expect(
        who.every((w) => WRITER.test(w)),
        who.join(','),
      ).toBe(true);
      // The pool held by three open transactions: a fourth write waits at
      // most the bound, then fails (busy), never hangs.
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let holding = 0;
      const holders = ids.slice(0, 3).map((id) =>
        inRequest(mem, () =>
          m.db.transaction(async (tx) => {
            await tx
              .update(m.nodes)
              .set({ title: `${tag} m2 held` })
              .where(eq(m.nodes.id, id));
            holding += 1;
            await gate;
          }),
        ),
      );
      try {
        for (let i = 0; i < 200 && holding < 3; i += 1) {
          await new Promise((r) => setTimeout(r, 25));
        }
        expect(holding).toBe(3);
        const t0 = Date.now();
        const busy = await failure(
          inRequest(mem, () =>
            m.db
              .update(m.nodes)
              .set({ title: `${tag} m2 late` })
              .where(eq(m.nodes.id, ids[3]!)),
          ),
        );
        expect(root(busy)).toBeInstanceOf(client.WritePoolBusyError);
        expect(m.isBusy(busy)).toBe(true);
        expect(Date.now() - t0).toBeLessThan(8_000);
      } finally {
        release();
        await Promise.all(holders);
      }
      expect(await titleOf(ids[3]!)).toBe(`${tag} m2 3 c`);
    } finally {
      client.setWritePoolWaitForTests(null);
    }
  }, 60_000);

  it('M3: the visibility confirm reads in the write’s own transaction, workspaces past the scope through the definers', async () => {
    setMode('warn');
    const tree = await import('@mantle/content/tree');
    const other = (await call('/api/workspaces', mem2, 'POST', { name: `${tag} Other` })).json
      .id as string;
    expect(other).toBeTruthy();
    const folder = randomUUID();
    const label = `a2b2bf${randomUUID().slice(0, 6)}`;
    await x(sql`insert into nodes (id, owner_id, type, title, path)
                values (${folder}, ${owner}, 'branch', ${`${tag} folder`}, ${`pages.${label}`})`);
    await homeIn(folder, team);
    await x(sql`insert into item_grants (node_id, workspace_id) values (${folder}, ${other})`);
    const names = (d: Awaited<ReturnType<typeof tree.newItemDiff>>) =>
      (d.changes[0]?.alsoVisibleTo ?? []).map((w) => w.name).sort();
    const [before, after] = await inRequest(mem, () =>
      m.withHeads([folder], 'update', async (tx) => {
        // mem is not in Other: named through mantle_ws_names all the same.
        const d1 = await tree.newItemDiff(tx, owner, 'pages', `pages.${label}`, 'T');
        await tx.execute(
          sql`select mantle_grant_change('remove', ${folder}::uuid, ${other}::uuid, false, ${mem}::uuid)`,
        );
        // This transaction's own change is seen (guardRead read past it).
        const d2 = await tree.newItemDiff(tx, owner, 'pages', `pages.${label}`, 'T');
        return [d1, d2];
      }),
    );
    expect(names(before)).toContain(`${tag} Other`);
    expect(names(after)).not.toContain(`${tag} Other`);
    expect(names(after).length).toBeGreaterThan(0);
  });

  it('L5, L3, L7: a grant’s audit row only in a workspace of the scope, or one holding a grant row on an item whose home it manages', async () => {
    // Workspaces mem is not in.
    const other = (await call('/api/workspaces', mem2, 'POST', { name: `${tag} Elsewhere` })).json
      .id as string;
    const forged = (await call('/api/workspaces', mem2, 'POST', { name: `${tag} Forged` })).json
      .id as string;
    expect(other && forged).toBeTruthy();
    // `other` holds a grant on the Team note (mem manages its home).
    await m.withHeads([teamNote], 'update', (tx) =>
      tx.execute(
        sql`insert into item_grants (node_id, workspace_id) values (${teamNote}, ${other})`,
      ),
    );
    const ev = (ws: string, node: string) => (tx: postgres.TransactionSql) =>
      tx`select mantle_workspace_event(${ws}::uuid, ${mem}::uuid, 'grant.add',
                                       ${tx.json({ node })}::jsonb)`;
    // Ro: mem reads it, a workspace of its scope.
    const inScope = await asWriter(mem, 'on', [roNote], ev(ro, roNote));
    expect(inScope.code, inScope.message).toBeUndefined();
    // A workspace outside the scope, for an item mem does not manage.
    const outside = await asWriter(mem, 'on', [roNote], ev(other, roNote));
    expect(outside.code).toBe('42501');
    expect(outside.message).toBe('not allowed to grant to that workspace');
    // A workspace with a grant row on an item whose home (Team) mem manages.
    const manages = await asWriter(mem, 'on', [teamNote], ev(other, teamNote));
    expect(manages.code, manages.message).toBeUndefined();
    // L3: the same item, a workspace with no grant row on it: a forged
    // event, refused.
    const forge = await asWriter(mem, 'on', [teamNote], ev(forged, teamNote));
    expect(forge.code).toBe('42501');
    expect(forge.message).toBe('not allowed to grant to that workspace');
    await m.withHeads([teamNote], 'update', (tx) =>
      tx.execute(
        sql`delete from item_grants where node_id = ${teamNote} and workspace_id = ${other}`,
      ),
    );
  });

  // ── Fix round 2 ───────────────────────────────────────────────────────────

  it('M1 (round 2): joined writes run one after another; a failing one leaves the others committed', async () => {
    setMode('warn');
    const ids = await Promise.all([0, 1, 2].map((i) => noteIn(team, `${tag} j ${i}`)));
    await inRequest(mem, () =>
      m.db.transaction(async (tx) => {
        await tx
          .update(m.nodes)
          .set({ title: `${tag} j outer` })
          .where(eq(m.nodes.id, ids[0]!));
        const out = await Promise.allSettled([
          m.db
            .update(m.nodes)
            .set({ title: `${tag} j a` })
            .where(eq(m.nodes.id, ids[1]!)),
          // A statement that fails (no such kind).
          m.executeWrite(sql`update nodes set type = 'no_such_kind' where id = ${ids[2]!}`),
          m.db
            .update(m.nodes)
            .set({ title: `${tag} j c` })
            .where(eq(m.nodes.id, ids[2]!)),
        ]);
        expect(out.map((o) => o.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
      }),
    );
    expect(await titleOf(ids[0]!)).toBe(`${tag} j outer`);
    expect(await titleOf(ids[1]!)).toBe(`${tag} j a`);
    expect(await titleOf(ids[2]!)).toBe(`${tag} j c`);
  });

  it('M1 (round 2): a loop of 100 joins warns once and commits', async () => {
    setMode('warn');
    const id = await noteIn(team, `${tag} loop`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await inRequest(mem, () =>
        m.db.transaction(async () => {
          for (let i = 0; i < 100; i += 1) {
            await m.db
              .update(m.nodes)
              .set({ title: `${tag} loop ${i}` })
              .where(eq(m.nodes.id, id));
          }
        }),
      );
      const said = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((t) => /savepoints in one|nested calls in one/.test(t));
      expect(said).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
    expect(await titleOf(id)).toBe(`${tag} loop 99`);
  });

  it('L2 (plan v3 S3): mantle_gap_writer holds no right at all, the former gap tables neither', async () => {
    const sys = postgres(scratch!.url, { max: 1, prepare: false, onnotice: () => {} });
    try {
      const res = await sys
        .begin(async (tx) => {
          await tx`set local role mantle_gap_writer`;
          const [me] = await tx<{ u: string }[]>`select current_user as u`;
          const denied = async (q: Promise<unknown>) =>
            q.then(
              () => null,
              (e: { message?: string }) => e.message ?? 'error',
            );
          await tx`savepoint s1`;
          const profile = await denied(
            tx`insert into profiles (user_id, preferences) values (${mem2}, '{}'::jsonb)
               on conflict (user_id) do nothing`,
          );
          await tx`rollback to savepoint s1`;
          const write = await denied(tx`update nodes set title = 'x' where id = ${teamNote}`);
          throw Object.assign(new Error('rollback'), { me: me!.u, profile, write });
        })
        .catch((e: { me?: string; profile?: string; write?: string }) => e);
      expect(res.me).toBe('mantle_gap_writer');
      expect(res.profile).toMatch(/^permission denied for table profiles/);
      expect(res.write).toMatch(/^permission denied for table nodes/);
    } finally {
      await sys.end();
    }
  });

  it('L4: a workspace is named only through the change’s own folder or item', async () => {
    setMode('warn');
    const tree = await import('@mantle/content/tree');
    const elsewhere = (await call('/api/workspaces', mem2, 'POST', { name: `${tag} Unseen` })).json
      .id as string;
    // `elsewhere` holds a grant on a note mem reads (Team), not on the folder.
    await m.withHeads([teamNote], 'update', (tx) =>
      tx.execute(
        sql`insert into item_grants (node_id, workspace_id) values (${teamNote}, ${elsewhere})`,
      ),
    );
    const named = await inRequest(mem, () =>
      m.withSystemTx(async (tx) => {
        const rows = (await tx.execute(sql`
          select mantle_ws_names(array[${elsewhere}::uuid], ${teamNote}::uuid) as via_item,
                 mantle_ws_names(array[${elsewhere}::uuid], ${roNote}::uuid) as via_other`)) as unknown as {
          via_item: unknown[];
          via_other: unknown[];
        }[];
        return rows[0]!;
      }),
    );
    expect(named.via_item).toHaveLength(1);
    expect(named.via_other).toEqual([]);
    // Round 3: the brain's Admin workspace is named with no folder (a new
    // item at a kind's root lands there), to a member too.
    const admin = await inRequest(mem, () =>
      m.withSystemTx(async (tx) => {
        const rows = (await tx.execute(
          sql`select mantle_ws_names(array[${adminWs}::uuid], null) as n`,
        )) as unknown as { n: unknown[] }[];
        return rows[0]!.n;
      }),
    );
    expect(admin).toHaveLength(1);
    await m.withHeads([teamNote], 'update', (tx) =>
      tx.execute(
        sql`delete from item_grants where node_id = ${teamNote} and workspace_id = ${elsewhere}`,
      ),
    );
    void tree;
  });
  // ── Fix round 3 ───────────────────────────────────────────────────────────

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  for (const mode of ['warn', 'on'] as const) {
    it(`A (round 3, ${mode}): a transaction that fails while a join runs sends nothing of it after its rollback`, async () => {
      setMode(mode);
      const client = await import('@mantle/db/client');
      m.takeWriteRoleGaps();
      const id = await noteIn(team, `${tag} A ${mode}`);
      const before = await titleOf(id);
      const late: unknown[] = [];
      let runs = 0;
      const err = await failure(
        inRequest(mem, () =>
          m.db.transaction(async (tx) => {
            runs += 1;
            // Its own profile row first (a gap table until plan v3 S3, which
            // ran the work again checked in on): one run now in every mode.
            await tx
              .insert(m.profiles)
              .values({ userId: mem, preferences: {} })
              .onConflictDoNothing();
            await tx
              .update(m.nodes)
              .set({ title: `${tag} A outer` })
              .where(eq(m.nodes.id, id));
            const join = (async () => {
              await m.db
                .update(m.nodes)
                .set({ title: `${tag} A j1` })
                .where(eq(m.nodes.id, id));
              await sleep(200);
              await m.db
                .update(m.nodes)
                .set({ title: `${tag} A j2` })
                .where(eq(m.nodes.id, id));
            })();
            join.catch((e: unknown) => late.push(e));
            await Promise.all([join, Promise.reject(new Error('a step that is not the database'))]);
          }),
        ),
      );
      expect(err?.message).toBe('a step that is not the database');
      expect(runs).toBe(1);
      await sleep(500);
      // Rolled back, and nothing written after.
      expect(await titleOf(id)).toBe(before);
      expect(late).toHaveLength(1);
      expect(root(late[0] as Error)).toBeInstanceOf(client.JoinedWriteEndedError);
      m.takeWriteRoleGaps();
      m.takeActorMisses();
    });
  }

  it('C (round 3): a nested transaction beside a join is in line: its rollback leaves the join’s rows', async () => {
    setMode('warn');
    const [a, b] = await Promise.all([noteIn(team, `${tag} C a`), noteIn(team, `${tag} C b`)]);
    await inRequest(mem, () =>
      m.db.transaction(async (tx) => {
        const out = await Promise.allSettled([
          tx.transaction(async (sp) => {
            await sp
              .update(m.nodes)
              .set({ title: `${tag} C inner` })
              .where(eq(m.nodes.id, a));
            await sleep(100);
            throw new Error('the inner one rolls back');
          }),
          m.db
            .update(m.nodes)
            .set({ title: `${tag} C joined` })
            .where(eq(m.nodes.id, b)),
        ]);
        expect(out.map((o) => o.status)).toEqual(['rejected', 'fulfilled']);
      }),
    );
    expect(await titleOf(a)).toBe(`${tag} C a`);
    expect(await titleOf(b)).toBe(`${tag} C joined`);
  });

  it('E (round 3): one savepoint count per transaction, joins and nested system transactions alike', async () => {
    setMode('warn');
    const id = await noteIn(team, `${tag} E`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await inRequest(mem, () =>
        m.db.transaction(async () => {
          for (let i = 0; i < 20; i += 1) {
            await m.db
              .update(m.nodes)
              .set({ title: `${tag} E ${i}` })
              .where(eq(m.nodes.id, id));
          }
          await m.withSystemTx(async () => {
            for (let i = 0; i < 20; i += 1) {
              await m.withSystemTx((s) =>
                s
                  .update(m.nodes)
                  .set({ title: `${tag} E n${i}` })
                  .where(eq(m.nodes.id, id)),
              );
            }
          });
        }),
      );
      const said = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((t) => /savepoints in one|nested calls in one/.test(t));
      expect(said).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
    expect(await titleOf(id)).toBe(`${tag} E n19`);
  });

  it('B (round 3): a member’s Recall map write over MCP works in on (on the write role, no gap writer since S3)', async () => {
    setMode('on');
    m.takeWriteRoleGaps();
    const ls = await import('@mantle/mcp-core');
    const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
    const { Client } = await import('@modelcontextprotocol/client');
    const prepared = await ls.prepareCallerTools({
      role: 'member',
      anchorId: owner,
      loginId: mem,
      via: 'oauth',
      write: true,
    });
    const server = new McpServer({ name: 'test', version: '0' });
    ls.registerPreparedTools(server, prepared);
    const [ta, tb] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 'a2b2b', version: '0' });
    await Promise.all([server.connect(ta), c.connect(tb)]);
    type Reply = { isError?: boolean; content?: { text?: string }[] };
    const textOf = (r: Reply) => (r.content ?? []).map((x) => x.text ?? '').join('\n');
    try {
      const made = (await c.callTool({
        name: 'recall_map_create',
        arguments: { title: `${tag} map`, enter_when: 'when testing A2b2b in on' },
      })) as Reply;
      expect(made.isError, textOf(made)).not.toBe(true);
      const slug = (JSON.parse(textOf(made)) as { map?: string }).map;
      expect(slug, textOf(made)).toBeTruthy();
      const updated = (await c.callTool({
        name: 'recall_map_update',
        arguments: { map: slug, title: `${tag} map renamed` },
      })) as Reply;
      expect(updated.isError, textOf(updated)).not.toBe(true);
      expect(textOf(updated)).not.toMatch(/permission denied|internal error/i);
      const [row] = await x<{ title: string }>(
        sql`select title from recall_maps where slug = ${slug!}`,
      );
      expect(row?.title).toBe(`${tag} map renamed`);
    } finally {
      await c.close();
    }
    expect(m.takeWriteRoleGaps()).toEqual([]);
    m.takeActorMisses();
  });
  // ── Fix round 4 ───────────────────────────────────────────────────────────

  it('N1 (round 4): a statement of an ended write transaction sends nothing, its SET neither', async () => {
    setMode('warn');
    const client = await import('@mantle/db/client');
    let kept: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> } | null = null;
    // A write transaction that sends no statement of its own (its SET goes
    // with the first one), its client kept past its end.
    await inRequest(mem, () =>
      m.db.transaction(async (tx) => {
        kept = tx;
      }),
    );
    const before = client.watchedSendsForTests();
    const late = await failure(
      inRequest(mem, async () => kept!.execute(sql`select 1`) as Promise<unknown>),
    );
    await sleep(100);
    expect(root(late)).toBeInstanceOf(client.JoinedWriteEndedError);
    expect(client.watchedSendsForTests()).toBe(before);
  });

  it('N2 (round 4): a nested system transaction on the write role is counted once', async () => {
    setMode('warn');
    const id = await noteIn(team, `${tag} N2`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // 20 joins, the joined system transaction and 10 nested: 31, under 33.
      await inRequest(mem, () =>
        m.db.transaction(async () => {
          for (let i = 0; i < 20; i += 1) {
            await m.db
              .update(m.nodes)
              .set({ title: `${tag} N2 ${i}` })
              .where(eq(m.nodes.id, id));
          }
          await m.withSystemTx(async () => {
            for (let i = 0; i < 10; i += 1) {
              await m.withSystemTx((s) =>
                s
                  .update(m.nodes)
                  .set({ title: `${tag} N2 n${i}` })
                  .where(eq(m.nodes.id, id)),
              );
            }
          });
        }),
      );
      const said = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((t) => /savepoints in one|nested calls in one/.test(t));
      expect(said).toEqual([]);
    } finally {
      warn.mockRestore();
    }
    expect(await titleOf(id)).toBe(`${tag} N2 n9`);
  });
  it('N6 (round 5): a system-pool transaction inside a live write transaction counts its own nested calls', async () => {
    setMode('warn');
    const id = await noteIn(team, `${tag} N6`);
    // Another row for the system transaction: the outer one holds `id`'s lock.
    const other = await noteIn(team, `${tag} N6 other`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await inRequest(mem, () =>
        m.db.transaction(async (tx) => {
          await tx
            .update(m.nodes)
            .set({ title: `${tag} N6 outer` })
            .where(eq(m.nodes.id, id));
          await m.runAsSystem('test:a2b2b', () =>
            m.withSystemTx(async () => {
              for (let i = 0; i < 40; i += 1) {
                await m.withSystemTx((s) =>
                  s
                    .update(m.nodes)
                    .set({ title: `${tag} N6 ${i}` })
                    .where(eq(m.nodes.id, other)),
                );
              }
            }),
          );
        }),
      );
      const said = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((t) => /nested calls in one/.test(t));
      expect(said).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});
