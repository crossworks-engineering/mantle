/**
 * Admin acts become definers, part c1 (plan v3.2; migration 0308): four Admin acts
 * as SECURITY DEFINER functions that check the Admin user inside
 * (mantle_admin_act_brain), on a migrated scratch database, in warn and in
 * on (the actor and the edit check together, as on the fleet):
 *
 *  - each definer, called in a scope: an Admin user's scope yes; a
 *    member's scope, no scope, a scope without the Admin workspace and a
 *    disabled Admin user no (42501), with nothing written;
 *  - each route through the full HTTP pipeline (runRoute) as an Admin user
 *    who is not the owner, and as one without the users area (no area
 *    names these acts): the answers the owner gets (f4-owner-flows covers
 *    the owner);
 *  - member-negative per route: the guard's 403, nothing written;
 *  - the system door (the content functions with an owner, the
 *    entities-dedupe sweep's mergeEntities) writes what the definer
 *    writes: one SQL body, byte-equal rows.
 *
 * `pnpm test:edit-on` runs this file too.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/s6-c1-admin-acts.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;

/** The backfill queue a contact add sends to (pg-boss replaced). */
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

type Mode = 'warn' | 'on';

describe.skipIf(!DB_URL)('S6 c1: four Admin acts as definers', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let raw: ReturnType<typeof postgres>;
  let m: typeof import('@mantle/db');
  let content: typeof import('@mantle/content');
  let actorMode: typeof import('../../../packages/db/src/actor');
  let runRoute: typeof import('./run-route').runRoute;
  let dir = '';
  const tag = `s6c1${randomUUID().slice(0, 6)}`;
  const L = {
    owner: randomUUID(),
    admin: randomUUID(),
    limited: randomUUID(),
    gone: randomUUID(),
    member: randomUUID(),
    /** Role admin, no seat in the Admin workspace (role drift). */
    drift: randomUUID(),
  };
  const ws = { admin: '', other: '' };
  const root: Record<'note' | 'app' | 'contact', { id: string; path: string }> = {
    note: { id: '', path: 'notes' },
    app: { id: '', path: 'apps' },
    contact: { id: '', path: 'contacts' },
  };
  const recorded: string[] = [];

  /** An item of `kind` homed in the other workspace: no Admin user's scope
   *  reads it (sharing with a contact does not check the home). A contact
   *  stays in Admin. */
  const makeItem = async (
    kind: 'note' | 'app' | 'contact',
    title: string = kind,
  ): Promise<string> => {
    const id = randomUUID();
    await raw.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`select mantle_lock_heads(array[${root[kind].id}]::uuid[], 'share')`;
      await tx`insert into nodes (id, owner_id, type, title, path, data)
               values (${id}, ${L.owner}, ${kind}, ${`${tag} ${title} ${id.slice(0, 8)}`},
                       ${root[kind].path}::ltree, ${raw.json({ rank: 'a0' })})`;
    });
    // A contact keeps its home (Admin: a contact is granted nowhere else).
    if (kind === 'contact') return id;
    await raw.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
      await tx`delete from item_grants where node_id = ${id} and via_folder_id is null`;
      await tx`insert into item_grants (node_id, workspace_id, is_home, write)
               values (${id}, ${ws.other}, true, false)`;
    });
    return id;
  };

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

  /** The scope a login holds now (its live workspaces), as uuid[] text. */
  const scopeOf = async (login: string) => {
    const s = await m.loginScopeFor(login);
    return { ws: `{${s.ws.join(',')}}`, mod: `{${s.modWs.join(',')}}` };
  };

  /** One definer call in a hand-set scope: `as` the scope's login (null:
   *  none), `ws` its workspaces (null: the login's own). The SQLSTATE of a
   *  refusal, else the rows. Rolled back either way when `dry`. */
  const inScope = async <T>(
    as: string | null,
    ws: string | null,
    q: (tx: postgres.TransactionSql) => Promise<T>,
  ): Promise<{ code: string | null; rows: T | null }> => {
    const scope = as ? await scopeOf(as) : { ws: '{}', mod: '{}' };
    try {
      const rows = await raw.begin(async (tx) => {
        await tx`select set_config('mantle.actor', 'system:test', true),
                        set_config('mantle.ws', ${ws ?? scope.ws}, true),
                        set_config('mantle.mod_ws', ${ws === null ? scope.mod : '{}'}, true),
                        set_config('mantle.scope_login', ${as ?? ''}, true)`;
        return q(tx);
      });
      return { code: null, rows: rows as T };
    } catch (err) {
      return { code: (err as { code?: string }).code ?? 'none', rows: null };
    }
  };

  const liveShares = async (contact: string) =>
    (
      await raw<{ n: number }[]>`select count(*)::int as n from shares
        where contact_id = ${contact} and revoked_at is null`
    )[0]!.n;

  const codeRow = async (contact: string) =>
    (
      await raw<{ hash: string | null; epoch: number }[]>`
        select code_hash as hash, code_epoch as epoch from contact_share_codes
         where contact_id = ${contact}`
    )[0] ?? null;

  const entityPair = async (who: string) =>
    raw.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      const [c] = await tx<{ id: string }[]>`insert into entities (owner_id, kind, name, aliases)
        values (${L.owner}, 'person', ${`${tag} ${who} Ada Lovelace`}, ${['Ada', ' ada  ']})
        returning id::text as id`;
      const [d] = await tx<{ id: string }[]>`insert into entities (owner_id, kind, name, aliases)
        values (${L.owner}, 'person', ${` ${tag} ${who} A. Lovelace `},
                ${['Ada', `${tag} ${who} ADA LOVELACE`, '', 'Countess']})
        returning id::text as id`;
      return { canon: c!.id, dup: d!.id };
    });

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(DB_URL!);
    dir = await mkdtemp(path.join(tmpdir(), 's6-c1-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 's6-c1-admin-acts-secret-at-least-32-characters';
    delete process.env.MANTLE_DETACHED_DEV;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the S6 c1 test', { status: 503 })),
    );
    m = await import('@mantle/db');
    content = await import('@mantle/content');
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
    // The Admin users: Moderators of Admin; `limited` without the users
    // area; `gone` disabled once the routes are done.
    for (const id of [L.admin, L.limited, L.gone]) {
      await raw`insert into workspace_users (workspace_id, login_id, moderator, limits)
        values (${ws.admin}, ${id}, true,
                ${raw.json(id === L.limited ? { areas: { users: false } } : {})})
        on conflict (workspace_id, login_id)
        do update set moderator = true, limits = excluded.limits`;
    }
    // The role drift login holds no seat anywhere (whatever the migrate gave).
    await raw`delete from workspace_users where login_id = ${L.drift}`;
    for (const kind of ['note', 'app', 'contact'] as const) {
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
    m.takeActorMisses();
  }, 300_000);

  afterAll(async () => {
    console.log(['S6 c1 Admin acts, each answer:', ...recorded].join('\n  '));
    process.env.MANTLE_ACTOR_CHECK = 'warn';
    vi.unstubAllGlobals();
    await raw?.end();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  for (const mode of ['warn', 'on'] as const) {
    for (const who of ['admin', 'limited'] as const) {
      it(`${mode}: an Admin user (${who}) does the four acts through the routes`, async () => {
        await setMode(mode);
        const login = L[who];
        const c = await makeItem('contact', `${mode} ${who}`);
        const on = await call(
          `${mode} ${who} enable`,
          login,
          'POST',
          `/api/contacts/${c}/sharing`,
          {
            action: 'enable',
          },
        );
        expect(on.status, on.text).toBe(200);
        expect(typeof on.json.code).toBe('string');
        const twice = await call(
          `${mode} ${who} enable again`,
          login,
          'POST',
          `/api/contacts/${c}/sharing`,
          {
            action: 'enable',
          },
        );
        expect(twice.status, twice.text).toBe(409);
        expect(twice.json).toEqual({
          error: 'Sharing is already on. Regenerate the code instead.',
          reason: 'already-on',
        });
        const again = await call(
          `${mode} ${who} regenerate`,
          login,
          'POST',
          `/api/contacts/${c}/sharing`,
          {
            action: 'regenerate',
          },
        );
        expect(again.status, again.text).toBe(200);
        expect(again.json.code).not.toBe(on.json.code);
        expect((await codeRow(c))?.epoch).toBe(2);

        const note = await makeItem('note');
        const app = await makeItem('app');
        const shared = await call(`${mode} ${who} share`, login, 'POST', '/api/shares/contacts', {
          nodeId: note,
          contactIds: [c, c.toUpperCase()],
        });
        expect(shared.status, shared.text).toBe(200);
        const [one] = shared.json.shares as { shareId: string; contactId: string; path: string }[];
        expect(one).toMatchObject({ contactId: c });
        const same = await call(
          `${mode} ${who} share again`,
          login,
          'POST',
          '/api/shares/contacts',
          {
            nodeId: note,
            contactIds: [c],
          },
        );
        expect((same.json.shares as unknown[])[0]).toEqual(one);
        const refusedWrite = await call(
          `${mode} ${who} write on a note`,
          login,
          'POST',
          '/api/shares/contacts',
          {
            nodeId: note,
            contactIds: [c],
            canWrite: true,
          },
        );
        expect(refusedWrite.status).toBe(400);
        expect(refusedWrite.json).toEqual({
          error: 'Only an app can let a contact write.',
          reason: 'write-not-app',
        });
        const folder = await call(
          `${mode} ${who} share a folder`,
          login,
          'POST',
          '/api/shares/contacts',
          {
            nodeId: root.note.id,
            contactIds: [c],
          },
        );
        expect(folder.status).toBe(400);
        expect(folder.json.reason).toBe('folder');
        const notContact = await call(
          `${mode} ${who} share with a note`,
          login,
          'POST',
          '/api/shares/contacts',
          {
            nodeId: app,
            contactIds: [note],
          },
        );
        expect(notContact.json).toEqual({
          error: 'Not a contact of this brain.',
          reason: 'not-a-contact',
        });
        const appShare = await call(
          `${mode} ${who} share an app`,
          login,
          'POST',
          '/api/shares/contacts',
          {
            nodeId: app,
            contactIds: [c],
            canWrite: true,
          },
        );
        expect(appShare.status, appShare.text).toBe(200);
        expect(await liveShares(c)).toBe(2);

        const all = await call(
          `${mode} ${who} revoke all`,
          login,
          'DELETE',
          `/api/contacts/${c}/shares`,
        );
        expect(all.status, all.text).toBe(200);
        expect(all.json).toEqual({ revoked: 2 });
        const none = await call(
          `${mode} ${who} revoke all, not a contact`,
          login,
          'DELETE',
          `/api/contacts/${note}/shares`,
        );
        expect(none.status).toBe(404);
        expect(none.json).toEqual({ error: 'not found' });

        const off = await call(
          `${mode} ${who} disable`,
          login,
          'POST',
          `/api/contacts/${c}/sharing`,
          {
            action: 'disable',
          },
        );
        expect(off.json).toEqual({ sharing: null, revoked: 0 });
        const offAgain = await call(
          `${mode} ${who} disable again`,
          login,
          'POST',
          `/api/contacts/${c}/sharing`,
          {
            action: 'disable',
          },
        );
        expect(offAgain.json).toEqual({ sharing: null, revoked: 0 });
        const regenOff = await call(
          `${mode} ${who} regenerate off`,
          login,
          'POST',
          `/api/contacts/${c}/sharing`,
          {
            action: 'regenerate',
          },
        );
        expect(regenOff.status).toBe(409);
        expect(regenOff.json).toEqual({
          error: 'Sharing is off for this contact.',
          reason: 'sharing-off',
        });
        const missing = await call(
          `${mode} ${who} sharing, not a contact`,
          login,
          'POST',
          `/api/contacts/${note}/sharing`,
          {
            action: 'enable',
          },
        );
        expect(missing.status).toBe(404);
        expect(missing.json).toEqual({ error: 'not found' });

        const pair = await entityPair(`${mode} ${who}`);
        // A fact and an edge of the duplicate, from the note homed in the
        // other workspace (no Admin user's scope reads it): both move.
        const { fact, edge } = await raw.begin(async (tx) => {
          await tx`select set_config('mantle.actor', 'system:test', true)`;
          const [f] = await tx<{ id: string }[]>`
            insert into facts (owner_id, kind, content, source_node_id, entity_id)
            values (${L.owner}, 'factual', ${`${tag} ${mode} ${who} a fact`}, ${note}, ${pair.dup})
            returning id::text as id`;
          const [e] = await tx<{ id: string }[]>`
            insert into entity_edges (owner_id, source_id, source_kind, target_id, target_kind, relation)
            values (${L.owner}, ${note}, 'node', ${pair.dup}, 'entity', 'mentions')
            returning id::text as id`;
          return { fact: f!.id, edge: e!.id };
        });
        const merged = await call(`${mode} ${who} merge`, login, 'POST', '/api/entities/merge', {
          canonicalId: pair.canon,
          dupId: pair.dup,
        });
        expect(merged.json).toEqual({ ok: true });
        const [moved] = await raw<{ f: string | null; e: string | null }[]>`
          select (select entity_id::text from facts where id = ${fact}) as f,
                 (select target_id::text from entity_edges where id = ${edge}) as e`;
        expect(moved).toEqual({ f: pair.canon, e: pair.canon });
        const gone = await call(
          `${mode} ${who} merge again`,
          login,
          'POST',
          '/api/entities/merge',
          {
            canonicalId: pair.canon,
            dupId: pair.dup,
          },
        );
        expect(gone.status).toBe(404);
        expect(gone.json).toEqual({ error: 'entity not found' });
      }, 180_000);
    }

    it(`${mode}: a member, and a login with role admin outside Admin, reach none of the four acts`, async () => {
      await setMode(mode);
      const c = await makeItem('contact', `${mode} member`);
      const note = await makeItem('note');
      const pair = await entityPair(`${mode} member`);
      // The guard's own refusal of a login that is no Admin user; a role
      // drift login (role admin, no seat in Admin) got 200 on main and now
      // gets this from inside the definer (narrower).
      const refused = {
        error: 'forbidden',
        reason: 'member-login',
        message: 'Not available to member logins.',
      };
      for (const who of ['member', 'drift'] as const) {
        for (const [method, url, body] of [
          ['POST', `/api/contacts/${c}/sharing`, { action: 'enable' }],
          ['DELETE', `/api/contacts/${c}/shares`, undefined],
          ['POST', '/api/shares/contacts', { nodeId: note, contactIds: [c] }],
          ['POST', '/api/entities/merge', { canonicalId: pair.canon, dupId: pair.dup }],
        ] as const) {
          const r = await call(`${mode} ${who} ${method} ${url}`, L[who], method, url, body);
          expect(r.status, r.text).toBe(403);
          expect(r.json, r.text).toEqual(refused);
        }
      }
      expect(await codeRow(c)).toBeNull();
      expect(await liveShares(c)).toBe(0);
      expect((await raw`select 1 from entities where id = ${pair.dup}`).length).toBe(1);
    }, 120_000);

    it(`${mode}: each definer checks the Admin user inside`, async () => {
      await setMode(mode);
      const c = await makeItem('contact', `${mode} definer`);
      const note = await makeItem('note');
      const pair = await entityPair(`${mode} definer`);
      const hash = 'a'.repeat(64);
      const acts: Array<[string, (tx: postgres.TransactionSql) => Promise<unknown>]> = [
        ['sharing', (tx) => tx`select * from mantle_contact_sharing_set(${c}, 'enable', ${hash})`],
        ['revoke all', (tx) => tx`select mantle_contact_shares_revoke_all(${c}) as n`],
        [
          'share',
          (tx) => tx`select * from mantle_share_with_contacts(${note}, ${`{${c}}`}::uuid[],
                       ${'{tok' + randomUUID().slice(0, 8) + '}'}::text[], false, ${'{note,page}'}::text[])`,
        ],
        ['merge', (tx) => tx`select mantle_entity_merge(${pair.canon}, ${pair.dup}) as ok`],
      ];
      for (const [name, q] of acts) {
        // A member's scope, no scope, an Admin user's login over a scope
        // without the Admin workspace, the owner unscoped: 42501.
        expect((await inScope(L.member, null, q)).code, `${name} member`).toBe('42501');
        expect((await inScope(null, null, q)).code, `${name} unscoped`).toBe('42501');
        expect((await inScope(L.admin, `{${ws.other}}`, q)).code, `${name} no Admin`).toBe('42501');
        expect((await inScope(null, `{${ws.admin}}`, q)).code, `${name} no login`).toBe('42501');
      }
      // Nothing was written by a refusal.
      expect(await codeRow(c)).toBeNull();
      // An Admin user's scope: yes, in order (sharing on before the share).
      for (const [name, q] of acts) {
        expect((await inScope(L.admin, null, q)).code, `${name} admin`).toBeNull();
      }
      expect((await codeRow(c))?.hash).toBe(hash);
      expect((await raw`select 1 from entities where id = ${pair.dup}`).length).toBe(0);
    }, 120_000);
  }

  it('a disabled Admin user is refused inside the definer', async () => {
    await setMode('on');
    const c = await makeItem('contact', 'disabled');
    const scope = await scopeOf(L.gone);
    await raw`update auth.users set disabled_at = now() where id = ${L.gone}`;
    const r = await inScope(
      L.gone,
      scope.ws,
      (tx) => tx`select mantle_contact_shares_revoke_all(${c}) as n`,
    );
    expect(r.code).toBe('42501');
  }, 60_000);

  it('the system door writes what the definer writes (one SQL body)', async () => {
    await setMode('on');
    const a = await entityPair('door a');
    const b = await entityPair('door b');
    const viaDoor = await m.asSystem(() => content.mergeEntities(L.owner, a.canon, a.dup), 'test');
    expect(viaDoor).toBe(true);
    const viaAct = await inScope(
      L.admin,
      null,
      (tx) => tx`select mantle_entity_merge(${b.canon}, ${b.dup}) as ok`,
    );
    expect(viaAct.code).toBeNull();
    const aliases = async (id: string, who: string) =>
      (await raw<{ a: string[] }[]>`select aliases as a from entities where id = ${id}`)[0]!.a.map(
        (x) => x.replace(who, 'WHO'),
      );
    const fromDoor = await aliases(a.canon, 'door a');
    expect(fromDoor).toEqual(await aliases(b.canon, 'door b'));
    // Trimmed, the first of equal ones kept, no empty one, not the
    // canonical's own name in another case, the dup's name in.
    expect(fromDoor).toEqual(['Ada', 'ada', `${tag} WHO A. Lovelace`, 'Countess']);
  }, 60_000);
});
