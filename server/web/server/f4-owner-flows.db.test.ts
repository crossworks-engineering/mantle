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
 * `pnpm test:edit-on` and `pnpm test:runtime-role` run this file too.
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
});
