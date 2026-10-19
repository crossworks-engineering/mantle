/**
 * The workspace row in SQL (plan v3.2 S2b; migration 0309): PATCH
 * /api/workspaces/:id and POST /api/workspaces/:id/archive through the
 * full HTTP pipeline (runRoute), on a migrated scratch database, in warn
 * and in on (the actor and the edit check together, as on the fleet):
 *
 *  - a Moderator renames, describes and gives a look, sets the landing app
 *    and archives; an Admin user sets the contact and the assistant: the
 *    answers as before, each change one event row naming the login;
 *  - the refusals the route answered before, by status, code and text;
 *  - member-negative: a login outside the workspace and a Moderator of a
 *    sibling get the answer a random id gets, and nothing changes; a plain
 *    user of it gets the 403 it got before, nothing changed.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/s2b-ws-row-routes.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;

/** The database's or the runtime's own words: never in a reply. */
const RAW =
  /Failed query|withSystemTx|runInSystemTx|SQLSTATE|DrizzleQueryError|drizzle-orm|permission denied for|violates|duplicate key|does not exist|mantle_ws:|\n\s+at \S/i;

type Mode = 'warn' | 'on';

describe.skipIf(!DB_URL)('S2b: the workspace row through the routes', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let raw: ReturnType<typeof postgres>;
  let m: typeof import('@mantle/db');
  let actorMode: typeof import('../../../packages/db/src/actor');
  let runRoute: typeof import('./run-route').runRoute;
  let dir = '';
  const tag = `s2b${randomUUID().slice(0, 6)}`;
  const L = {
    owner: randomUUID(),
    admin: randomUUID(), // an Admin user, every area
    mod: randomUUID(), // member, Moderator of W
    mem: randomUUID(), // member, a plain user of W
    sib: randomUUID(), // member, Moderator of the sibling S only
    out: randomUUID(), // member, in no workspace
  };
  const ws = { admin: '', W: '', S: '' };
  const AGENT = randomUUID();
  const ids = { contact: '', app: '' };
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
    return { status: res.status, json };
  };

  /** The workspace row and its event count: what a refusal must leave. */
  const state = async (id: string) => {
    const [row] = await raw`select name, description, color, icon, contact_id, landing_app_id,
                                   archived_at, updated_at from workspaces where id = ${id}`;
    const [ev] = await raw<{ n: number }[]>`
      select count(*)::int as n from workspace_events where workspace_id = ${id}`;
    return { row, events: ev!.n };
  };
  const lastEvent = async (id: string) =>
    (
      await raw<{ actor: string; action: string; subject: unknown }[]>`
        select actor_id::text as actor, action, subject from workspace_events
         where workspace_id = ${id} order by at desc, id desc limit 1`
    )[0];

  const makeItem = async (kind: 'app' | 'contact' | 'note', home: string): Promise<string> => {
    const p = kind === 'app' ? 'apps' : kind === 'note' ? 'notes' : 'contacts';
    // The root folder, made with an actor (a cell may run with the check on).
    await raw.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`insert into nodes (owner_id, type, title, path)
        select ${L.owner}, 'branch', ${p}, ${p}::ltree
         where not exists (select 1 from nodes where owner_id = ${L.owner}
                             and type = 'branch' and path = ${p}::ltree)`;
    });
    const [root] = await raw<{ id: string }[]>`select id::text as id from nodes
      where owner_id = ${L.owner} and type = 'branch' and path = ${p}::ltree`;
    const id = randomUUID();
    await raw.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`select mantle_lock_heads(array[${root!.id}]::uuid[], 'share')`;
      await tx`insert into nodes (id, owner_id, type, title, path, data)
               values (${id}, ${L.owner}, ${kind}, ${`${tag} ${kind}`}, ${p}::ltree,
                       ${raw.json({ rank: 'a0' })})`;
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

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(DB_URL!);
    dir = await mkdtemp(path.join(tmpdir(), 's2b-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 's2b-ws-row-routes-secret-at-least-32-characters';
    delete process.env.MANTLE_DETACHED_DEV;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the S2b test', { status: 503 })),
    );
    m = await import('@mantle/db');
    actorMode = await import('../../../packages/db/src/actor');
    runRoute = (await import('./run-route')).runRoute;
    raw = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });

    for (const [who, id] of Object.entries(L)) {
      const role = who === 'owner' || who === 'admin' ? 'admin' : 'member';
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
    await raw`insert into workspace_users (workspace_id, login_id, moderator)
      values (${ws.admin}, ${L.admin}, true)
      on conflict (workspace_id, login_id) do update set moderator = true`;
    for (const k of ['W', 'S'] as const) {
      ws[k] = (
        await raw<{ id: string }[]>`insert into workspaces (owner_id, name)
          values (${L.owner}, ${`${tag} ${k}`}) returning id::text as id`
      )[0]!.id;
    }
    await raw`delete from workspace_users where login_id in ${raw([L.mod, L.mem, L.sib, L.out])}`;
    await raw`insert into workspace_users (workspace_id, login_id, moderator) values
      (${ws.W}, ${L.mod}, true), (${ws.W}, ${L.mem}, false), (${ws.S}, ${L.sib}, true)`;
    await raw`insert into agents (id, owner_id, slug, name, model, system_prompt, role)
      values (${AGENT}, ${L.owner}, ${`${tag}-a`}, 'A', 'm', 'p', 'responder')`;
    ids.contact = await makeItem('contact', ws.admin);
    ids.app = await makeItem('app', ws.W);
    await raw`insert into apps (node_id, published_build) values (${ids.app}, ${raw.json({ ok: true })})`;
    m.takeActorMisses();
  }, 300_000);

  afterAll(async () => {
    console.log(['S2b workspace row, each answer:', ...recorded].join('\n  '));
    process.env.MANTLE_ACTOR_CHECK = 'warn';
    vi.unstubAllGlobals();
    await raw?.end();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  for (const mode of ['warn', 'on'] as const) {
    it(`${mode}: a Moderator and an Admin user change the row through PATCH`, async () => {
      await setMode(mode);
      const url = `/api/workspaces/${ws.W}`;
      const about = { name: `${tag} W ${mode}`, description: `d ${mode}`, icon: 'lucide:star' };
      const a = await call(`${mode} mod about`, L.mod, 'PATCH', url, about);
      expect(a.status).toBe(200);
      expect(a.json).toMatchObject({
        id: ws.W,
        name: about.name,
        description: about.description,
      });
      expect(await lastEvent(ws.W)).toEqual({
        actor: L.mod,
        action: 'workspace.update',
        subject: about,
      });
      const look = await call(`${mode} mod look clear`, L.mod, 'PATCH', url, { icon: null });
      expect(look.status).toBe(200);
      const land = await call(`${mode} mod landing`, L.mod, 'PATCH', url, {
        landingAppId: ids.app,
      });
      expect(land.status).toBe(200);
      expect(await lastEvent(ws.W)).toEqual({
        actor: L.mod,
        action: 'workspace.landing',
        subject: { appId: ids.app },
      });
      expect(
        (await call(`${mode} mod landing off`, L.mod, 'PATCH', url, { landingAppId: null })).status,
      ).toBe(200);
      const c = await call(`${mode} admin contact`, L.admin, 'PATCH', url, {
        contactNodeId: ids.contact,
      });
      expect(c.status).toBe(200);
      expect(c.json).toMatchObject({ contactNodeId: ids.contact });
      expect(await lastEvent(ws.W)).toEqual({
        actor: L.admin,
        action: 'workspace.update',
        subject: { contactNodeId: ids.contact },
      });
      expect(
        (await call(`${mode} admin contact off`, L.admin, 'PATCH', url, { contactNodeId: null }))
          .status,
      ).toBe(200);
      const asst = await call(`${mode} admin assistant`, L.admin, 'PATCH', url, {
        assistantId: AGENT,
      });
      expect(asst.status).toBe(200);
      expect(asst.json).toMatchObject({ assistant: { id: AGENT, name: 'A' } });
      expect(
        (await call(`${mode} admin assistant off`, L.admin, 'PATCH', url, { assistantId: null }))
          .status,
      ).toBe(200);
    });

    it(`${mode}: the refusals PATCH answered before, nothing changed`, async () => {
      await setMode(mode);
      const url = `/api/workspaces/${ws.W}`;
      const before = await state(ws.W);
      const cases: Array<[string, string, unknown, number, Record<string, unknown>]> = [
        [
          'mem about',
          L.mem,
          { name: 'x' },
          403,
          { code: 'forbidden', error: 'Only a Moderator of this workspace can change it.' },
        ],
        [
          'mod contact',
          L.mod,
          { contactNodeId: ids.contact },
          403,
          { code: 'admin_only', error: 'Only an Admin user can set the contact.' },
        ],
        [
          'mod assistant',
          L.mod,
          { assistantId: AGENT },
          403,
          { code: 'admin_only', error: 'Only an Admin user can change the assistant.' },
        ],
        [
          'admin landing',
          L.admin,
          { landingAppId: ids.app },
          403,
          {
            code: 'forbidden',
            error: 'Only a Moderator of this workspace can set its landing page.',
          },
        ],
        [
          'mod reserved',
          L.mod,
          { name: 'Admin' },
          409,
          {
            code: 'reserved_name',
            error: 'Admin is the name of the built-in Admin workspace. Pick another name.',
          },
        ],
        [
          'admin no contact',
          L.admin,
          { contactNodeId: randomUUID() },
          400,
          { code: 'invalid', error: 'contactNodeId: no such contact.' },
        ],
        [
          'mod not held',
          L.mod,
          { landingAppId: randomUUID() },
          409,
          {
            code: 'landing_app_not_held',
            error: 'This workspace does not hold that app. Share the app with the workspace first.',
          },
        ],
        // A body that is valid as far as it goes, refused later: nothing of it is kept.
        [
          'mod name then not held',
          L.mod,
          { name: `${tag} kept?`, landingAppId: randomUUID() },
          409,
          { code: 'landing_app_not_held' },
        ],
      ];
      for (const [name, who, body, status, json] of cases) {
        const r = await call(`${mode} ${name}`, who, 'PATCH', url, body);
        expect(r.status, name).toBe(status);
        expect(r.json, name).toMatchObject(json);
      }
      const adminName = await call(
        `${mode} admin rename Admin`,
        L.admin,
        'PATCH',
        `/api/workspaces/${ws.admin}`,
        { name: 'Other' },
      );
      expect(adminName).toEqual({
        status: 409,
        json: { code: 'reserved_name', error: 'The Admin workspace keeps its name.' },
      });
      expect(await state(ws.W)).toEqual(before);
    });

    it(`${mode}: member-negative: outside the workspace is a random id's answer, nothing changes`, async () => {
      await setMode(mode);
      const before = await state(ws.W);
      for (const who of [L.out, L.sib]) {
        for (const body of [{ name: 'x' }, { landingAppId: ids.app }, { contactNodeId: null }]) {
          const real = await call(
            `${mode} neg patch`,
            who,
            'PATCH',
            `/api/workspaces/${ws.W}`,
            body,
          );
          const ghost = await call(
            `${mode} neg patch ghost`,
            who,
            'PATCH',
            `/api/workspaces/${randomUUID()}`,
            body,
          );
          expect(real).toEqual(ghost);
          expect(real.status).toBe(404);
        }
        const real = await call(
          `${mode} neg archive`,
          who,
          'POST',
          `/api/workspaces/${ws.W}/archive`,
        );
        const ghost = await call(
          `${mode} neg archive ghost`,
          who,
          'POST',
          `/api/workspaces/${randomUUID()}/archive`,
        );
        expect(real).toEqual(ghost);
        expect(real.status).toBe(404);
      }
      const plain = await call(
        `${mode} mem archive`,
        L.mem,
        'POST',
        `/api/workspaces/${ws.W}/archive`,
      );
      expect(plain).toEqual({
        status: 403,
        json: { code: 'forbidden', error: 'Only a Moderator of this workspace can archive it.' },
      });
      expect(await state(ws.W)).toEqual(before);
    });

    it(`${mode}: an Admin user outside the workspace archives it, dropping a share of an item it cannot read (the edit check on)`, async () => {
      await setMode(mode);
      // Why the archive runs on the system pool in the login's write scope:
      // on the write role the heads lock leaves out items the scope does not
      // read, and this Admin user reads neither V nor the note (homed in S).
      await raw`select mantle_set_edit_check('on', 50, 'test')`;
      const v = (
        await raw<{ id: string }[]>`insert into workspaces (owner_id, name)
          values (${L.owner}, ${`${tag} V ${mode}`}) returning id::text as id`
      )[0]!.id;
      await raw`delete from workspace_users where workspace_id = ${v}`;
      const note = await makeItem('note', ws.S);
      await raw.begin(async (tx) => {
        await tx`select set_config('mantle.actor', 'system:test', true)`;
        await tx`select mantle_lock_heads(array[${note}]::uuid[], 'update')`;
        await tx`insert into item_grants (node_id, workspace_id, is_home, write)
                 values (${note}, ${v}, false, false)`;
      });
      const done = await call(
        `${mode} admin archive V`,
        L.admin,
        'POST',
        `/api/workspaces/${v}/archive`,
      );
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({
        itemCount: 0,
        grantCount: 1,
        workspace: { id: v, archived: true },
      });
      expect(await lastEvent(v)).toEqual({
        actor: L.admin,
        action: 'workspace.archive',
        subject: { grantsDropped: 1, exclusionsDropped: 0 },
      });
      const [left] = await raw<{ n: number }[]>`
        select count(*)::int as n from item_grants where workspace_id = ${v}`;
      expect(left!.n).toBe(0);
      // The note keeps its home in S.
      const [home] = await raw<{ ws: string }[]>`
        select workspace_id::text as ws from item_grants where node_id = ${note} and is_home`;
      expect(home!.ws).toBe(ws.S);
    });

    it(`${mode}: a Moderator archives; Admin is never archived`, async () => {
      await setMode(mode);
      const made = await call(`${mode} create`, L.mod, 'POST', '/api/workspaces', {
        name: `${tag} gone ${mode}`,
      });
      expect(made.status).toBe(201);
      const id = (made.json as { id: string }).id;
      const preview = await call(
        `${mode} preview`,
        L.mod,
        'GET',
        `/api/workspaces/${id}/archive-preview`,
      );
      expect(preview).toEqual({ status: 200, json: { itemCount: 0, grantCount: 0 } });
      const done = await call(`${mode} archive`, L.mod, 'POST', `/api/workspaces/${id}/archive`);
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({
        itemCount: 0,
        grantCount: 0,
        workspace: { id, archived: true },
      });
      expect(await lastEvent(id)).toEqual({
        actor: L.mod,
        action: 'workspace.archive',
        subject: { grantsDropped: 0, exclusionsDropped: 0 },
      });
      // Archived: the Moderator no longer sees it; an Admin user is told.
      expect(
        (await call(`${mode} again`, L.mod, 'POST', `/api/workspaces/${id}/archive`)).status,
      ).toBe(404);
      expect(
        await call(`${mode} admin again`, L.admin, 'POST', `/api/workspaces/${id}/archive`),
      ).toEqual({
        status: 409,
        json: { code: 'archived', error: 'This workspace is archived and cannot be changed.' },
      });
      expect(
        await call(
          `${mode} admin archive Admin`,
          L.admin,
          'POST',
          `/api/workspaces/${ws.admin}/archive`,
        ),
      ).toEqual({
        status: 409,
        json: { code: 'admin_workspace', error: 'The Admin workspace cannot be archived.' },
      });
      // W is the landing app's home: refused with the count.
      expect(
        await call(`${mode} mod archive W`, L.mod, 'POST', `/api/workspaces/${ws.W}/archive`),
      ).toEqual({
        status: 409,
        json: {
          code: 'workspace_holds_items',
          error: '1 item(s) have their home in this workspace. Move them first.',
        },
      });
    });
  }
});
