/**
 * An Admin user's write request runs in its scope on the write role (A8
 * finding F4; pre-check deletion blocker 1, docs/actors.md, "Admin writes
 * on the write role (F4)"). Before F4 the session guard let an Admin user's
 * write request through on the system pool, its reads unscoped and only its
 * scope on the write's transactions: the database checked a move, a create
 * in a folder, a delete and a grant there, and nothing else, so the
 * TypeScript item pre-check (itemWriteGate) was the only edit check. Since
 * F4 the guard enters the login's request scope (enterLoginWrite), as a
 * member's: its reads on the workspace role, its writes through the login
 * write gateway, the write role while the actor check is warn or on.
 *
 * Each cell sends a real request through the full HTTP pipeline (runRoute)
 * on a migrated scratch database, as an Admin user (in Admin and a
 * Moderator there, as the guide makes every admin login, in no other
 * workspace) or the owner, on an
 * item homed in another workspace and granted to Admin with Write off (the
 * scope reads it, may not edit it), with Write on (it may), or not granted
 * to Admin at all (the scope does not read it). No route has the item
 * pre-check now (plan v3.2 S11b took its reader out), so only the database
 * and the handler stand, in every cell:
 *
 *   - on: the read-only edit and draft edit are refused by the database,
 *     the item unchanged, in the mapper's words; the editable ones are made
 *     on the write role; an item the scope does not read is the 404 of an
 *     id no row has, and is not written (before F4 the unscoped read found
 *     it and the write was made);
 *   - warn: the read-only edit is made on the write role and logged as a
 *     miss;
 *   - off: the system pool, for every login alike (the rollout switch);
 *   - a link's change, whose handler asks the item's right (the item
 *     gate's answers, item-answers.ts), every mode: the read-only edit is
 *     its 403; an item the scope does not read is the 404 (before F4: 403
 *     "Add yourself to it first", which told the item existed);
 *   - a create with no ?ws= lands in Admin, on the write role;
 *   - kept (the item gate's ADMIN_ACT once, the link's definer now): an
 *     Admin user with the users area closes a link of an item it does not
 *     read.
 *
 * `pnpm test:edit-on` and `pnpm test:runtime-role` run this file too.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/f4-admin-write-role.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asSuperuser } from '@mantle/db/test-support';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;

const VEC = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => VEC),
  embedBatch: vi.fn(async (_o: string, texts: unknown[]) => texts.map(() => VEC)),
}));

/** The database's or the runtime's own words: never in a reply. */
const RAW =
  /Failed query|withSystemTx|runInSystemTx|SQLSTATE|DrizzleQueryError|drizzle-orm|permission denied for|violates|duplicate key|does not exist|\n\s+at \S/i;
const WRITER = /^mantle_write_user/;
const EDIT_MISS = 'UPDATE on nodes: no edit of the item (refused when the check is on)';

type Mode = 'off' | 'warn' | 'on';
type Grant = 'read-only' | 'editable' | 'hidden';
type Who = 'admin' | 'owner';

describe.skipIf(!DB_URL)('F4: an Admin user’s write request runs in its scope', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let raw: ReturnType<typeof postgres>;
  let m: typeof import('@mantle/db');
  let actorMode: typeof import('../../../packages/db/src/actor');
  let runRoute: typeof import('./run-route').runRoute;
  let dir = '';
  const tag = `f4aw${randomUUID().slice(0, 6)}`;
  const L = { owner: randomUUID(), admin: randomUUID() };
  const ws = { admin: '', other: '' };
  const root: Record<'note' | 'page', { id: string; path: string }> = {
    note: { id: '', path: 'notes' },
    page: { id: '', path: 'pages' },
  };
  const recorded: string[] = [];

  /** An item of `kind` homed in the other workspace, granted to Admin as
   *  `grant` says. */
  const makeItem = async (kind: 'note' | 'page', grant: Grant): Promise<string> => {
    const id = randomUUID();
    await raw.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`select mantle_lock_heads(array[${root[kind].id}]::uuid[], 'share')`;
      await tx`insert into nodes (id, owner_id, type, title, path, data)
               values (${id}, ${L.owner}, ${kind}, ${`${tag} ${kind} ${id.slice(0, 8)}`},
                       ${root[kind].path}::ltree, ${raw.json({ rank: 'a0' })})`;
    });
    await raw.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
      await tx`delete from item_grants where node_id = ${id} and via_folder_id is null`;
      await tx`insert into item_grants (node_id, workspace_id, is_home, write)
               values (${id}, ${ws.other}, true, false)`;
      if (grant !== 'hidden') {
        await tx`insert into item_grants (node_id, workspace_id, is_home, write)
                 values (${id}, ${ws.admin}, false, ${grant === 'editable'})`;
      }
      if (kind === 'page') await tx`insert into pages (node_id, doc) values (${id}, '{"v":0}')`;
    });
    return id;
  };

  /** What a probe reads of an item: its title and its page draft. */
  const stateOf = async (id: string) => {
    const [row] = await raw<{ t: string; d: unknown }[]>`
      select n.title as t, p.draft_doc as d from nodes n
        left join pages p on p.node_id = n.id where n.id = ${id}`;
    return row ? JSON.stringify(row) : 'gone';
  };

  /** Which role sent the writes to nodes and pages `fn` caused. */
  const writersOf = async <T>(fn: () => Promise<T>): Promise<{ out: T; who: string[] }> => {
    const [top] = await raw<{ n: number }[]>`select coalesce(max(id), 0)::int as n from f4_seen`;
    const out = await fn();
    const rows = await raw<{ who: string }[]>`
      select who from f4_seen where id > ${top!.n} order by id`;
    return { out, who: rows.map((r) => r.who) };
  };

  /** The box's checks and the process's, together (as the matrix does). */
  const setMode = async (mode: Mode) => {
    await raw`select mantle_set_actor_check(${mode}, 50, 'test')`;
    await raw`select mantle_set_edit_check(${mode}, 50, 'test')`;
    process.env.MANTLE_ACTOR_CHECK = mode;
    actorMode.noteBoxActorCheckMode(mode);
    expect(m.actorCheckMode()).toBe(mode);
  };

  type Cell = {
    status: number;
    text: string;
    changed: boolean;
    role: 'write' | 'system' | 'none';
    misses: string[];
  };

  /** One request on a fresh item: what it answered, whether the item
   *  changed, which role wrote, and the actor misses. */
  const cell = async (
    name: string,
    who: Who,
    what: 'edit' | 'draft' | 'gated',
    grant: Grant,
  ): Promise<Cell> => {
    const id = await makeItem(what === 'edit' ? 'note' : 'page', grant);
    // 'gated': a link's change (PATCH /api/shares/:id), whose handler asks
    // the right of the item the share names before it writes
    // (shareItemRefusal, the item gate's answers byte for byte since plan
    // v3.2 S6 c2, lib/auth/item-answers.ts).
    const shareId = randomUUID();
    if (what === 'gated') {
      await raw.begin(async (tx) => {
        await tx`select set_config('mantle.actor', 'system:test', true)`;
        await tx`insert into shares (id, owner_id, node_id, node_type, token, settings)
                 values (${shareId}, ${L.owner}, ${id}, 'page', ${`${tag}-${shareId}`},
                         '{"served":[]}'::jsonb)`;
      });
    }
    const before = await stateOf(id);
    m.takeActorMisses();
    const res: { out: Response; who: string[] } = await writersOf(() =>
      what === 'edit'
        ? runRoute(L[who], 'PATCH', `/api/notes/${id}`, { title: `${tag} edited ${name}` })
        : what === 'gated'
          ? runRoute(L[who], 'PATCH', `/api/shares/${shareId}`, { mode: 'view' })
          : runRoute(L[who], 'PUT', `/api/pages/${id}/draft`, {
              doc: { type: 'doc', content: [], f4: name },
            }),
    );
    const text = await res.out.text();
    const misses = m.takeActorMisses().map((x) => x.check);
    const changed = (await stateOf(id)) !== before;
    const role =
      res.who.length === 0 ? 'none' : res.who.some((w) => WRITER.test(w)) ? 'write' : 'system';
    recorded.push(
      `${name}: ${res.out.status} changed=${changed} role=${role} misses=${misses.length} ${text
        .slice(0, 140)
        .replace(/\s+/g, ' ')}`,
    );
    return { status: res.out.status, text, changed, role, misses };
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(DB_URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'f4-admin-write-role-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'f4-admin-write-role-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the F4 test', { status: 503 })),
    );
    m = await import('@mantle/db');
    actorMode = await import('../../../packages/db/src/actor');
    runRoute = (await import('./run-route')).runRoute;
    raw = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });

    for (const [who, id] of Object.entries(L)) {
      await asSuperuser()`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
        values (${id}, ${`${tag}-${who}@example.invalid`}, 'x', ${who === 'owner'}, 'admin',
                ${who})`;
    }
    await raw`insert into spaces (id, kind, login_id) values (${L.owner}, 'brain', ${L.owner})
              on conflict (id) do nothing`;
    await raw`select * from mantle_ws_migrate()`;
    ws.admin = (
      await raw<{ id: string }[]>`select id::text as id from workspaces
                                    where owner_id = ${L.owner} and is_admin`
    )[0]!.id;
    // The other workspace: no Admin user is in it; its items reach the
    // Admin scope only by their grant to Admin.
    ws.other = (
      await raw<{ id: string }[]>`insert into workspaces (owner_id, name)
        values (${L.owner}, ${`${tag} other`}) returning id::text as id`
    )[0]!.id;
    await raw`delete from workspace_users where workspace_id = ${ws.other}`;
    // The Admin user: in Admin and a Moderator there ("An admin login is
    // its user and a Moderator there", docs/workspaces.md).
    await raw`insert into workspace_users (workspace_id, login_id, moderator)
      values (${ws.admin}, ${L.admin}, true)
      on conflict (workspace_id, login_id) do update set moderator = true`;
    for (const kind of ['note', 'page'] as const) {
      const p = root[kind].path;
      await raw`insert into nodes (owner_id, type, title, path)
        select ${L.owner}, 'branch', ${p}, ${p}::ltree
         where not exists (select 1 from nodes where owner_id = ${L.owner}
                             and type = 'branch' and path = ${p}::ltree)`;
      root[kind].id = (
        await raw<{ id: string }[]>`select id::text as id from nodes
          where owner_id = ${L.owner} and type = 'branch' and path = ${p}::ltree`
      )[0]!.id;
    }
    // Which role sent each write to nodes and pages (this scratch database
    // only).
    await raw`create table f4_seen (id bigserial primary key, who text not null)`;
    await raw.unsafe(`create function f4_seen_trg() returns trigger language plpgsql
      security definer set search_path = public as $$
      begin insert into f4_seen (who) values (session_user); return null; end $$`);
    await raw`create trigger zz_f4_seen after update on nodes
      for each statement execute function f4_seen_trg()`;
    await raw`create trigger zz_f4_seen after update on pages
      for each statement execute function f4_seen_trg()`;
    await raw`create trigger zz_f4_seen_ins after insert on nodes
      for each statement execute function f4_seen_trg()`;
    m.takeActorMisses();
  }, 300_000);

  afterAll(async () => {
    console.log(['F4 admin write role, each cell’s answer:', ...recorded].join('\n  '));
    process.env.MANTLE_ACTOR_CHECK = 'warn';
    vi.unstubAllGlobals();
    await raw?.end();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('on: the database refuses a read-only edit and draft edit; editable ones are made on the write role', async () => {
    await setMode('on');
    for (const who of ['admin', 'owner'] as const) {
      for (const what of ['edit', 'draft'] as const) {
        const ro = await cell(`on ${who} ${what} read-only`, who, what, 'read-only');
        expect(ro.status, ro.text).toBe(403);
        expect(ro.changed).toBe(false);
        expect(ro.text).not.toMatch(RAW);
        expect(ro.text).toContain('item-workspace');
        const rw = await cell(`on ${who} ${what} editable`, who, what, 'editable');
        expect(rw.status, rw.text).toBe(200);
        expect(rw.changed).toBe(true);
        expect(rw.role).toBe('write');
        expect(rw.misses).toEqual([]);
      }
    }
  }, 180_000);

  it('on: an item the scope does not read is not found and not written', async () => {
    await setMode('on');
    for (const who of ['admin', 'owner'] as const) {
      for (const what of ['edit', 'draft'] as const) {
        const hidden = await cell(`on ${who} ${what} hidden`, who, what, 'hidden');
        expect(hidden.status, hidden.text).toBe(404);
        expect(hidden.changed).toBe(false);
        expect(hidden.text).not.toMatch(RAW);
      }
    }
  }, 120_000);

  it('warn makes the read-only edit on the write role and logs it as a miss', async () => {
    await setMode('warn');
    const ro = await cell('warn admin edit read-only', 'admin', 'edit', 'read-only');
    expect(ro.status, ro.text).toBe(200);
    expect(ro.changed).toBe(true);
    expect(ro.role).toBe('write');
    expect(ro.misses).toContain(EDIT_MISS);
    const rw = await cell('warn admin edit editable', 'admin', 'edit', 'editable');
    expect(rw.status, rw.text).toBe(200);
    expect(rw.misses).toEqual([]);
  }, 120_000);

  it('off runs on the write role too and reports as warn (plan v3 S3: the mode never picks the pool)', async () => {
    // Changed in S3: off was the rollout switch, the system pool unchecked.
    await setMode('off');
    const ro = await cell('off admin edit read-only', 'admin', 'edit', 'read-only');
    expect(ro.status, ro.text).toBe(200);
    expect(ro.changed).toBe(true);
    expect(ro.role).toBe('write');
    expect(ro.misses).toContain(EDIT_MISS);
  }, 120_000);

  it('a link’s change, the handler’s item check: a read-only edit is its 403, an item the scope does not read the 404 (no existence leak)', async () => {
    // The handler's check holds in every mode (the database's alone only
    // reports below on).
    for (const mode of ['off', 'warn', 'on'] as const) {
      await setMode(mode);
      for (const who of ['admin', 'owner'] as const) {
        const ro = await cell(`${mode} ${who} gated read-only`, who, 'gated', 'read-only');
        expect(ro.status, ro.text).toBe(403);
        expect(ro.text).toContain('You cannot change this item in your workspaces.');
        expect(ro.changed).toBe(false);
        const hidden = await cell(`${mode} ${who} gated hidden`, who, 'gated', 'hidden');
        expect(hidden.status, hidden.text).toBe(404);
        expect(JSON.parse(hidden.text)).toEqual({ ok: false, error: 'not found' });
        expect(hidden.changed).toBe(false);
      }
    }
  }, 240_000);

  it('a create with no ?ws= lands in Admin, on the write role', async () => {
    await setMode('on');
    const { out, who } = await writersOf(() =>
      runRoute(L.admin, 'POST', '/api/notes', { title: `${tag} created`, content: 'x' }),
    );
    const text = await out.text();
    recorded.push(`on admin create: ${out.status} ${text.slice(0, 140)}`);
    expect(out.status, text).toBeLessThan(300);
    expect(
      who.some((w) => WRITER.test(w)),
      who.join(','),
    ).toBe(true);
    const [row] = await raw<{ home: string }[]>`
      select home_ws::text as home from nodes where title = ${`${tag} created`}`;
    expect(row?.home).toBe(ws.admin);
  }, 120_000);

  it('kept: an Admin user with the users area closes a link of an item it does not read', async () => {
    await setMode('on');
    const id = await makeItem('note', 'hidden');
    const shareId = randomUUID();
    await raw.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`insert into shares (id, owner_id, node_id, node_type, token, settings)
               values (${shareId}, ${L.owner}, ${id}, 'note', ${`${tag}-${shareId}`},
                       '{"served":[]}'::jsonb)`;
    });
    const res = await runRoute(L.admin, 'DELETE', `/api/shares/${shareId}`);
    const text = await res.text();
    recorded.push(`on admin close a link of a hidden item: ${res.status} ${text}`);
    expect(res.status, text).toBe(200);
    expect(JSON.parse(text)).toEqual({ ok: true });
    const [row] = await raw<{ revoked: boolean }[]>`
      select revoked_at is not null as revoked from shares where id = ${shareId}`;
    expect(row?.revoked).toBe(true);
  }, 120_000);
});
