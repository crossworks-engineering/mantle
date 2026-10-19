/**
 * Admin acts become definers, part c2 (plan v3.2; migration 0310): the item
 * gate's three Admin acts as SECURITY DEFINER functions that check inside,
 * their requests in the login's scope, on a migrated scratch database, in
 * warn and in on (the actor and the edit check together, as on the fleet):
 *
 *  - each definer in a hand-set scope: an Admin user yes as today (with and
 *    without the users area where it matters); a member, role drift and no
 *    scope: refused (42501) or told to go the link's way, nothing written;
 *  - each route through the full HTTP pipeline (runRoute): an Admin user
 *    with the users area closes a link of an item it does not read; one
 *    without hears the gate's 404; Can write needs only an Admin user;
 *  - member-negative per route (the guard's 403), and role drift on Can
 *    write (the guard's 403 body, from inside the definer);
 *  - the trash: the purge rule stays owner-only for a held app, a non-owner
 *    purge is refused with nothing removed, and no app database file is
 *    touched by any refused path.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/s6-c2-admin-acts.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;

vi.mock('pg-boss', () => {
  class PgBoss {
    async start() {}
    async stop() {}
    async createQueue() {}
    async send() {
      return 'job';
    }
    on() {}
  }
  return { PgBoss, default: PgBoss };
});

/** The database's or the runtime's own words: never in a reply. */
const RAW =
  /Failed query|withSystemTx|runInSystemTx|SQLSTATE|DrizzleQueryError|drizzle-orm|permission denied for|violates|duplicate key|does not exist|\n\s+at \S/i;

const NOT_FOUND = { ok: false, error: 'not found' };
const MEMBER_LOGIN = {
  error: 'forbidden',
  reason: 'member-login',
  message: 'Not available to member logins.',
};
const HELD = {
  error: 'forbidden',
  reason: 'item-workspace',
  message:
    'This app was deleted by someone other than the brain owner: only the owner deletes it for good.',
};

type Mode = 'warn' | 'on';

describe.skipIf(!DB_URL)('S6 c2: the item gate’s three Admin acts as definers', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let raw: ReturnType<typeof postgres>;
  let m: typeof import('@mantle/db');
  let actorMode: typeof import('../../../packages/db/src/actor');
  let runRoute: typeof import('./run-route').runRoute;
  let dir = '';
  const tag = `s6c2${randomUUID().slice(0, 6)}`;
  const L = {
    owner: randomUUID(),
    admin: randomUUID(),
    limited: randomUUID(),
    member: randomUUID(),
    /** Role admin, no seat in the Admin workspace (role drift). */
    drift: randomUUID(),
  };
  const ws = { admin: '', other: '' };
  const root = { id: '', path: 'notes' };
  const recorded: string[] = [];

  const setMode = async (mode: Mode) => {
    await raw`select mantle_set_actor_check(${mode}, 50, 'test')`;
    await raw`select mantle_set_edit_check(${mode}, 50, 'test')`;
    process.env.MANTLE_ACTOR_CHECK = mode;
    actorMode.noteBoxActorCheckMode(mode);
    expect(m.actorCheckMode()).toBe(mode);
  };

  const call = async (name: string, who: string, method: string, url: string, body?: unknown) => {
    const res = await runRoute(who, method, url, body);
    const text = await res.text();
    recorded.push(`${name}: ${res.status} ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
    expect(text, name).not.toMatch(RAW);
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // not JSON: the status says it
    }
    return { status: res.status, text, json };
  };

  /** One definer call in a scope set by hand: `as` the scope's login (null:
   *  none), its live workspaces. The SQLSTATE of a refusal, else the rows. */
  const inScope = async <T>(
    as: string | null,
    q: (tx: postgres.TransactionSql) => Promise<T>,
  ): Promise<{ code: string | null; rows: T | null }> => {
    const s = as ? await m.loginScopeFor(as) : { ws: [], modWs: [] };
    try {
      const rows = await raw.begin(async (tx) => {
        await tx`select set_config('mantle.actor', 'system:test', true),
                        set_config('mantle.ws', ${`{${s.ws.join(',')}}`}, true),
                        set_config('mantle.mod_ws', ${`{${s.modWs.join(',')}}`}, true),
                        set_config('mantle.scope_login', ${as ?? ''}, true)`;
        return q(tx);
      });
      return { code: null, rows: rows as T };
    } catch (err) {
      return { code: (err as { code?: string }).code ?? 'none', rows: null };
    }
  };

  /** A note or an app homed in `home`, raw, as the system. */
  const makeItem = async (type: 'note' | 'app', home: string): Promise<string> => {
    const id = randomUUID();
    await raw.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`select mantle_lock_heads(array[${root.id}]::uuid[], 'share')`;
      await tx`insert into nodes (id, owner_id, type, title, path, data)
               values (${id}, ${L.owner}, ${type}, ${`${tag} ${type} ${id.slice(0, 8)}`},
                       ${root.path}::ltree, ${raw.json({ rank: 'a0' })})`;
    });
    await raw.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
      await tx`delete from item_grants where node_id = ${id} and via_folder_id is null`;
      await tx`insert into item_grants (node_id, workspace_id, is_home, write)
               values (${id}, ${home}, true, false)`;
    });
    return id;
  };

  /** A share row of `node`, raw: an open link, or one naming a contact. */
  const makeShare = async (node: string, type: string, contact = false): Promise<string> => {
    const id = randomUUID();
    let c: string | null = null;
    if (contact) {
      c = randomUUID();
      await raw.begin(async (tx) => {
        await tx`select set_config('mantle.actor', 'system:test', true)`;
        await tx`insert into nodes (id, owner_id, type, title, path)
                 values (${c}, ${L.owner}, 'contact', ${`${tag} contact`}, 'contacts'::ltree)`;
      });
    }
    await raw.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`insert into shares (id, owner_id, node_id, node_type, token, contact_id)
               values (${id}, ${L.owner}, ${node}, ${type}, ${randomUUID()}, ${c})`;
    });
    return id;
  };

  const shareRow = async (id: string) =>
    (
      await raw<{ live: boolean; can_write: boolean }[]>`
        select revoked_at is null as live, can_write from shares where id = ${id}`
    )[0]!;

  /** A deleted app in the trash: its pre_delete snapshot, homed in `home`
   *  (none: no home stored), held when another login deleted it. */
  const trashApp = async (home: string | null, held: boolean): Promise<string> => {
    const id = randomUUID();
    await raw.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`insert into node_snapshots (owner_id, node_id, node_kind, seq, trigger, actor, code)
        values (${L.owner}, ${id}, 'app', 1, 'pre_delete', 'owner',
                ${raw.json({
                  meta: {
                    title: `${tag} gone`,
                    ...(home ? { homeWs: home } : {}),
                    ...(held ? { keepForOwner: true } : {}),
                  },
                })})`;
    });
    return id;
  };

  const trashRows = async (app: string) =>
    (
      await raw<{ n: number }[]>`select count(*)::int as n from node_snapshots
      where node_id = ${app}`
    )[0]!.n;

  /** Every file under the app database folder, with its size and time. */
  const appFiles = async (): Promise<string[]> => {
    const out: string[] = [];
    const walk = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else {
          const s = await stat(p);
          out.push(`${p} ${s.size} ${s.mtimeMs}`);
        }
      }
    };
    await walk(process.env.APP_DB_DIR!);
    return out.sort();
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(DB_URL!);
    dir = await mkdtemp(path.join(tmpdir(), 's6-c2-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 's6-c2-admin-acts-secret-at-least-32-characters';
    delete process.env.MANTLE_DETACHED_DEV;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the S6 c2 test', { status: 503 })),
    );
    m = await import('@mantle/db');
    actorMode = await import('../../../packages/db/src/actor');
    runRoute = (await import('./run-route')).runRoute;
    raw = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });

    for (const [who, id] of Object.entries(L)) {
      const role = who === 'member' ? 'member' : 'admin';
      await raw`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
        values (${id}, ${`${tag}-${who}@example.invalid`}, 'x', ${who === 'owner'}, ${role},
                ${who})`;
    }
    await raw`insert into spaces (id, kind, login_id) values (${L.owner}, 'brain', ${L.owner})
              on conflict (id) do nothing`;
    await raw`select * from mantle_ws_migrate()`;
    ws.admin = (
      await raw<{ id: string }[]>`select id::text as id from workspaces
                                    where owner_id = ${L.owner} and is_admin`
    )[0]!.id;
    ws.other = (
      await raw<{ id: string }[]>`insert into workspaces (owner_id, name)
        values (${L.owner}, ${`${tag} other`}) returning id::text as id`
    )[0]!.id;
    await raw`delete from workspace_users where workspace_id = ${ws.other}`;
    await raw`insert into workspace_users (workspace_id, login_id, moderator)
      values (${ws.other}, ${L.member}, true)`;
    for (const id of [L.admin, L.limited]) {
      await raw`insert into workspace_users (workspace_id, login_id, moderator, limits)
        values (${ws.admin}, ${id}, true,
                ${raw.json(id === L.limited ? { areas: { users: false } } : {})})
        on conflict (workspace_id, login_id)
        do update set moderator = true, limits = excluded.limits`;
    }
    await raw`delete from workspace_users where login_id = ${L.drift}`;
    await raw`insert into nodes (owner_id, type, title, path)
      select ${L.owner}, 'branch', 'notes', 'notes'::ltree
       where not exists (select 1 from nodes where owner_id = ${L.owner}
                           and type = 'branch' and path = 'notes'::ltree)`;
    root.id = (
      await raw<{ id: string }[]>`select id::text as id from nodes
        where owner_id = ${L.owner} and type = 'branch' and path = 'notes'::ltree`
    )[0]!.id;
    // An app database file the trash paths must never touch.
    await mkdir(path.join(dir, 'apps', '_snapshots'), { recursive: true });
    await writeFile(path.join(dir, 'apps', '_snapshots', `${tag}.db`), 'app data');
    m.takeActorMisses();
  }, 300_000);

  afterAll(async () => {
    console.log(['S6 c2 Admin acts, each answer:', ...recorded].join('\n  '));
    process.env.MANTLE_ACTOR_CHECK = 'warn';
    vi.unstubAllGlobals();
    await raw?.end();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  for (const mode of ['warn', 'on'] as const) {
    it(`${mode}: mantle_share_close_admin answers by the users area, inside`, async () => {
      await setMode(mode);
      const note = await makeItem('note', ws.other);
      const close = (as: string | null, share: string) =>
        inScope(as, (tx) => tx<{ o: string }[]>`select mantle_share_close_admin(${share}) as o`);
      const s = await makeShare(note, 'note');
      for (const who of ['limited', 'member', 'drift'] as const) {
        const r = await close(L[who], s);
        expect(r.rows?.[0]?.o, who).toBe('no-area');
        expect((await shareRow(s)).live, who).toBe(true);
      }
      expect((await close(null, s)).code).toBe('42501');
      expect((await close(L.admin, s)).rows?.[0]?.o).toBe('closed');
      expect((await shareRow(s)).live).toBe(false);
      expect((await close(L.admin, s)).rows?.[0]?.o).toBe('gone');
      expect((await close(L.admin, randomUUID())).rows?.[0]?.o).toBe('gone');
    });

    it(`${mode}: mantle_share_contact_write_set needs an Admin user, no area`, async () => {
      await setMode(mode);
      const app = await makeItem('app', ws.other);
      const s = await makeShare(app, 'app', true);
      const set = (as: string | null, share: string, v: boolean) =>
        inScope(
          as,
          (tx) => tx<{ outcome: string }[]>`select outcome
          from mantle_share_contact_write_set(${share}, ${v})`,
        );
      for (const as of [L.member, L.drift, null]) {
        expect((await set(as, s, true)).code, String(as)).toBe('42501');
        expect((await shareRow(s)).can_write).toBe(false);
      }
      expect((await set(L.limited, s, true)).rows?.[0]?.outcome).toBe('ok');
      expect((await shareRow(s)).can_write).toBe(true);
      const link = await makeShare(app, 'app');
      expect((await set(L.member, link, true)).rows?.[0]?.outcome).toBe('not-contact');
      const noteShare = await makeShare(await makeItem('note', ws.other), 'note', true);
      expect((await set(L.admin, noteShare, true)).rows?.[0]?.outcome).toBe('write-not-app');
    });

    it(`${mode}: mantle_app_trash_act keeps the owner-only purge`, async () => {
      await setMode(mode);
      const before = await appFiles();
      const act = (as: string | null, app: string, a: string) =>
        inScope(
          as,
          (tx) => tx<{ outcome: string }[]>`select outcome
          from mantle_app_trash_act(${app}, ${a})`,
        );
      const held = await trashApp(ws.admin, true);
      for (const as of [L.member, L.drift, null]) {
        expect((await act(as, held, 'purge')).code, String(as)).toBe('42501');
      }
      expect((await act(L.admin, held, 'purge')).rows?.[0]?.outcome).toBe('held');
      expect((await act(L.limited, held, 'purge')).rows?.[0]?.outcome).toBe('held');
      expect(await trashRows(held)).toBe(1);
      expect((await act(L.admin, held, 'restore')).rows?.[0]?.outcome).toBe('restore');
      expect((await act(L.owner, held, 'purge')).rows?.[0]?.outcome).toBe('purged');
      expect(await trashRows(held)).toBe(0);
      // No home stored: the owner's only; a home the user does not manage:
      // the one not-found.
      const bare = await trashApp(null, false);
      const elsewhere = await trashApp(ws.other, false);
      for (const app of [bare, elsewhere]) {
        expect((await act(L.admin, app, 'purge')).rows?.[0]?.outcome).toBe('not-found');
        expect(await trashRows(app)).toBe(1);
      }
      expect((await act(L.owner, bare, 'purge')).rows?.[0]?.outcome).toBe('purged');
      expect(await appFiles()).toEqual(before);
    });

    it(`${mode}: the routes, in the login's scope`, async () => {
      await setMode(mode);
      const note = await makeItem('note', ws.other);
      // A link of an item the Admin user does not read.
      const s = await makeShare(note, 'note');
      const hidden = await call(`${mode} limited close`, L.limited, 'DELETE', `/api/shares/${s}`);
      expect(hidden.status, hidden.text).toBe(404);
      expect(hidden.json).toEqual(NOT_FOUND);
      for (const who of ['member', 'drift'] as const) {
        const r = await call(`${mode} ${who} close`, L[who], 'DELETE', `/api/shares/${s}`);
        expect(r.status, `${who} ${r.text}`).toBe(who === 'member' ? 403 : 404);
      }
      expect((await shareRow(s)).live).toBe(true);
      const closed = await call(`${mode} admin close`, L.admin, 'DELETE', `/api/shares/${s}`);
      expect(closed.status, closed.text).toBe(200);
      expect(closed.json).toEqual({ ok: true });
      const again = await call(`${mode} admin close again`, L.admin, 'DELETE', `/api/shares/${s}`);
      expect(again.json).toEqual({ ok: false });

      // Can write: an Admin user, its home not checked.
      const app = await makeItem('app', ws.other);
      const cs = await makeShare(app, 'app', true);
      const member = await call(`${mode} member write`, L.member, 'PATCH', `/api/shares/${cs}`, {
        canWrite: true,
      });
      expect(member.status).toBe(403);
      const drift = await call(`${mode} drift write`, L.drift, 'PATCH', `/api/shares/${cs}`, {
        canWrite: true,
      });
      expect(drift.status, drift.text).toBe(403);
      expect(drift.json).toEqual(MEMBER_LOGIN);
      expect((await shareRow(cs)).can_write).toBe(false);
      const ok = await call(`${mode} limited write`, L.limited, 'PATCH', `/api/shares/${cs}`, {
        canWrite: true,
      });
      expect(ok.status, ok.text).toBe(200);
      expect(ok.json).toEqual({ ok: true, canWrite: true });
      expect((await shareRow(cs)).can_write).toBe(true);
      // A link's mode change is the link's: hidden item, the gate's 404.
      const mode404 = await call(`${mode} limited mode`, L.limited, 'PATCH', `/api/shares/${cs}`, {
        mode: 'public',
      });
      expect(mode404.status).toBe(404);
      expect(mode404.json).toEqual(NOT_FOUND);

      // The trash: a held app homed in Admin, the non-owner refused.
      const before = await appFiles();
      const held = await trashApp(ws.admin, true);
      const no = await call(
        `${mode} admin purge held`,
        L.admin,
        'DELETE',
        `/api/apps/deleted/${held}`,
      );
      expect(no.status, no.text).toBe(403);
      expect(no.json).toEqual(HELD);
      const mem = await call(
        `${mode} member purge`,
        L.member,
        'DELETE',
        `/api/apps/deleted/${held}`,
      );
      expect(mem.status).toBe(403);
      expect(await trashRows(held)).toBe(1);
      const own = await call(
        `${mode} owner purge held`,
        L.owner,
        'DELETE',
        `/api/apps/deleted/${held}`,
      );
      expect(own.status, own.text).toBe(200);
      expect(own.json).toEqual({ ok: true });
      expect(await trashRows(held)).toBe(0);
      const none = await call(
        `${mode} admin purge none`,
        L.admin,
        'DELETE',
        `/api/apps/deleted/${randomUUID()}`,
      );
      expect(none.status).toBe(404);
      expect(none.json).toEqual(NOT_FOUND);
      const bad = await call(
        `${mode} admin restore bad id`,
        L.admin,
        'POST',
        '/api/apps/deleted/x/restore',
      );
      expect(bad.status).toBe(404);
      expect(bad.json).toEqual(NOT_FOUND);
      expect(await appFiles()).toEqual(before);
    });
  }
});
