/**
 * Arch A2b2b: the login write gateway (packages/db/src/client.ts). A scoped
 * login write runs on the write role (mantle_write_user) while the actor
 * check is warn or on, and on the system pool, as before, while it is off.
 * Through the real app (createApp) on a migrated scratch database; which
 * role sent each write to `nodes` is read from a statement trigger that
 * records session_user (this scratch database only).
 *
 *  - login: a member's create runs on the write role in warn and on, and
 *    lands in its private workspace (made on the first create, after the
 *    request's scope was read: the gateway adds it to the write scope);
 *  - off: the same create runs on the system pool, nothing on the role;
 *  - an Admin user's write request stays on the system pool (its reads are
 *    unscoped, W6a M1);
 *  - what the database refuses and the app would let through: warn reports
 *    it and runs it, on refuses it with a scope-write refusal (a 403);
 *  - assistant, link and contact actors with a write scope: on the role, a
 *    create in a workspace they moderate goes through, one with no
 *    Moderator of its home is refused; system work in the same scope stays
 *    on the system pool;
 *  - a write-role gap (a table the role holds no right on, in a
 *    transaction) runs again on the system pool and is logged; a typed or
 *    raw single write to such a table goes there up front;
 *  - grants (0279): the home move is one call (manage of the old home and a
 *    Moderator of the new one), and the role writes the derived grant
 *    columns only through the definer.
 *  - fix round 1: a column or a function denial is an error, never run
 *    again (H1); in on a gap's rerun keeps the role's checks, one commit
 *    and one commit hook (M1); a gap caught in a savepoint still reruns
 *    (L6); writes inside an open write transaction join it and the pool's
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
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

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
    delete process.env.MANTLE_ADMIN_READS;
    m = await import('@mantle/db');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${email('owner')}, 'x', true, 'admin', 'Olive Owner'),
      (${mem}, ${email('mem')}, 'x', false, 'member', 'Mia Member'),
      (${mem2}, ${email('mem2')}, 'x', false, 'member', 'Max Member')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
    const ws = await x<{ id: string; key: string | null }>(sql`
      select id::text as id, bridge_key as key from workspaces where owner_id = ${owner}`);
    team = ws.find((w) => w.key === 'team')!.id;
    adminWs = ws.find((w) => w.key === 'admin')!.id;
    // Which role sent each write to nodes (this scratch database only).
    await x(sql`create table a2b2b_seen (id bigserial primary key, who text not null, op text)`);
    await x(
      sql.raw(`create function a2b2b_seen_trg() returns trigger language plpgsql
      security definer set search_path = public as $$
      begin insert into a2b2b_seen (who, op) values (session_user, tg_op); return null; end $$`),
    );
    await x(sql`create trigger zz_a2b2b_seen after insert or update or delete on nodes
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

  it('off: the same create runs on the system pool, nothing on the write role', async () => {
    setMode('off');
    let status = 0;
    const who = await writersOf(async () => {
      status = (await call('/api/notes', mem, 'POST', { title: `${tag} off note` })).status;
    });
    expect(status).toBe(201);
    expect(who.length).toBeGreaterThan(0);
    expect(who.filter((w) => WRITER.test(w))).toEqual([]);
  });

  it('an Admin user’s write request stays on the system pool (its reads are unscoped)', async () => {
    const who = await writersOf(async () => {
      const r = await call('/api/notes', owner, 'POST', { title: `${tag} admin note` });
      expect(r.status, r.text.slice(0, 200)).toBe(201);
    });
    expect(who.length).toBeGreaterThan(0);
    expect(who.filter((w) => WRITER.test(w))).toEqual([]);
  });

  it('what only the database refuses: warn reports and runs it, on refuses it (a scope-write refusal, 403)', async () => {
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
    setMode('warn');
    expect(await edit(`${tag} warn edit`)).toHaveLength(1);
    expect(await titleOf(roNote)).toBe(`${tag} warn edit`);
    expect(m.takeActorMisses().map((x) => x.check)).toContain(
      'UPDATE on nodes: no edit of the item (refused when the check is on)',
    );
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
    for (const mode of ['warn', 'on'] as const) {
      setMode(mode);
      for (const a of actors) {
        const name = `${mode} ${a.actor.kind}`;
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

  it('a write-role gap runs again on the system pool and is logged; a single write to such a table goes there up front', async () => {
    m.takeWriteRoleGaps();
    // A transaction that writes a table the role holds no right on.
    await inRequest(mem, () =>
      m.db.transaction(async (tx) => {
        await tx.insert(m.profiles).values({ userId: mem, preferences: {} }).onConflictDoNothing();
      }),
    );
    expect(m.takeWriteRoleGaps()).toEqual(['permission denied for table profiles']);
    expect(
      (
        await x<{ n: number }>(sql`select count(*)::int as n from profiles where user_id = ${mem}`)
      )[0]!.n,
    ).toBe(1);
    // A typed and a raw single write: decided by their table, no gap.
    await inRequest(mem, async () => {
      await m.db
        .update(m.profiles)
        .set({ preferences: { timezone: 'UTC' } })
        .where(eq(m.profiles.userId, mem));
      await m.executeWrite(
        sql`update profiles set preferences = preferences where user_id = ${mem}`,
      );
    });
    expect(m.takeWriteRoleGaps()).toEqual([]);
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
    // Not a Moderator of the new home (mem only reads Ro): refused in on;
    // warn reports it and runs it.
    const roOn = await asWriter(mem, 'on', [item], move(ro));
    expect(roOn.code).toBe('42501');
    expect(roOn.message).toBe('not allowed to grant to that workspace');
    const roWarn = await asWriter(mem, 'warn', [item], move(ro));
    expect(roWarn.code, roWarn.message).toBeUndefined();
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

  it('M1: in on a gap runs again checked: a refused item write stays refused, nothing commits twice', async () => {
    setMode('on');
    m.takeWriteRoleGaps();
    const roTitle = await titleOf(roNote);
    const own = await noteIn(team, `${tag} m1 own`);
    // A gap, then an item write the role refuses: refused in the rerun too.
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
    // A refused item write (caught in a savepoint), then a gap: the rerun
    // refuses it again; the rest commits once.
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
    expect(runs).toBe(2);
    expect(await titleOf(roNote)).toBe(roTitle);
    expect(await titleOf(own)).toBe(`${tag} m1 own b`);
    expect(await profilesOf(mem)).toBe(1);
    // A system transaction (heads) that creates, registers a commit hook and
    // meets a gap: one row, one hook, after the checked rerun.
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
    expect(m.takeWriteRoleGaps().every((g) => g === 'permission denied for table profiles')).toBe(
      true,
    );
    m.takeActorMisses();
  });

  it('L6: a gap caught in a savepoint still runs the transaction again, and is noted', async () => {
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
    expect(runs).toBe(2);
    expect(await profilesOf(mem)).toBe(1);
    expect(m.takeWriteRoleGaps()).toEqual(['permission denied for table profiles']);
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

  it('L5: a grant’s audit row only in a workspace of the scope, or for an item whose home it manages', async () => {
    // A workspace mem is not in.
    const other = (await call('/api/workspaces', mem2, 'POST', { name: `${tag} Elsewhere` })).json
      .id as string;
    expect(other).toBeTruthy();
    const ev = (ws: string, node: string) => (tx: postgres.TransactionSql) =>
      tx`select mantle_workspace_event(${ws}::uuid, ${mem}::uuid, 'grant.add',
                                       ${JSON.stringify({ node })}::jsonb)`;
    // Ro: mem reads it, a workspace of its scope.
    const inScope = await asWriter(mem, 'on', [roNote], ev(ro, roNote));
    expect(inScope.code, inScope.message).toBeUndefined();
    // A workspace outside the scope, for an item mem does not manage.
    const outside = await asWriter(mem, 'on', [roNote], ev(other, roNote));
    expect(outside.code).toBe('42501');
    expect(outside.message).toBe('not allowed to grant to that workspace');
    // The same workspace for an item whose home (Team) mem manages.
    const manages = await asWriter(mem, 'on', [teamNote], ev(other, teamNote));
    expect(manages.code, manages.message).toBeUndefined();
  });
});
