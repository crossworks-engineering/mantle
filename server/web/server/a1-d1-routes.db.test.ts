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
 *    write of it is 404, and a create into Team is 403 workspace.
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
      (${outsider}, ${email('out')}, 'x', false, 'member', 'Otto Outsider')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
    const ws = await x<{ id: string; key: string | null }>(sql`
      select id::text as id, bridge_key as key from workspaces where owner_id = ${owner}`);
    team = ws.find((w) => w.key === 'team')!.id;
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

  it('Recall: cards, revisions, a prompt confirm and a restore follow the map', async () => {
    const map = teamItem.recall!;
    const add = await call(`/api/recall/maps/${map}/cards`, mod, 'POST', {
      title: `${tag} card`,
      bodyMd: 'What the card says.',
      prompt: true,
      version: await versionOf(map),
    });
    expect(add.status, add.text.slice(0, 200)).toBe(201);
    const slug = add.json.cardSlug as string;
    // The reader reads the card and the log, and changes nothing.
    expect((await call(`/api/recall/maps/${map}/cards/${slug}`, reader)).status).toBe(200);
    const log = await call(`/api/recall/maps/${map}/revisions`, reader);
    expect(log.status).toBe(200);
    const put = await call(`/api/recall/maps/${map}/cards/${slug}`, reader, 'PUT', {
      title: `${tag} card`,
      bodyMd: 'A reader edit.',
      version: await versionOf(map),
    });
    expect(put.status).toBe(403);
    const confirm = { confirm: true, version: await versionOf(map) };
    expect(
      (await call(`/api/recall/maps/${map}/cards/${slug}/prompt`, reader, 'POST', confirm)).status,
    ).toBe(403);
    // The outsider: 404 on every one.
    expect((await call(`/api/recall/maps/${map}/cards/${slug}`, outsider)).status).toBe(404);
    expect((await call(`/api/recall/maps/${map}/revisions`, outsider)).status).toBe(404);
    expect(
      (await call(`/api/recall/maps/${map}/cards/${slug}/prompt`, outsider, 'POST', confirm))
        .status,
    ).toBe(404);
    // The Moderator confirms the prompt (it may edit the map, as on MCP).
    const ok = await call(`/api/recall/maps/${map}/cards/${slug}/prompt`, mod, 'POST', confirm);
    expect(ok.status, ok.text.slice(0, 200)).toBe(200);
    const revs = (await call(`/api/recall/maps/${map}/revisions`, mod)).json.revisions as
      Json[] | undefined;
    const revId = (revs ?? [])[0]?.id as string | undefined;
    expect(revId).toBeTruthy();
    expect(
      (await call(`/api/recall/revisions/${revId}/restore`, outsider, 'POST', {})).status,
    ).toBe(404);
    expect((await call(`/api/recall/revisions/${revId}/restore`, reader, 'POST', {})).status).toBe(
      403,
    );
  });

  it('the Team Moderator edits and deletes it', async () => {
    for (const k of KINDS) {
      const id = teamItem[k.name]!;
      const p = await patch(k, mod, id, `${tag} mod edit ${k.name}`);
      expect(p.status, `${k.name}: ${p.text.slice(0, 200)}`).toBe(200);
      expect((await row(id))?.title, k.name).toBe(`${tag} mod edit ${k.name}`);
      const d = await call(`${k.prefix}/${id}`, mod, 'DELETE');
      expect(d.status, `${k.name}: ${d.text.slice(0, 200)}`).toBe(200);
      expect(await row(id), k.name).toBeUndefined();
    }
  });
});
