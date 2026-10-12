/**
 * Workspaces arch A1, owner decision D1: tasks, events, formulas and Recall
 * maps are workspace kinds on HTTP too. Through the real app (createApp) on a
 * migrated scratch database, with signed session cookies, three logins:
 *
 *  - a Team Moderator creates each kind in Team (?ws=), edits and deletes it;
 *  - a Team reader (in Team, no Moderator tick) lists and opens it, is
 *    refused an edit or a delete (403 item-workspace, the row unchanged), and
 *    creates its own in its private workspace (never Team: it only reads it);
 *  - an outsider (not in Team) neither lists nor opens it: every read and
 *    write of it is 404, and a create into Team is 403 workspace;
 *  - a Write-grant user (a grant with Write on, no Moderator) edits it but
 *    may not delete it (delete needs a Moderator of the home).
 *
 * Recall (fix round, H1): the owner's acts on a map (publish, prompt
 * confirm, revision restore, reorder, delete) stay with the Admin users, as
 * on MCP, where those tools are owner-only. A login outside Admin writes as
 * an editor: its map starts as a draft, its edit of a confirmed prompt waits
 * for an Admin user, and the revision log names it, never 'owner'. A target
 * map outside its scope does not exist for it (L1). The lists take ?ws=
 * (L3). A reminder never carries a private event to the owner (M1).
 *
 * The handler reads in the login's scope (a handler read-through): an item
 * homed in Admin is in no member's list and answers 404, so no handler reads
 * item content with the owner's rights. Recall adds its cards, revisions,
 * prompt confirm and revision restore; formulas their calculator.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/a1-d1-routes.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Json = Record<string, unknown>;

/** One D1 kind as its routes speak it. */
type Kind = {
  name: 'task' | 'event' | 'formula' | 'recall';
  prefix: string;
  listKey: string;
  create: (title: string) => Json;
  idOf: (body: Json) => string;
  patch: (title: string, version: number) => Json;
};

describe.skipIf(!URL)('A1 D1: tasks, events, formulas and Recall maps on HTTP', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let app: import('hono').Hono;
  let cookieOf: (id: string) => string;
  let dir = '';
  const owner = randomUUID(); // the anchor, an Admin user
  const mod = randomUUID(); // a member: Moderator of Team
  const reader = randomUUID(); // a member: in Team, no Moderator tick
  const outsider = randomUUID(); // a member: not in Team (its own Side)
  const writer = randomUUID(); // a member: in WG, which holds Write grants
  const admin2 = randomUUID(); // an Admin user who is not the brain owner
  const exAdmin = randomUUID(); // an admin-role login taken out of Admin
  let wg = '';
  let adminWs = '';
  let adminMapSlug = '';
  const tag = `a1d1${randomUUID().slice(0, 6)}`;
  let team = '';
  let formulaSpec: Json = {};
  let formulaExample: { target: string; inputs: Json; expected: number } = {
    target: '',
    inputs: {},
    expected: 0,
  };
  const teamItem: Record<string, string> = {};
  const adminItem: Record<string, string> = {};
  const readerOwn: Record<string, string> = {};

  const KINDS: Kind[] = [
    {
      name: 'task',
      prefix: '/api/tasks',
      listKey: 'tasks',
      create: (title) => ({ title }),
      idOf: (b) => (b.task as Json).id as string,
      patch: (title) => ({ title }),
    },
    {
      name: 'event',
      prefix: '/api/events',
      listKey: 'events',
      create: (title) => ({
        title,
        startsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      }),
      idOf: (b) => (b.event as Json).id as string,
      patch: (title) => ({ title }),
    },
    {
      name: 'formula',
      prefix: '/api/formulas',
      listKey: 'formulas',
      create: (title) => ({ title, spec: { ...formulaSpec, id: `${title.replace(/\W+/g, '-')}` } }),
      idOf: (b) => b.id as string,
      patch: (title) => ({ title }),
    },
    {
      name: 'recall',
      prefix: '/api/recall/maps',
      listKey: 'maps',
      create: (title) => ({ title, enterWhen: `${title}: when to open this map` }),
      idOf: (b) => b.mapId as string,
      patch: (title, version) => ({ title, version }),
    },
  ];

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
  const row = async (id: string) =>
    (
      await x<{ title: string; home: string | null }>(
        sql`select title, home_ws::text as home from nodes where id = ${id}`,
      )
    )[0];
  const privateOf = async (login: string) =>
    (
      await x<{ ws: string }>(
        sql`select workspace_id::text as ws from private_workspaces where login_id = ${login}`,
      )
    )[0]?.ws;
  const versionOf = async (mapId: string) =>
    (await x<{ v: number }>(sql`select version as v from recall_maps where id = ${mapId}`))[0]!.v;
  const listIds = (r: { json: Json }, key: string) =>
    ((r.json[key] as Json[] | undefined) ?? []).map((i) => i.id as string);
  const create = async (k: Kind, as: string, title: string, ws?: string) => {
    const r = await call(`${k.prefix}${ws ? `?ws=${ws}` : ''}`, as, 'POST', k.create(title));
    return { ...r, id: r.status < 300 ? k.idOf(r.json) : '' };
  };
  const patch = async (k: Kind, as: string, id: string, title: string) =>
    call(
      `${k.prefix}/${id}`,
      as,
      'PATCH',
      k.patch(title, k.name === 'recall' ? await versionOf(id) : 0),
    );

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'a1-d1-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'a1-d1-routes-secret-at-least-32-chars!!';
    delete process.env.MANTLE_DETACHED_DEV;
    delete process.env.MANTLE_ADMIN_READS;
    m = await import('@mantle/db');
    const seed = (await import('@mantle/content-core/formula-seed')).FORMULA_SEED[0]!;
    formulaSpec = seed.spec as Json;
    formulaExample = seed.examples[0]! as typeof formulaExample;
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${email('owner')}, 'x', true, 'admin', 'Olive Owner'),
      (${mod}, ${email('mod')}, 'x', false, 'member', 'Mo Moderator'),
      (${reader}, ${email('reader')}, 'x', false, 'member', 'Rae Reader'),
      (${outsider}, ${email('out')}, 'x', false, 'member', 'Otto Outsider'),
      (${writer}, ${email('writer')}, 'x', false, 'member', 'Wren Writer'),
      (${admin2}, ${email('admin2')}, 'x', false, 'admin', 'Ada Admin'),
      (${exAdmin}, ${email('exadmin')}, 'x', false, 'admin', 'Ex Admin')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
    const ws = await x<{ id: string; key: string | null }>(sql`
      select id::text as id, bridge_key as key from workspaces where owner_id = ${owner}`);
    team = ws.find((w) => w.key === 'team')!.id;
    adminWs = ws.find((w) => w.key === 'admin')!.id;
    const tokens = await import('../lib/auth/tokens');
    cookieOf = (id) => `mantle_session=${tokens.buildSessionCookie(id).value}`;
    const { createApp } = await import('./app');
    app = await createApp();
    // The outsider makes its own workspace, then leaves Team; the reader
    // stays in Team without the Moderator tick.
    const side = await call('/api/workspaces', outsider, 'POST', { name: 'Side' });
    expect(side.status, side.text.slice(0, 200)).toBeLessThan(300);
    await x(
      sql`delete from workspace_users where workspace_id = ${team} and login_id = ${outsider}`,
    );
    // Both admin-role logins moderate Team; only Ada stays in Admin.
    for (const id of [admin2, exAdmin]) {
      await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
                  values (${team}, ${id}, true)
                  on conflict (workspace_id, login_id) do update set moderator = true`);
    }
    await x(
      sql`delete from workspace_users where workspace_id = ${adminWs} and login_id = ${exAdmin}`,
    );
    expect(
      (
        await x(sql`select 1 from workspace_users where workspace_id = ${adminWs}
                     and login_id = ${admin2}`)
      ).length,
      'Ada sits in Admin',
    ).toBe(1);
    // The writer is in WG only, without the Moderator tick.
    wg = (
      await x<{ id: string }>(sql`insert into workspaces (owner_id, name)
        values (${owner}, ${`${tag} WG`}) returning id::text as id`)
    )[0]!.id;
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
                values (${wg}, ${writer}, false)`);
    await x(sql`delete from workspace_users where workspace_id = ${team} and login_id = ${writer}`);
    await x(sql`update workspace_users set moderator = false
                where workspace_id = ${team} and login_id = ${reader}`);
    const inTeam = await x<{ login: string; mod: boolean }>(sql`
      select login_id::text as login, moderator as mod from workspace_users
       where workspace_id = ${team} and login_id in (${mod}, ${reader}, ${outsider})`);
    expect(inTeam.find((u) => u.login === mod)?.mod).toBe(true);
    expect(inTeam.find((u) => u.login === reader)?.mod).toBe(false);
    expect(inTeam.some((u) => u.login === outsider)).toBe(false);
    // One item of each kind homed in Admin, made by the owner (no ?ws=: an
    // Admin user's create lands in Admin).
    for (const k of KINDS) {
      const r = await create(k, owner, `${tag} admin ${k.name}`);
      expect(r.status, `${k.name}: ${r.text.slice(0, 200)}`).toBeLessThan(300);
      adminItem[k.name] = r.id;
      if (k.name === 'recall') {
        // An Admin user's map is published at once.
        expect(r.json.published).toBe(true);
        adminMapSlug = r.json.slug as string;
      }
    }
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('a Team Moderator creates each kind in Team (?ws=)', async () => {
    for (const k of KINDS) {
      const r = await create(k, mod, `${tag} team ${k.name}`, team);
      expect(r.status, `${k.name}: ${r.text.slice(0, 200)}`).toBe(201);
      teamItem[k.name] = r.id;
      expect((await row(r.id))?.home, k.name).toBe(team);
      // A map made by a login outside Admin starts as a draft (H1), as
      // recall_map_create makes it on MCP.
      if (k.name === 'recall') {
        expect(r.json.published).toBe(false);
        const [m0] = await x<{ p: boolean }>(
          sql`select published as p from recall_maps where id = ${r.id}`,
        );
        expect(m0!.p).toBe(false);
      }
      // The Write grant to WG (M2).
      await m.withHeads([r.id], 'update', async (tx) => {
        await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home, write)
                             values (${r.id}, ${wg}, false, true)`);
      });
    }
  });

  it('a Team reader lists and opens it, never the Admin item', async () => {
    for (const k of KINDS) {
      const list = await call(k.prefix, reader);
      expect(list.status, `${k.name}: ${list.text.slice(0, 200)}`).toBe(200);
      const ids = listIds(list, k.listKey);
      expect(ids, k.name).toContain(teamItem[k.name]);
      expect(ids, k.name).not.toContain(adminItem[k.name]);
      expect((await call(`${k.prefix}/${teamItem[k.name]}`, reader)).status, k.name).toBe(200);
      expect((await call(`${k.prefix}/${adminItem[k.name]}`, reader)).status, k.name).toBe(404);
    }
  });

  it('a Team reader may not edit or delete it (403, the row unchanged)', async () => {
    for (const k of KINDS) {
      const id = teamItem[k.name]!;
      const before = await row(id);
      const p = await patch(k, reader, id, `${tag} reader edit`);
      expect(p.status, `${k.name}: ${p.text.slice(0, 200)}`).toBe(403);
      expect(p.json.reason, k.name).toBe('item-workspace');
      const d = await call(`${k.prefix}/${id}`, reader, 'DELETE');
      expect(d.status, k.name).toBe(403);
      expect(await row(id), k.name).toEqual(before);
    }
  });

  it("a Team reader's create lands in its private workspace, also with ?ws=Team", async () => {
    for (const k of KINDS) {
      for (const ws of [undefined, team]) {
        const r = await create(k, reader, `${tag} reader ${k.name} ${ws ? 'ws' : 'plain'}`, ws);
        expect(r.status, `${k.name}: ${r.text.slice(0, 200)}`).toBe(201);
        const priv = await privateOf(reader);
        expect(priv, k.name).toBeTruthy();
        expect((await row(r.id))?.home, k.name).toBe(priv);
        readerOwn[k.name] = r.id;
        // Its own: it edits it.
        const p = await patch(k, reader, r.id, `${tag} reader own ${k.name}`);
        expect(p.status, `${k.name}: ${p.text.slice(0, 200)}`).toBe(200);
      }
    }
  });

  it('an outsider neither sees nor touches it: 404 everywhere, the row unchanged', async () => {
    for (const k of KINDS) {
      const id = teamItem[k.name]!;
      const before = await row(id);
      const list = await call(k.prefix, outsider);
      expect(list.status, k.name).toBe(200);
      expect(listIds(list, k.listKey), k.name).not.toContain(id);
      expect((await call(`${k.prefix}/${id}`, outsider)).status, k.name).toBe(404);
      expect((await patch(k, outsider, id, `${tag} outsider`)).status, k.name).toBe(404);
      expect((await call(`${k.prefix}/${id}`, outsider, 'DELETE')).status, k.name).toBe(404);
      expect(await row(id), k.name).toEqual(before);
      const into = await create(k, outsider, `${tag} outsider into team`, team);
      expect(into.status, k.name).toBe(403);
      expect(into.json.reason, k.name).toBe('workspace');
    }
  });

  it('a Write-grant user edits it but may not delete it (M2)', async () => {
    for (const k of KINDS) {
      const id = teamItem[k.name]!;
      expect((await call(`${k.prefix}/${id}`, writer)).status, k.name).toBe(200);
      const p = await patch(k, writer, id, `${tag} writer edit ${k.name}`);
      expect(p.status, `${k.name}: ${p.text.slice(0, 200)}`).toBe(200);
      expect((await row(id))?.title, k.name).toBe(`${tag} writer edit ${k.name}`);
      const before = await row(id);
      const d = await call(`${k.prefix}/${id}`, writer, 'DELETE');
      expect(d.status, `${k.name}: ${d.text.slice(0, 200)}`).toBe(403);
      expect(await row(id), k.name).toEqual(before);
    }
  });

  it('the lists take ?ws= (L3): what that workspace reads, echoed; one not seen is 404', async () => {
    const priv = await privateOf(reader);
    for (const k of KINDS) {
      const inTeam = await call(`${k.prefix}?ws=${team}`, reader);
      expect(inTeam.status, `${k.name}: ${inTeam.text.slice(0, 200)}`).toBe(200);
      expect(inTeam.json.ws, k.name).toBe(team);
      const ids = listIds(inTeam, k.listKey);
      expect(ids, k.name).toContain(teamItem[k.name]);
      expect(ids, k.name).not.toContain(readerOwn[k.name]);
      const own = await call(`${k.prefix}?ws=${priv}`, reader);
      expect(own.status, k.name).toBe(200);
      expect(listIds(own, k.listKey), k.name).toContain(readerOwn[k.name]);
      expect(listIds(own, k.listKey), k.name).not.toContain(teamItem[k.name]);
      expect((await call(`${k.prefix}?ws=${adminWs}`, reader)).status, k.name).toBe(404);
    }
  });

  it("a reminder never carries a user's private event to the owner (M1)", async () => {
    const { listDueReminders } = await import('@mantle/content');
    const past = new Date(Date.now() - 60_000).toISOString();
    for (const id of [adminItem.event!, readerOwn.event!]) {
      await x(sql`update nodes set data = data || ${JSON.stringify({ remind_at: past })}::jsonb
                  where id = ${id}`);
    }
    const due = (await listDueReminders(owner, 50)).map((e) => e.id);
    expect(due).toContain(adminItem.event);
    expect(due).not.toContain(readerOwn.event);
    // An owner with no live workspace (here: disabled) reads nothing, never
    // everything (re-audit, M1 fails open).
    await x(sql`update auth.users set disabled_at = now() where id = ${owner}`);
    try {
      expect(await listDueReminders(owner, 50)).toEqual([]);
    } finally {
      await x(sql`update auth.users set disabled_at = null where id = ${owner}`);
    }
  });

  it('formulas: the calculator reads in the scope', async () => {
    const id = teamItem.formula!;
    const body = { target: formulaExample.target, inputs: formulaExample.inputs };
    const r = await call(`/api/formulas/${id}/evaluate`, reader, 'POST', body);
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect((await call(`/api/formulas/${id}/evaluate`, outsider, 'POST', body)).status).toBe(404);
    expect(
      (await call(`/api/formulas/${adminItem.formula}/evaluate`, reader, 'POST', body)).status,
    ).toBe(404);
    // The seed stays Admin's.
    expect((await call('/api/formulas/seed', mod, 'POST', {})).status).toBe(403);
  });

  it("Recall: cards follow the map; the owner's acts stay with Admin users (H1, L1)", async () => {
    const map = teamItem.recall!;
    const card = (body: string, prompt?: boolean) => ({
      title: `${tag} card`,
      bodyMd: body,
      useWhen: 'When the test asks for the A1 card.',
      ...(prompt === undefined ? {} : { prompt }),
    });
    // A Team Moderator outside Admin asks for a prompt: it is only a request.
    const add = await call(`/api/recall/maps/${map}/cards`, mod, 'POST', {
      ...card('What the card says.', true),
      version: await versionOf(map),
    });
    expect(add.status, add.text.slice(0, 200)).toBe(201);
    const slug = add.json.cardSlug as string;
    const cardRow = async () =>
      (
        await x<{ kind: string; pending: boolean }>(sql`
          select kind, prompt_pending as pending from recall_nodes
           where map_id = ${map} and slug = ${slug}`)
      )[0];
    expect(await cardRow()).toEqual({ kind: 'knowledge', pending: true });
    // The reader reads the card and the log, and changes nothing.
    expect((await call(`/api/recall/maps/${map}/cards/${slug}`, reader)).status).toBe(200);
    expect((await call(`/api/recall/maps/${map}/revisions`, reader)).status).toBe(200);
    const put = await call(`/api/recall/maps/${map}/cards/${slug}`, reader, 'PUT', {
      ...card('A reader edit.'),
      version: await versionOf(map),
    });
    expect(put.status).toBe(403);
    const confirm = async () => ({ confirm: true, version: await versionOf(map) });
    const prompt = `/api/recall/maps/${map}/cards/${slug}/prompt`;
    expect((await call(prompt, reader, 'POST', await confirm())).status).toBe(403);
    // The outsider: 404 on every one.
    expect((await call(`/api/recall/maps/${map}/cards/${slug}`, outsider)).status).toBe(404);
    expect((await call(`/api/recall/maps/${map}/revisions`, outsider)).status).toBe(404);
    expect((await call(prompt, outsider, 'POST', await confirm())).status).toBe(404);
    // The Moderator outside Admin may not confirm, publish, reorder.
    const no = await call(prompt, mod, 'POST', await confirm());
    expect(no.status, no.text.slice(0, 200)).toBe(403);
    expect(no.json.code).toBe('confirm_is_owners');
    const pub = await call(`/api/recall/maps/${map}`, mod, 'PATCH', {
      published: true,
      version: await versionOf(map),
    });
    expect(pub.status, pub.text.slice(0, 200)).toBe(403);
    expect(pub.json.code).toBe('publish_is_owners');
    const ord = await call(`/api/recall/maps/${map}/cards/reorder`, mod, 'POST', {
      slugs: [slug],
      version: await versionOf(map),
    });
    expect(ord.status, ord.text.slice(0, 200)).toBe(403);
    expect(ord.json.code).toBe('reorder_is_owners');
    // An Admin user (the owner, a Moderator of Team) confirms it.
    const ok = await call(prompt, owner, 'POST', await confirm());
    expect(ok.status, ok.text.slice(0, 200)).toBe(200);
    expect(await cardRow()).toEqual({ kind: 'prompt', pending: false });
    // The Moderator's edit of the confirmed prompt waits for re-confirm.
    const edit = await call(`/api/recall/maps/${map}/cards/${slug}`, mod, 'PUT', {
      ...card('The Moderator rewrote it.'),
      version: await versionOf(map),
    });
    expect(edit.status, edit.text.slice(0, 200)).toBe(200);
    expect((edit.json.warnings as Json[]).map((w) => w.code)).toContain('prompt_needs_confirm');
    expect(await cardRow()).toEqual({ kind: 'knowledge', pending: true });
    // The log names the real login for the Moderator's writes, never 'owner'.
    const mine = await x<{ kind: string; name: string | null }>(sql`
      select actor_kind as kind, actor_name as name from recall_revisions
       where map_id = ${map} and actor_id = ${mod}`);
    expect(mine.length).toBeGreaterThan(0);
    expect(new Set(mine.map((r) => r.kind))).toEqual(new Set(['agent']));
    expect(new Set(mine.map((r) => r.name))).toEqual(new Set(['Mo Moderator']));
    // A restore: 404 outside, 403 to the reader (the gate) and the Moderator.
    const revs = (await call(`/api/recall/maps/${map}/revisions`, mod)).json.revisions as
      Json[] | undefined;
    const revId = (revs ?? [])[0]?.id as string | undefined;
    expect(revId).toBeTruthy();
    const restore = `/api/recall/revisions/${revId}/restore`;
    expect((await call(restore, outsider, 'POST', {})).status).toBe(404);
    expect((await call(restore, reader, 'POST', {})).status).toBe(403);
    const r3 = await call(restore, mod, 'POST', {});
    expect(r3.status, r3.text.slice(0, 200)).toBe(403);
    expect(r3.json.code).toBe('restore_is_owners');

    // L1: a map outside the scope does not exist for it. The Admin map is
    // published, so the owner may point an option at it; the Moderator, who
    // does not read it, hears what a missing map answers.
    const option = (targetMap: string) => ({
      title: `${tag} cross ${targetMap}`,
      bodyMd: 'Leads to another map.',
      options: [{ label: 'Go', useWhen: 'When it applies.', targetSlug: 'x', targetMap }],
      version: 0,
    });
    const missing = await call(`/api/recall/maps/${map}/cards`, mod, 'POST', {
      ...option(`${tag}-no-such-map`),
      version: await versionOf(map),
    });
    const hidden = await call(`/api/recall/maps/${map}/cards`, mod, 'POST', {
      ...option(adminMapSlug),
      version: await versionOf(map),
    });
    expect(hidden.status, hidden.text.slice(0, 200)).toBe(missing.status);
    expect(hidden.json.code).toBe('cross_map_not_found');
    expect(missing.json.code).toBe('cross_map_not_found');
    const byOwner = await call(`/api/recall/maps/${map}/cards`, owner, 'POST', {
      ...option(adminMapSlug),
      version: await versionOf(map),
    });
    expect(byOwner.status, byOwner.text.slice(0, 200)).toBe(201);
    const gone = (r: { json: Json }) =>
      ((r.json.warnings as Json[] | undefined) ?? []).filter(
        (w) => w.code === 'cross_map_target_gone',
      ).length;
    expect(gone(byOwner)).toBe(0);
    // The Moderator's next write reports the owner's option as gone: the
    // target is outside its scope, so it is not told it exists.
    const next = await call(`/api/recall/maps/${map}/cards`, mod, 'POST', {
      ...card('Another card.'),
      title: `${tag} another`,
      version: await versionOf(map),
    });
    expect(next.status, next.text.slice(0, 200)).toBe(201);
    expect(gone(next)).toBe(1);
  });

  it('an Admin user keeps the owner acts; an admin-role login out of Admin does not', async () => {
    const map = teamItem.recall!;
    const add = await call(`/api/recall/maps/${map}/cards`, exAdmin, 'POST', {
      title: `${tag} ex card`,
      bodyMd: 'Asked by a login out of Admin.',
      useWhen: 'When the test asks for the ex card.',
      prompt: true,
      version: await versionOf(map),
    });
    expect(add.status, add.text.slice(0, 200)).toBe(201);
    const slug = add.json.cardSlug as string;
    const cardRow = async () =>
      (
        await x<{ kind: string; pending: boolean }>(sql`
          select kind, prompt_pending as pending from recall_nodes
           where map_id = ${map} and slug = ${slug}`)
      )[0];
    // Out of Admin, it writes as an editor: a request, and refused the acts.
    expect(await cardRow()).toEqual({ kind: 'knowledge', pending: true });
    const prompt = `/api/recall/maps/${map}/cards/${slug}/prompt`;
    const no = await call(prompt, exAdmin, 'POST', {
      confirm: true,
      version: await versionOf(map),
    });
    expect(no.status, no.text.slice(0, 200)).toBe(403);
    expect(no.json.code).toBe('confirm_is_owners');
    const pubNo = await call(`/api/recall/maps/${map}`, exAdmin, 'PATCH', {
      published: true,
      version: await versionOf(map),
    });
    expect(pubNo.status, pubNo.text.slice(0, 200)).toBe(403);
    expect(pubNo.json.code).toBe('publish_is_owners');
    // An Admin user who is not the brain owner confirms and publishes.
    const ok = await call(prompt, admin2, 'POST', { confirm: true, version: await versionOf(map) });
    expect(ok.status, ok.text.slice(0, 200)).toBe(200);
    expect(await cardRow()).toEqual({ kind: 'prompt', pending: false });
    const pub = await call(`/api/recall/maps/${map}`, admin2, 'PATCH', {
      published: true,
      version: await versionOf(map),
    });
    expect(pub.status, pub.text.slice(0, 200)).toBe(200);
    const [m1] = await x<{ p: boolean }>(
      sql`select published as p from recall_maps where id = ${map}`,
    );
    expect(m1!.p).toBe(true);
    // The log: the editor as 'agent', the Admin user as 'owner', each by id.
    const log = await x<{ id: string; kind: string }>(sql`
      select actor_id::text as id, actor_kind as kind from recall_revisions
       where map_id = ${map} and actor_id in (${exAdmin}, ${admin2})`);
    expect(new Set(log.filter((r) => r.id === exAdmin).map((r) => r.kind))).toEqual(
      new Set(['agent']),
    );
    expect(new Set(log.filter((r) => r.id === admin2).map((r) => r.kind))).toEqual(
      new Set(['owner']),
    );
  });

  it('a map slug made outside Admin says nothing about maps the caller cannot read', async () => {
    const recall = KINDS.find((k) => k.name === 'recall')!;
    // adminMapSlug is held by a map in Admin the reader does not read.
    const hidden = await create(recall, reader, `${tag} admin recall`);
    expect(hidden.status, hidden.text.slice(0, 200)).toBe(201);
    const free = await create(recall, reader, `${tag} unheld title`);
    expect(free.status, free.text.slice(0, 200)).toBe(201);
    // The same shape either way: the base and a random suffix, never a count.
    expect(hidden.json.slug).toMatch(new RegExp(`^${adminMapSlug}-[0-9a-f]{6}$`));
    expect(free.json.slug).toMatch(new RegExp(`^${tag}-unheld-title-[0-9a-f]{6}$`));
    // An Admin user counts up, as before.
    const byOwner = await create(recall, owner, `${tag} admin recall`);
    expect(byOwner.json.slug).toBe(`${adminMapSlug}-2`);
  });

  it('the Team Moderator edits and deletes it; a map is deleted by an Admin user', async () => {
    for (const k of KINDS) {
      const id = teamItem[k.name]!;
      const p = await patch(k, mod, id, `${tag} mod edit ${k.name}`);
      expect(p.status, `${k.name}: ${p.text.slice(0, 200)}`).toBe(200);
      expect((await row(id))?.title, k.name).toBe(`${tag} mod edit ${k.name}`);
      const d = await call(`${k.prefix}/${id}`, mod, 'DELETE');
      if (k.name === 'recall') {
        // Deleting a map is the owner's act (H1).
        expect(d.status, d.text.slice(0, 200)).toBe(403);
        expect(d.json.code).toBe('delete_is_owners');
        const o = await call(`${k.prefix}/${id}`, owner, 'DELETE');
        expect(o.status, o.text.slice(0, 200)).toBe(200);
      } else {
        expect(d.status, `${k.name}: ${d.text.slice(0, 200)}`).toBe(200);
      }
      expect(await row(id), k.name).toBeUndefined();
    }
  });
});
