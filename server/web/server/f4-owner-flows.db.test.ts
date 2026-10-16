/**
 * F4 fix round 1: the owner's and every Admin user's management flows that
 * broke when F4 moved an Admin user's write request into its scope on the
 * write role (docs/actors.md, "Admin writes on the write role (F4)", "Fix
 * round 1"). Each cell sends a real request through the full HTTP pipeline
 * (runRoute) on a migrated scratch database, as the owner, in warn and in on:
 *
 *  - H1: a contact's sharing switched on, its code made again, an item the
 *    owner's scope does not read shared with the contact (sharing with a
 *    contact needs only an Admin user, its home is not checked), sharing
 *    switched off (every share revoked). Before: permission denied on
 *    contact_share_codes, a 500.
 *  - "Can write" on a contact share of an app outside the owner's scope.
 *  - M2: Revoke all of a contact's shares revokes every one, an item the
 *    scope does not read included.
 *  - H2: an entity merge moves every fact of the duplicate, one from an
 *    item the scope does not read included (before: left behind, then its
 *    entity set to null by the duplicate's delete, in warn).
 *  - M1: adding a contact queues the backfill of its address for each
 *    enabled mail account (before: the account read was refused in the
 *    scope and no backfill was queued, in every mode).
 *  - Every Admin user is a Moderator of Admin, always: the tick is never
 *    cleared there, an add to Admin is one with it, and migration 0298
 *    ticks one who is not.
 *  - L1: a missing share, a hidden share and a missing or hidden deleted
 *    app are the same 404 for an Admin user.
 *  - A member never reaches a contact-sharing route.
 *
 * `pnpm test:edit-on` runs this file too.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/f4-owner-flows.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;

/** The jobs the backfill queue sends (pg-boss replaced: no queue tables). */
const boss = vi.hoisted(() => ({ sent: [] as { queue: string; data: unknown }[] }));
vi.mock('pg-boss', () => {
  class PgBoss {
    async start() {}
    async stop() {}
    async createQueue() {}
    async send(queue: string, data: unknown) {
      boss.sent.push({ queue, data });
      return 'job';
    }
    on() {}
  }
  return { PgBoss, default: PgBoss };
});

const VEC = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => VEC),
  embedBatch: vi.fn(async (_o: string, texts: unknown[]) => texts.map(() => VEC)),
}));

/** An email attachment's object (F4 fix round 2): no object store here. */
vi.mock('@mantle/storage', async (importOriginal) => {
  const { Readable } = await import('node:stream');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    getContent: vi.fn(async (key: string) => ({
      body: Readable.from([Buffer.from(`object ${key}`)]),
    })),
  };
});

/** The database's or the runtime's own words: never in a reply. */
const RAW =
  /Failed query|withSystemTx|runInSystemTx|SQLSTATE|DrizzleQueryError|drizzle-orm|permission denied for|violates|duplicate key|does not exist|\n\s+at \S/i;
const NOT_FOUND = { ok: false, error: 'not found' };

type Mode = 'warn' | 'on';

describe.skipIf(!DB_URL)('F4 fix round 1: the owner’s management flows on the write role', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let raw: ReturnType<typeof postgres>;
  let m: typeof import('@mantle/db');
  let actorMode: typeof import('../../../packages/db/src/actor');
  let runRoute: typeof import('./run-route').runRoute;
  let dir = '';
  const tag = `f4of${randomUUID().slice(0, 6)}`;
  const L = {
    owner: randomUUID(),
    admin: randomUUID(),
    limited: randomUUID(),
    member: randomUUID(),
    joiner: randomUUID(),
  };
  const ws = { admin: '', other: '' };
  const root: Record<'note' | 'app', { id: string; path: string }> = {
    note: { id: '', path: 'notes' },
    app: { id: '', path: 'apps' },
  };
  let account = '';
  const recorded: string[] = [];

  /** An item of `kind` homed in the other workspace, not granted to Admin:
   *  no Admin user's scope reads it. With `admin`, granted to Admin too. */
  const makeItem = async (kind: 'note' | 'app', admin = false): Promise<string> => {
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
      if (admin) {
        await tx`insert into item_grants (node_id, workspace_id, is_home, write)
                 values (${id}, ${ws.admin}, false, true)`;
      }
    });
    return id;
  };

  /** The box's checks and the process's, together (as the matrix does). */
  const setMode = async (mode: Mode) => {
    await raw`select mantle_set_actor_check(${mode})`;
    await raw`select mantle_set_edit_check(${mode})`;
    process.env.MANTLE_ACTOR_CHECK = mode;
    actorMode.noteBoxActorCheckMode(mode);
    expect(m.actorCheckMode()).toBe(mode);
  };

  /** One request: its status and body, recorded; never the raw words. */
  const call = async (
    name: string,
    who: string,
    method: string,
    url: string,
    body?: unknown,
  ): Promise<{ status: number; text: string; json: Record<string, unknown> }> => {
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

  /** A contact made by the owner through the route (M1 rides on it). */
  const makeContact = async (name: string): Promise<{ id: string; status: number }> => {
    const r = await call(`${name}: add a contact`, L.owner, 'POST', '/api/contacts', {
      first_name: `${tag} ${name}`,
      emails: [`${tag}-${name.replace(/\W+/g, '-')}@example.invalid`],
    });
    return { id: ((r.json.contact ?? {}) as { id?: string }).id ?? '', status: r.status };
  };

  const liveShares = async (contact: string) =>
    (
      await raw<{ n: number }[]>`select count(*)::int as n from shares
        where contact_id = ${contact} and revoked_at is null`
    )[0]!.n;

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(DB_URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'f4-owner-flows-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'f4-owner-flows-secret-at-least-32-characters';
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
      const role = who === 'member' || who === 'joiner' ? 'member' : 'admin';
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
    // The member: a user of the other workspace only.
    await raw`insert into workspace_users (workspace_id, login_id, moderator)
      values (${ws.other}, ${L.member}, true)`;
    // The Admin users: Moderators of Admin; `limited` without the users area.
    for (const id of [L.admin, L.limited]) {
      await raw`insert into workspace_users (workspace_id, login_id, moderator, limits)
        values (${ws.admin}, ${id}, true,
                ${raw.json(id === L.limited ? { areas: { users: false } } : {})})
        on conflict (workspace_id, login_id)
        do update set moderator = true, limits = excluded.limits`;
    }
    for (const kind of ['note', 'app'] as const) {
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
    account = (
      await raw<{ id: string }[]>`insert into email_accounts
          (user_id, provider, address, branch_path)
        values (${L.owner}, 'imap', ${`${tag}-box@example.invalid`}, ${`inbox.${tag}`})
        returning id::text as id`
    )[0]!.id;
    m.takeActorMisses();
  }, 300_000);

  afterAll(async () => {
    console.log(['F4 owner flows, each answer:', ...recorded].join('\n  '));
    process.env.MANTLE_ACTOR_CHECK = 'warn';
    vi.unstubAllGlobals();
    await raw?.end();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  for (const mode of ['warn', 'on'] as const) {
    it(`${mode}: M1, adding a contact queues its backfill for each enabled mail account`, async () => {
      await setMode(mode);
      boss.sent.length = 0;
      const c = await makeContact(`${mode} m1`);
      expect(c.status).toBe(201);
      expect(boss.sent.filter((j) => j.queue.endsWith('.backfill'))).toEqual([
        {
          queue: 'mantle.email.backfill',
          data: { accountId: account, target: `${tag}-${mode}-m1@example.invalid` },
        },
      ]);
    }, 120_000);

    it(`${mode}: H1, the owner switches sharing on, makes the code again, shares, switches it off`, async () => {
      await setMode(mode);
      const c = await makeContact(`${mode} h1`);
      const on = await call(`${mode} enable`, L.owner, 'POST', `/api/contacts/${c.id}/sharing`, {
        action: 'enable',
      });
      expect(on.status, on.text).toBe(200);
      expect(typeof on.json.code).toBe('string');
      const again = await call(
        `${mode} regenerate`,
        L.owner,
        'POST',
        `/api/contacts/${c.id}/sharing`,
        { action: 'regenerate' },
      );
      expect(again.status, again.text).toBe(200);
      expect(again.json.code).not.toBe(on.json.code);
      // An item the owner's scope does not read: its home is not checked.
      const hidden = await makeItem('note');
      const seen = await makeItem('note', true);
      for (const item of [hidden, seen]) {
        const shared = await call(
          `${mode} share ${item === hidden ? 'hidden' : 'seen'}`,
          L.owner,
          'POST',
          '/api/shares/contacts',
          {
            nodeId: item,
            contactIds: [c.id],
          },
        );
        expect(shared.status, shared.text).toBe(200);
        expect((shared.json.shares as unknown[]).length).toBe(1);
      }
      expect(await liveShares(c.id)).toBe(2);
      const off = await call(`${mode} disable`, L.owner, 'POST', `/api/contacts/${c.id}/sharing`, {
        action: 'disable',
      });
      expect(off.status, off.text).toBe(200);
      expect(off.json).toEqual({ sharing: null, revoked: 2 });
      expect(await liveShares(c.id)).toBe(0);
      const [code] = await raw<{ hash: string | null }[]>`
        select code_hash as hash from contact_share_codes where contact_id = ${c.id}`;
      expect(code?.hash).toBeNull();
    }, 180_000);

    it(`${mode}: M2, Revoke all revokes every share of the contact; Can write on an app outside the scope`, async () => {
      await setMode(mode);
      const c = await makeContact(`${mode} m2`);
      const on = await call(`${mode} m2 enable`, L.owner, 'POST', `/api/contacts/${c.id}/sharing`, {
        action: 'enable',
      });
      expect(on.status, on.text).toBe(200);
      const app = await makeItem('app');
      for (const item of [await makeItem('note'), await makeItem('note', true), app]) {
        const shared = await call(`${mode} m2 share`, L.owner, 'POST', '/api/shares/contacts', {
          nodeId: item,
          contactIds: [c.id],
        });
        expect(shared.status, shared.text).toBe(200);
      }
      const [share] = await raw<{ id: string }[]>`
        select id::text as id from shares where contact_id = ${c.id} and node_id = ${app}
           and revoked_at is null`;
      const write = await call(`${mode} can write`, L.owner, 'PATCH', `/api/shares/${share!.id}`, {
        canWrite: true,
      });
      expect(write.status, write.text).toBe(200);
      expect(write.json).toEqual({ ok: true, canWrite: true });
      const [row] = await raw<
        { w: boolean }[]
      >`select can_write as w from shares where id = ${share!.id}`;
      expect(row?.w).toBe(true);
      expect(await liveShares(c.id)).toBe(3);
      const all = await call(
        `${mode} revoke all`,
        L.owner,
        'DELETE',
        `/api/contacts/${c.id}/shares`,
      );
      expect(all.status, all.text).toBe(200);
      expect(all.json).toEqual({ revoked: 3 });
      expect(await liveShares(c.id)).toBe(0);
    }, 180_000);

    it(`${mode}: H2, an entity merge moves a fact of an item the scope does not read`, async () => {
      await setMode(mode);
      const hidden = await makeItem('note');
      const { canon, dup, fact } = await raw.begin(async (tx) => {
        await tx`select set_config('mantle.actor', 'system:test', true)`;
        const [c] = await tx<{ id: string }[]>`insert into entities (owner_id, kind, name)
          values (${L.owner}, 'person', ${`${tag} ${mode} Ada Lovelace`}) returning id::text as id`;
        const [d] = await tx<{ id: string }[]>`insert into entities (owner_id, kind, name)
          values (${L.owner}, 'person', ${`${tag} ${mode} A. Lovelace`}) returning id::text as id`;
        const [f] = await tx<{ id: string }[]>`
          insert into facts (owner_id, kind, content, source_node_id, entity_id)
          values (${L.owner}, 'factual', ${`${tag} ${mode} a fact`}, ${hidden}, ${d!.id})
          returning id::text as id`;
        return { canon: c, dup: d, fact: f };
      });
      const merged = await call(`${mode} merge`, L.owner, 'POST', '/api/entities/merge', {
        canonicalId: canon!.id,
        dupId: dup!.id,
      });
      expect(merged.status, merged.text).toBe(200);
      expect(merged.json).toEqual({ ok: true });
      const [f] = await raw<{ e: string | null }[]>`
        select entity_id::text as e from facts where id = ${fact!.id}`;
      expect(f?.e).toBe(canon!.id);
      const gone = await raw`select 1 from entities where id = ${dup!.id}`;
      expect(gone.length).toBe(0);
    }, 120_000);
  }

  it('a member never reaches the contact-sharing routes', async () => {
    await setMode('on');
    const c = await makeContact('member probe');
    for (const [method, url, body] of [
      ['POST', `/api/contacts/${c.id}/sharing`, { action: 'enable' }],
      ['DELETE', `/api/contacts/${c.id}/shares`, undefined],
      ['POST', '/api/shares/contacts', { nodeId: c.id, contactIds: [c.id] }],
      ['POST', '/api/entities/merge', { canonicalId: c.id, dupId: L.owner }],
    ] as const) {
      const r = await call(`member ${method} ${url}`, L.member, method, url, body);
      expect(r.status, r.text).toBe(403);
    }
    const [code] = await raw`select 1 from contact_share_codes where contact_id = ${c.id}`;
    expect(code).toBeUndefined();
  }, 120_000);

  it('the mail accounts definer answers a scope that holds Admin only', async () => {
    const read = (login: string) =>
      m.withViewer(
        { login },
        async () =>
          (await m.db.execute(
            sql`select id::text as id from mantle_mail_backfill_accounts(${L.owner}::uuid)`,
          )) as unknown as { id: string }[],
      );
    expect((await read(L.owner)).map((r) => r.id)).toEqual([account]);
    expect(await read(L.member)).toEqual([]);
  }, 60_000);

  it('every Admin user is a Moderator of Admin: never unticked there, an add is one', async () => {
    await setMode('on');
    const untick = await call(
      'untick an Admin user on Admin',
      L.owner,
      'PATCH',
      `/api/workspaces/${ws.admin}/users/${L.admin}`,
      { moderator: false },
    );
    expect(untick.status, untick.text).toBe(409);
    expect(untick.json.code).toBe('admin_workspace');
    const [still] = await raw<{ mod: boolean }[]>`select moderator as mod from workspace_users
      where workspace_id = ${ws.admin} and login_id = ${L.admin}`;
    expect(still?.mod).toBe(true);
    const offAdd = await call(
      'add to Admin with the tick off',
      L.owner,
      'POST',
      `/api/workspaces/${ws.admin}/users`,
      { loginId: L.joiner, moderator: false },
    );
    expect(offAdd.status, offAdd.text).toBe(409);
    expect(offAdd.json.code).toBe('admin_workspace');
    const [role] = await raw<
      { role: string }[]
    >`select role from auth.users where id = ${L.joiner}`;
    expect(role?.role).toBe('member');
    const add = await call('add to Admin', L.owner, 'POST', `/api/workspaces/${ws.admin}/users`, {
      loginId: L.joiner,
    });
    expect(add.status, add.text).toBe(200);
    const [joined] = await raw<{ mod: boolean }[]>`select moderator as mod from workspace_users
      where workspace_id = ${ws.admin} and login_id = ${L.joiner}`;
    expect(joined?.mod).toBe(true);
    // The tick of another workspace still clears.
    await raw`insert into workspace_users (workspace_id, login_id, moderator)
      values (${ws.other}, ${L.admin}, true)`;
    const other = await call(
      'untick on another workspace',
      L.owner,
      'PATCH',
      `/api/workspaces/${ws.other}/users/${L.admin}`,
      { moderator: false },
    );
    expect(other.status, other.text).toBe(200);
    await raw`delete from workspace_users where workspace_id = ${ws.other} and login_id = ${L.admin}`;
  }, 120_000);

  it('migration 0298 ticks an Admin user who is not a Moderator of Admin, once', async () => {
    await raw`update workspace_users set moderator = false
      where workspace_id = ${ws.admin} and login_id = ${L.limited}`;
    const file = path.resolve(
      __dirname,
      '../../../packages/db/migrations/0298_admin_users_moderate_admin.sql',
    );
    const steps = (await readFile(file, 'utf8')).split('--> statement-breakpoint');
    for (let run = 0; run < 2; run++) {
      await raw.begin(async (tx) => {
        for (const step of steps) await tx.unsafe(step);
      });
    }
    const [row] = await raw<{ mod: boolean }[]>`select moderator as mod from workspace_users
      where workspace_id = ${ws.admin} and login_id = ${L.limited}`;
    expect(row?.mod).toBe(true);
    const events = await raw<{ n: number }[]>`select count(*)::int as n from workspace_events
      where workspace_id = ${ws.admin} and action = 'user.moderator'
        and subject->>'login' = ${L.limited} and subject->>'by' = 'migration 0298'`;
    expect(events[0]!.n).toBe(1);
  }, 60_000);

  it('L1: a missing and a hidden share or deleted app are the same 404 for an Admin user', async () => {
    await setMode('on');
    const hidden = await makeItem('note');
    const shareId = randomUUID();
    await raw.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`insert into shares (id, owner_id, node_id, node_type, token, settings)
               values (${shareId}, ${L.owner}, ${hidden}, 'note', ${`${tag}-${shareId}`},
                       '{"served":[]}'::jsonb)`;
    });
    for (const id of [randomUUID(), shareId]) {
      const del = await call(
        `limited close ${id === shareId ? 'hidden' : 'missing'}`,
        L.limited,
        'DELETE',
        `/api/shares/${id}`,
      );
      expect(del.status, del.text).toBe(404);
      expect(del.json).toEqual(NOT_FOUND);
      const patch = await call(
        `limited change ${id === shareId ? 'hidden' : 'missing'}`,
        L.limited,
        'PATCH',
        `/api/shares/${id}`,
        {
          mode: 'public',
        },
      );
      expect(patch.status, patch.text).toBe(404);
      expect(patch.json).toEqual(NOT_FOUND);
    }
    const [live] = await raw<
      { r: boolean }[]
    >`select revoked_at is null as r from shares where id = ${shareId}`;
    expect(live?.r).toBe(true);
    // Deleted apps: none, one homed where the user moderates nothing, one
    // a non-owner deleted (held) homed there.
    const gone = [randomUUID(), randomUUID()];
    for (const [i, g] of gone.entries()) {
      await raw.begin(async (tx) => {
        await tx`select set_config('mantle.actor', 'system:test', true)`;
        await tx`insert into node_snapshots (owner_id, node_id, node_kind, seq, trigger, actor, code)
        values (${L.owner}, ${g}, 'app', 1, 'pre_delete', 'owner',
                ${raw.json({ meta: { title: `${tag} gone ${i}`, homeWs: ws.other, ...(i === 1 ? { keepForOwner: true } : {}) } })})`;
      });
    }
    for (const id of [randomUUID(), ...gone]) {
      for (const [method, url] of [
        ['DELETE', `/api/apps/deleted/${id}`],
        ['POST', `/api/apps/deleted/${id}/restore`],
      ] as const) {
        const r = await call(`admin ${method} trash`, L.admin, method, url);
        expect(r.status, r.text).toBe(404);
        expect(r.json).toEqual(NOT_FOUND);
      }
    }
    const left = await raw<{ n: number }[]>`select count(*)::int as n from node_snapshots
      where node_id = any(${gone}::uuid[])`;
    expect(left[0]!.n).toBe(2);
  }, 120_000);

  // ── F4 fix round 2: brain-wide bookkeeping after the item check ──────────

  /** Who else reads a row: Admin by a grant of its own (Read or Write),
   *  and a workspace its folder gives it to that is removed here (the
   *  folder's grant excluded, as a user removes it on a subfolder). */
  type Grants = { admin?: 'read' | 'write'; exclude?: string };

  /** A row of `type` at `path` (its folder `parent` held), homed in `home`.
   *  Raw, as the system. */
  const rawNode = async (
    o: {
      type: string;
      title: string;
      path: string;
      parent: string;
      home: string;
      data?: Record<string, unknown>;
    } & Grants,
  ): Promise<string> => {
    const id = randomUUID();
    await raw.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`select mantle_lock_heads(array[${o.parent}]::uuid[], 'share')`;
      await tx`insert into nodes (id, owner_id, type, title, path, data)
               values (${id}, ${L.owner}, ${o.type}, ${o.title}, ${o.path}::ltree,
                       ${raw.json((o.data ?? {}) as never)})`;
    });
    await rehome(id, o.home, o);
    return id;
  };

  /** Home `id` in `home` (its own grants replaced), with `g`. Upserts: a
   *  folder's derived row for the same workspace becomes the item's own. */
  const rehome = async (id: string, home: string, g: Grants = {}) => {
    const own = async (
      tx: postgres.TransactionSql,
      wsId: string,
      cols: { home?: boolean; write?: boolean; excluded?: boolean },
    ) => {
      await tx`insert into item_grants (node_id, workspace_id, is_home, write, excluded)
               values (${id}, ${wsId}, ${cols.home ?? false}, ${cols.write ?? false},
                       ${cols.excluded ?? false})
               on conflict (node_id, workspace_id) do update
                 set is_home = excluded.is_home, write = excluded.write,
                     excluded = excluded.excluded, via_folder_id = null`;
    };
    await raw.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
      await tx`delete from item_grants where node_id = ${id} and via_folder_id is null`;
      await own(tx, home, { home: true });
      if (g.admin && home !== ws.admin) await own(tx, ws.admin, { write: g.admin === 'write' });
      if (g.exclude) await own(tx, g.exclude, { excluded: true });
    });
  };

  /** A files folder the owner makes (homed in Admin), under `parentPath`. */
  const folder = async (slug: string, parentPath = 'files') => {
    const r = await call(`folder ${slug}`, L.owner, 'POST', '/api/files/folders', {
      parentPath,
      slug,
    });
    expect(r.status, r.text).toBeLessThan(300);
    return r.json.folder as { id: string; path: string };
  };

  /** A text file (its bytes inline) in `dir`, homed in `home`. */
  const textFile = (
    dir: { id: string; path: string },
    name: string,
    home: string,
    o: Grants & { data?: Record<string, unknown> } = {},
  ) =>
    rawNode({
      type: 'file',
      title: name,
      path: dir.path,
      parent: dir.id,
      home,
      ...o,
      data: { filename: name, content: `${tag} ${name}`, ...o.data },
    });

  /** An app the owner makes (homed in Admin) with one SQLite table. */
  const makeApp = async (name: string): Promise<string> => {
    const r = await call(`app ${name}`, L.owner, 'POST', '/api/apps', { name: `${tag} ${name}` });
    expect(r.status, r.text).toBe(201);
    const id = (r.json.app as { id: string }).id;
    const ddl = await call(`app ${name} ddl`, L.owner, 'POST', `/api/apps/${id}/db-broker`, {
      op: 'exec',
      sql: 'create table if not exists items (name text)',
      params: [],
    });
    expect(ddl.status, ddl.text).toBe(200);
    return id;
  };

  const snapshotRows = async (node: string, trigger?: string) =>
    (
      await raw<{ n: number }[]>`select count(*)::int as n from node_snapshots
        where node_id = ${node} and (${trigger ?? null}::text is null or trigger = ${trigger ?? null})`
    )[0]!.n;

  for (const mode of ['warn', 'on'] as const) {
    it(`${mode}: 1, a table commit keeps its history, prunes it, and a restore keeps its note`, async () => {
      await setMode(mode);
      const made = await call(`${mode} t create`, L.owner, 'POST', '/api/tables', {
        title: `${tag} ${mode} history`,
      });
      expect(made.status, made.text).toBe(201);
      const id = (made.json.table as { id: string }).id;
      const col = `c${mode}`;
      const ops = async (o: unknown[]) => {
        const r = await call(`${mode} t ops`, L.owner, 'POST', `/api/tables/${id}/draft-ops`, {
          ops: o,
        });
        expect(r.status, r.text).toBeLessThan(300);
      };
      const commit = async () => {
        const r = await call(`${mode} t commit`, L.owner, 'POST', `/api/tables/${id}/commit`, {});
        expect(r.status, r.text).toBe(200);
      };
      await ops([
        { op: 'column_add', column: { id: col, name: 'Name', type: 'text' } },
        { op: 'row_add', cells: { [col]: 'a' } },
      ]);
      await commit();
      await ops([{ op: 'row_add', cells: { [col]: 'b' } }]);
      await commit();
      // Before: no history row for an Admin user's commit (in its scope).
      expect(await snapshotRows(id, 'commit')).toBeGreaterThanOrEqual(1);
      // The prune is the named step: 25 more entries come down to the keep.
      await raw.begin(async (tx) => {
        await tx`select set_config('mantle.actor', 'system:test', true)`;
        for (let i = 0; i < 25; i++) {
          await tx`insert into node_snapshots (owner_id, node_id, node_kind, seq, trigger, actor)
                   values (${L.owner}, ${id}, 'table', ${1000 + i}, 'commit', 'owner')`;
        }
      });
      await ops([{ op: 'row_add', cells: { [col]: 'c' } }]);
      await commit();
      expect(await snapshotRows(id, 'commit')).toBe(20);
      // A restore with commit keeps its note on the version it replaces.
      const [entry] = await raw<{ id: string; seq: number }[]>`
        select id::text as id, seq from node_snapshots
         where node_id = ${id} and trigger = 'commit' and db_path is not null
         order by seq desc limit 1`;
      const back = await call(
        `${mode} t restore`,
        L.owner,
        'POST',
        `/api/tables/${id}/history/${entry!.id}/restore`,
        { commit: true, discardDraft: true },
      );
      expect(back.status, back.text).toBe(200);
      const [note] = await raw<{ note: string | null }[]>`select note from node_snapshots
        where node_id = ${id} and trigger = 'commit' order by seq desc limit 1`;
      expect(note?.note).toBe(`replaced by restoring v${entry!.seq}`);
    }, 180_000);

    it(`${mode}: 8 and 10, the snapshot budgets count the brain's copies`, async () => {
      await setMode(mode);
      const hidden = await makeItem('app');
      const app = await makeApp(`${mode} budget`);
      const made = await call(`${mode} b table`, L.owner, 'POST', '/api/tables', {
        title: `${tag} ${mode} budget`,
      });
      const table = (made.json.table as { id: string }).id;
      const commit = await call(
        `${mode} b commit`,
        L.owner,
        'POST',
        `/api/tables/${table}/commit`,
        {
          data: {
            columns: [{ id: 'c', name: 'C', type: 'text' }],
            rows: [{ id: 'r', cells: { c: 'x' } }],
          },
        },
      );
      expect(commit.status, commit.text).toBe(200);
      process.env.APP_SNAPSHOT_MAX_MB = '1';
      try {
        await raw.begin(async (tx) => {
          await tx`select set_config('mantle.actor', 'system:test', true)`;
          await tx`insert into node_snapshots (owner_id, node_id, node_kind, seq, trigger, actor, db_bytes)
                   values (${L.owner}, ${hidden}, 'app', 1, 'manual', 'owner', ${2 * 1024 * 1024})`;
        });
        // A copy of an app the owner's scope does not read fills the budget:
        // the scope's sum missed it (before: 201 each).
        const a = await call(
          `${mode} app snapshot`,
          L.owner,
          'POST',
          `/api/apps/${app}/snapshots`,
          {
            note: 'over',
          },
        );
        expect(a.status, a.text).toBe(409);
        expect(a.json.reason).toBe('budget');
        const t = await call(
          `${mode} table snapshot`,
          L.owner,
          'POST',
          `/api/tables/${table}/history`,
          {
            note: 'over',
          },
        );
        expect(t.status, t.text).toBe(409);
      } finally {
        delete process.env.APP_SNAPSHOT_MAX_MB;
        await raw.begin(async (tx) => {
          await tx`select set_config('mantle.actor', 'system:test', true)`;
          await tx`delete from node_snapshots where node_id = ${hidden}`;
        });
      }
    }, 180_000);

    it(`${mode}: 2, an email attachment is copied by an Admin user`, async () => {
      await setMode(mode);
      const dir = await folder(`${tag}${mode}att`);
      const dest = await folder(`${tag}${mode}attdst`);
      const att = await textFile(dir, 'invoice.pdf', ws.admin, { data: { content: undefined } });
      const mailNode = await rawNode({
        type: 'email',
        title: `${tag} ${mode} a mail`,
        path: root.note.path,
        parent: root.note.id,
        home: ws.admin,
      });
      await raw.begin(async (tx) => {
        await tx`select set_config('mantle.actor', 'system:test', true)`;
        const [mail] = await tx<{ id: string }[]>`
          insert into emails (node_id, account_id, provider_msg_id, from_addr, internal_date)
          values (${mailNode}, ${account}, ${`${tag}-${mode}-mail`}, 'a@example.invalid', now())
          returning id::text as id`;
        await tx`insert into email_attachments (email_id, file_node_id, filename, sha256, storage_key)
                 values (${mail!.id}, ${att}, 'invoice.pdf', 'abc', ${`${tag}-${mode}-key`})`;
      });
      // Before: 400 "file not found" (no bytes outside the system scope).
      const copied = await call(
        `${mode} copy attachment`,
        L.owner,
        'POST',
        `/api/files/files/${att}`,
        {
          copy_to: dest.path,
          confirm: true,
        },
      );
      expect(copied.status, copied.text).toBe(201);
    }, 120_000);

    it(`${mode}: 3 and 4, a bulk delete checks each id and counts the brain's derived items and drawings`, async () => {
      await setMode(mode);
      const dir = await folder(`${tag}${mode}bulk`);
      const fA = await textFile(dir, 'derived.txt', ws.admin);
      const fB = await textFile(dir, 'drawn.png', ws.admin);
      const fC = await textFile(dir, 'hidden.txt', ws.other, { exclude: ws.admin });
      const fD = await textFile(dir, 'readonly.txt', ws.other, { admin: 'read' });
      const fE = await textFile(dir, 'plain.txt', ws.admin);
      const missing = randomUUID();
      const derived = await rawNode({
        type: 'note',
        title: `${tag} ${mode} derived`,
        path: root.note.path,
        parent: root.note.id,
        home: ws.other,
        data: { sourceFileId: fA },
      });
      const draw = await rawNode({
        type: 'draw',
        title: `${tag} ${mode} hidden drawing`,
        path: root.note.path,
        parent: root.note.id,
        home: ws.other,
      });
      await raw.begin(async (tx) => {
        await tx`select set_config('mantle.actor', 'system:test', true)`;
        await tx`insert into draws (node_id, scene, file_refs)
                 values (${draw}, ${raw.json({ elements: [{ fileId: 'b1', isDeleted: false }] })},
                         ${raw.json({ b1: fB })})`;
      });
      // Before: 200 { deleted: 3, hasDerived: [], refused: [] }: the derived
      // note and the drawing were missed, the rest left out silently.
      const bulk = await call(`${mode} bulk delete`, L.owner, 'DELETE', '/api/files/files', {
        ids: [fA, fB, fC, fD, missing, fE],
      });
      expect(bulk.status, bulk.text).toBe(200);
      expect(bulk.json.deleted).toBe(1);
      expect((bulk.json.hasDerived as { fileId: string }[]).map((h) => h.fileId)).toEqual([fA]);
      expect(bulk.json.refused).toEqual([
        { fileId: fC, reason: 'not_found' },
        { fileId: fD, reason: 'forbidden' },
        { fileId: missing, reason: 'not_found' },
        { fileId: fB, reason: 'in_drawing', drawings: [], hiddenDrawings: 1 },
      ]);
      const left = await raw<{ id: string }[]>`select id::text as id from nodes
        where id = any(${[fA, fB, fC, fD, fE]}::uuid[])`;
      expect(left.map((r) => r.id).sort()).toEqual([fA, fB, fC, fD].sort());
      // The confirmed cascade reaps the derived note the scope does not read.
      const cascade = await call(`${mode} bulk cascade`, L.owner, 'DELETE', '/api/files/files', {
        ids: [fA, fC],
        cascade: true,
      });
      expect(cascade.status, cascade.text).toBe(200);
      expect(cascade.json).toMatchObject({
        deleted: 1,
        reapedTotal: 1,
        refused: [{ fileId: fC, reason: 'not_found' }],
      });
      expect(await raw`select 1 from nodes where id = ${derived}`).toHaveLength(0);
    }, 180_000);

    it(`${mode}: 5 and 6, a folder copy meets a hidden folder of its name and copies what it reads`, async () => {
      await setMode(mode);
      const src = await folder(`${tag}${mode}src`);
      await textFile(src, 'top.txt', ws.admin);
      const hidPath = `${src.path}.hid`;
      const hid = await rawNode({
        type: 'branch',
        title: 'hid',
        path: hidPath,
        parent: src.id,
        home: ws.other,
        exclude: ws.admin,
      });
      // A file the owner reads, in a subfolder it does not; one it does not.
      await textFile({ id: hid, path: hidPath }, 'seen.txt', ws.admin);
      await textFile({ id: hid, path: hidPath }, 'unseen.txt', ws.other);
      const label = src.path.split('.').at(-1)!;
      const d1 = await folder(`${tag}${mode}d1`);
      await rawNode({
        type: 'branch',
        title: label,
        path: `${d1.path}.${label}`,
        parent: d1.id,
        home: ws.other,
        exclude: ws.admin,
      });
      // Before: 500 (the unique index of a folder path the scope does not read).
      const clash = await call(
        `${mode} copy onto hidden`,
        L.owner,
        'POST',
        `/api/files/folders/${src.id}`,
        {
          copy_to: d1.path,
          confirm: true,
        },
      );
      expect(clash.status, clash.text).toBe(400);
      expect(clash.text).toContain('already exists');
      const d2 = await folder(`${tag}${mode}d2`);
      // Before: 400 partway ("no folder at ..."), the top file already copied.
      const ok = await call(`${mode} copy`, L.owner, 'POST', `/api/files/folders/${src.id}`, {
        copy_to: d2.path,
        confirm: true,
      });
      expect(ok.status, ok.text).toBe(201);
      expect(ok.json).toMatchObject({ copiedFiles: 1, copiedFolders: 1 });
      const under = await raw<{ title: string }[]>`select title from nodes
        where owner_id = ${L.owner} and path <@ ${`${d2.path}.${label}`}::ltree and type = 'file'`;
      expect(under.map((r) => r.title)).toEqual(['top.txt']);
    }, 180_000);

    it(`${mode}: 7, a folder turned name only re-indexes a file the scope does not read`, async () => {
      await setMode(mode);
      const dir = await folder(`${tag}${mode}idx`);
      const hidden = await textFile(dir, 'secret.txt', ws.other, {
        exclude: ws.admin,
        data: { summary: 'what the content said' },
      });
      // Before: { requeued: 0 }, the hidden file's summary kept.
      const flip = await call(
        `${mode} name only`,
        L.owner,
        'PATCH',
        `/api/files/folders/${dir.id}`,
        {
          indexing: 'metadata',
        },
      );
      expect(flip.status, flip.text).toBe(200);
      expect(flip.json.requeued).toBe(1);
      const [row] = await raw<{ s: string | null }[]>`select data->>'summary' as s from nodes
        where id = ${hidden}`;
      expect(row?.s).toBeNull();
    }, 120_000);

    it(`${mode}: 8, the formula seed skips a seed formula the scope does not read`, async () => {
      await setMode(mode);
      const { FORMULA_SEED } = await import('@mantle/content');
      const slug = FORMULA_SEED[0]!.slug;
      const exists = await raw`select 1 from nodes where owner_id = ${L.owner}
        and type = 'formula' and data->'spec'->>'id' = ${slug}`;
      if (exists.length === 0) {
        await rawNode({
          type: 'formula',
          title: `${tag} hidden seed`,
          path: root.note.path,
          parent: root.note.id,
          home: ws.other,
          data: { spec: { id: slug } },
        });
      }
      // Before: created again (a second formula with that spec id).
      const seed = await call(`${mode} seed`, L.owner, 'POST', '/api/formulas/seed');
      expect(seed.status, seed.text).toBe(200);
      expect(seed.json.skipped).toContain(slug);
      const [n] = await raw<{ n: number }[]>`select count(*)::int as n from nodes
        where owner_id = ${L.owner} and type = 'formula' and data->'spec'->>'id' = ${slug}`;
      expect(n!.n).toBe(1);
    }, 120_000);

    it(`${mode}: 9, an Admin user's app write syncs its linked Table`, async () => {
      await setMode(mode);
      const app = await makeApp(`${mode} export`);
      const { createAppTableExport } = await import('@mantle/content/app-table-exports');
      await m.runAsSystem('test', () => createAppTableExport(L.owner, app, 'items'));
      const synced = async () =>
        (
          await raw<{ h: string | null }[]>`select content_hash as h from app_table_exports
            where app_node_id = ${app}`
        )[0]?.h ?? null;
      const before = await synced();
      const write = await call(`${mode} app write`, L.owner, 'POST', `/api/apps/${app}/db-broker`, {
        op: 'exec',
        sql: 'insert into items (name) values (?)',
        params: ['one'],
      });
      expect(write.status, write.text).toBe(200);
      // The debounced sync (15 s) runs on the system pool. Before: refused in
      // the scope and swallowed, the Table stale.
      let after = before;
      for (let i = 0; i < 40 && after === before; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        after = await synced();
      }
      expect(after).not.toBe(before);
    }, 120_000);

    it(`${mode}: 11, an Admin user who only reads an app writes its data`, async () => {
      await setMode(mode);
      const app = await makeApp(`${mode} readonly`);
      await rehome(app, ws.other, { admin: 'read' });
      // Before, in on: refused (the write sequence, the lazy schema, the salt).
      const write = await call(`${mode} ro write`, L.owner, 'POST', `/api/apps/${app}/db-broker`, {
        op: 'exec',
        sql: 'insert into items (name) values (?)',
        params: ['ro'],
      });
      expect(write.status, write.text).toBe(200);
      const read = await call(`${mode} ro read`, L.owner, 'POST', `/api/apps/${app}/db-broker`, {
        op: 'query',
        sql: 'select name from items',
        params: [],
      });
      expect(read.status, read.text).toBe(200);
      expect(JSON.stringify(read.json.output)).toContain('ro');
    }, 120_000);

    it(`${mode}: 12, a code restore and an import over an app need manage, checked first`, async () => {
      await setMode(mode);
      const app = await makeApp(`${mode} manage`);
      const snap = await call(`${mode} snap`, L.owner, 'POST', `/api/apps/${app}/snapshots`, {
        note: 'one',
      });
      expect(snap.status, snap.text).toBe(201);
      const sid = ((snap.json.snapshot ?? snap.json) as { id: string }).id;
      await rehome(app, ws.other, { admin: 'write' });
      const rows = await snapshotRows(app);
      for (const mode2 of ['code', 'full'] as const) {
        // Before: in on a pre-restore snapshot committed, then the code was
        // refused; in warn the code was restored by an editor.
        const r = await call(
          `${mode} restore ${mode2}`,
          L.owner,
          'POST',
          `/api/apps/${app}/snapshots/${sid}/restore`,
          {
            mode: mode2,
            discardDraft: true,
          },
        );
        expect(r.status, r.text).toBe(403);
        expect(r.json.reason).toBe('item-workspace');
      }
      const imp = await call(`${mode} import over`, L.owner, 'POST', '/api/apps/import', {
        appId: app,
        entry: 'index.tsx',
        files: { 'index.tsx': 'export default function App() { return null; }' },
        build: false,
      });
      expect(imp.status, imp.text).toBe(403);
      expect(await snapshotRows(app)).toBe(rows);
      // A data restore is an editor's (the gate's edit, the data's appdata).
      const data = await call(
        `${mode} restore data`,
        L.owner,
        'POST',
        `/api/apps/${app}/snapshots/${sid}/restore`,
        {
          mode: 'data',
        },
      );
      expect(data.status, data.text).toBe(200);
    }, 180_000);

    it(`${mode}: 14, a Recall map's slug is free only when no map answers to it`, async () => {
      await setMode(mode);
      const target = `${tag}-${mode}-target`;
      const hidden = await call(`${mode} map hidden`, L.owner, 'POST', '/api/recall/maps', {
        title: `${tag} ${mode} former`,
        enterWhen: 'a test',
      });
      expect(hidden.status, hidden.text).toBe(201);
      const hid = hidden.json.mapId as string;
      const former = hidden.json.slug as string;
      const moved = await call(`${mode} map move`, L.owner, 'PATCH', `/api/recall/maps/${hid}`, {
        slug: target,
        version: hidden.json.version,
      });
      expect(moved.status, moved.text).toBe(200);
      await rehome(hid, ws.other, { exclude: ws.admin });
      // Before: 500 (the unique index of the hidden map's slug).
      const same = await call(`${mode} map same`, L.owner, 'POST', '/api/recall/maps', {
        title: `${tag} ${mode} target`,
        enterWhen: 'a test',
      });
      expect(same.status, same.text).toBe(201);
      expect(same.json.slug).not.toBe(target);
      // Before: 200, two maps answering to the hidden map's former slug.
      const take = await call(
        `${mode} map take former`,
        L.owner,
        'PATCH',
        `/api/recall/maps/${same.json.mapId as string}`,
        {
          slug: former,
          version: same.json.version,
        },
      );
      // The answer a slug a map the owner reads holds gets (400 slug_taken).
      expect(take.status, take.text).toBe(400);
      expect(take.json.code).toBe('slug_taken');
    }, 120_000);
  }

  it('members: a commit keeps no history (as since W6b), a re-index reaches what it does not read, a bulk delete is not theirs', async () => {
    await setMode('on');
    const made = await call('member t create', L.owner, 'POST', '/api/tables', {
      title: `${tag} member table`,
    });
    const id = (made.json.table as { id: string }).id;
    const first = await call('owner t commit', L.owner, 'POST', `/api/tables/${id}/commit`, {
      data: {
        columns: [{ id: 'c', name: 'C', type: 'text' }],
        rows: [{ id: 'r', cells: { c: 'x' } }],
      },
    });
    expect(first.status, first.text).toBe(200);
    await rehome(id, ws.other);
    const rows = await snapshotRows(id, 'commit');
    const commit = await call('member t commit', L.member, 'POST', `/api/tables/${id}/commit`, {
      data: {
        columns: [{ id: 'c', name: 'C', type: 'text' }],
        rows: [{ id: 'r', cells: { c: 'y' } }],
      },
    });
    expect(commit.status, commit.text).toBe(200);
    expect(await snapshotRows(id, 'commit')).toBe(rows);
    // A folder of the member's workspace holding a file it does not read.
    const dir = await folder(`${tag}memidx`);
    await rehome(dir.id, ws.other);
    const hidden = await textFile(dir, 'admins.txt', ws.admin, {
      exclude: ws.other,
      data: { summary: 'admin content' },
    });
    const flip = await call('member name only', L.member, 'PATCH', `/api/files/folders/${dir.id}`, {
      indexing: 'metadata',
    });
    expect(flip.status, flip.text).toBe(200);
    expect(flip.json.requeued).toBe(1);
    expect(flip.text).not.toContain('admins.txt');
    const [row] = await raw<{ s: string | null }[]>`select data->>'summary' as s from nodes
      where id = ${hidden}`;
    expect(row?.s).toBeNull();
    const bulk = await call('member bulk delete', L.member, 'DELETE', '/api/files/files', {
      ids: [hidden],
    });
    expect(bulk.status, bulk.text).toBe(403);
    expect(await raw`select 1 from nodes where id = ${hidden}`).toHaveLength(1);
  }, 180_000);
});
