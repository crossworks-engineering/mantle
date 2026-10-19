/**
 * Workspaces W6b: a member creates and edits its own items through the
 * owner routes (plan 15, 21.8 row 7), through the real app (createApp) on a
 * migrated scratch database, with signed session cookies:
 *
 *  - a create lands in the request's workspace (?ws=) when the login
 *    moderates it, else in the folder it is made in when the login may edit
 *    that, else in the login's private workspace (made on its first
 *    create), never Admin;
 *  - a workspace the login is not in is refused (403 workspace), a folder
 *    it may not edit too (403);
 *  - the member edits and deletes its own items (drafts included: it reads
 *    its own page's draft), not an item it only reads (403 item-workspace);
 *  - an Admin user's create without ?ws= lands as before (Admin); with
 *    ?ws=Team in Team;
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/w6b-member-writes.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Json = Record<string, unknown>;

describe.skipIf(!URL)('W6b: members write through the owner routes', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let app: import('hono').Hono;
  let cookieOf: (id: string) => string;
  let dir = '';
  const owner = randomUUID(); // the anchor, an Admin user
  const mem = randomUUID(); // a member: Moderator of Team (Q1), reads Ro
  const mem2 = randomUUID(); // a member: makes Side and Ro
  const tag = `w6b${randomUUID().slice(0, 6)}`;
  let team = '';
  let adminWs = '';
  let side = '';
  let ro = '';
  const adminNote = randomUUID();
  const roNote = randomUUID();
  const teamFolder = randomUUID();
  const adminFolder = randomUUID();

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  /** A fixture write to the four workspace tables, as the superuser: the
   *  system pool only reads them under test:runtime-role. */
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);
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
  const homeOf = async (id: string) =>
    (
      await x<{ home: string | null; r: string[] }>(
        sql`select home_ws::text as home, read_ws::text[] as r from nodes where id = ${id}`,
      )
    )[0];
  const privateOf = async (login: string) =>
    (
      await x<{ ws: string }>(
        sql`select workspace_id::text as ws from private_workspaces where login_id = ${login}`,
      )
    )[0]?.ws;
  const idOf = (r: { json: Json }, key: string) =>
    ((r.json[key] as Json | undefined)?.id ?? r.json.id) as string;

  let suiteMode: string | undefined;

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'w6b-writes-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'w6b-member-writes-secret-at-least-32-chars!';
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
    const tokens = await import('../lib/auth/tokens');
    cookieOf = (id) => `mantle_session=${tokens.buildSessionCookie(id).value}`;
    const { createApp } = await import('./app');
    app = await createApp();
    side = (await call('/api/workspaces', mem2, 'POST', { name: 'Side' })).json.id as string;
    ro = (await call('/api/workspaces', mem2, 'POST', { name: 'Ro' })).json.id as string;
    expect(side && ro).toBeTruthy();
    // The member reads Ro (no Moderator, no Write).
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
                values (${ro}, ${mem}, false)`);
    // Items and folders made on the system pool (homed in Admin by the
    // trigger), then rehomed.
    await x(sql`insert into nodes (id, owner_id, type, title, path) values
      (${adminNote}, ${owner}, 'note', ${`${tag} admin note`}, 'notes'),
      (${roNote}, ${owner}, 'note', ${`${tag} ro note`}, 'notes'),
      (${teamFolder}, ${owner}, 'branch', ${`${tag} team folder`}, ${`pages.${tag}t`}::ltree),
      (${adminFolder}, ${owner}, 'branch', ${`${tag} admin folder`}, ${`pages.${tag}a`}::ltree)`);
    await homeIn(roNote, ro);
    await homeIn(teamFolder, team);
    // Both checks on, as every box since the pre-check removal part 2
    // (docs/actors.md, "Pre-check removal Part 2 (HTTP)"): a note's item
    // gate is gone, so a reader's edit is the database's to refuse (this
    // process's actor check on: the login's write on the write role; the
    // scratch database's edit check on).
    suiteMode = process.env.MANTLE_ACTOR_CHECK;
    process.env.MANTLE_ACTOR_CHECK = 'on';
    await (
      await import('@mantle/db/test-support')
    ).superuserExec(scratch!.url, "select mantle_set_edit_check('on')");
  }, 240_000);

  afterAll(async () => {
    if (suiteMode === undefined) delete process.env.MANTLE_ACTOR_CHECK;
    else process.env.MANTLE_ACTOR_CHECK = suiteMode;
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('a create with no workspace named lands in the private workspace, made on the first one', async () => {
    expect(await privateOf(mem)).toBeUndefined();
    const r = await call('/api/notes', mem, 'POST', { title: `${tag} my note` });
    expect(r.status, r.text.slice(0, 200)).toBeLessThan(300);
    const id = idOf(r, 'note');
    const priv = await privateOf(mem);
    expect(priv).toBeTruthy();
    expect(await homeOf(id)).toEqual({ home: priv, r: [priv] });
    // Its only user, a Moderator.
    const users = await x<{ login: string; mod: boolean }>(sql`
      select login_id::text as login, moderator as mod from workspace_users where workspace_id = ${priv}`);
    expect(users).toEqual([{ login: mem, mod: true }]);
    // A page too, and a second create reuses the same workspace.
    const p = await call('/api/pages', mem, 'POST', { title: `${tag} my page` });
    expect(p.status, p.text.slice(0, 200)).toBeLessThan(300);
    expect((await homeOf(idOf(p, 'page')))!.home).toBe(priv);
    expect(
      Number(
        (
          await x<{ n: number }>(
            sql`select count(*)::int as n from private_workspaces where login_id = ${mem}`,
          )
        )[0]!.n,
      ),
    ).toBe(1);
  });

  it('?ws= of a workspace it moderates (Team) lands there; one it only reads falls back to private', async () => {
    const t = await call(`/api/notes?ws=${team}`, mem, 'POST', { title: `${tag} team note` });
    expect(t.status, t.text.slice(0, 200)).toBeLessThan(300);
    expect((await homeOf(idOf(t, 'note')))!.home).toBe(team);
    const r = await call(`/api/notes?ws=${ro}`, mem, 'POST', { title: `${tag} ro try` });
    expect(r.status, r.text.slice(0, 200)).toBeLessThan(300);
    expect((await homeOf(idOf(r, 'note')))!.home).toBe(await privateOf(mem));
  });

  it('cannot create in a workspace it is not in', async () => {
    for (const ws of [side, adminWs]) {
      const r = await call(`/api/notes?ws=${ws}`, mem, 'POST', { title: `${tag} no` });
      expect(r.status).toBe(403);
      expect(r.json.reason).toBe('workspace');
    }
    expect(
      (await call(`/api/notes?ws=not-a-uuid`, mem, 'POST', { title: `${tag} no` })).status,
    ).toBe(400);
  });

  it('a create in a folder it may edit takes the folder home; a folder it may not is refused', async () => {
    // A shared folder: its grants pass on, so the create confirms it.
    const r = await call('/api/pages', mem, 'POST', {
      title: `${tag} in team`,
      folderId: teamFolder,
      confirm: true,
    });
    expect(r.status, r.text.slice(0, 200)).toBeLessThan(300);
    const id = idOf(r, 'page');
    expect((await homeOf(id))!.home).toBe(team);
    const no = await call('/api/pages', mem, 'POST', {
      title: `${tag} in admin`,
      folderId: adminFolder,
      confirm: true,
    });
    expect(no.status, no.text.slice(0, 200)).toBeGreaterThanOrEqual(400);
    expect(no.status).toBeLessThan(500);
    expect(
      Number(
        (
          await x<{ n: number }>(
            sql`select count(*)::int as n from nodes where title = ${`${tag} in admin`}`,
          )
        )[0]!.n,
      ),
    ).toBe(0);
  });

  it('edits and deletes its own items, drafts included; not an item it only reads', async () => {
    const made = await call('/api/pages', mem, 'POST', { title: `${tag} editable` });
    const id = idOf(made, 'page');
    const patched = await call(`/api/pages/${id}`, mem, 'PATCH', { title: `${tag} edited` });
    expect(patched.status, patched.text.slice(0, 200)).toBe(200);
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: `${tag} draftword` }] }],
    };
    const draft = await call(`/api/pages/${id}/draft`, mem, 'PUT', { doc });
    expect(draft.status, draft.text.slice(0, 200)).toBeLessThan(300);
    // Its own draft reads back (an editor reads drafts).
    expect((await call(`/api/pages/${id}`, mem)).text).toContain(`${tag} draftword`);
    // Another member reads nothing of it (its private workspace).
    expect((await call(`/api/pages/${id}`, mem2)).status).toBe(404);
    // An item it only reads (Ro): refused, it knows the item.
    const ro = await call(`/api/notes/${roNote}`, mem, 'PATCH', { title: 'x' });
    expect(ro.status, ro.text.slice(0, 200)).toBe(403);
    expect(ro.json.reason).toBe('item-workspace');
    expect((await call(`/api/notes/${roNote}`, mem, 'DELETE')).status).toBe(403);
    // An item it cannot see (Admin) answers exactly as an id no row has:
    // not found, never "exists but no" (docs/workspaces.md; audit 2026-10-12).
    const missing = randomUUID();
    for (const method of ['PATCH', 'DELETE'] as const) {
      const hidden = await call(`/api/notes/${adminNote}`, mem, method, { title: 'x' });
      const none = await call(`/api/notes/${missing}`, mem, method, { title: 'x' });
      expect(hidden.status, `${method} ${hidden.text.slice(0, 200)}`).toBe(404);
      expect(none.status, `${method} ${none.text.slice(0, 200)}`).toBe(404);
      expect(hidden.text.replaceAll(adminNote, '<id>')).toBe(none.text.replaceAll(missing, '<id>'));
    }
    const note = idOf(await call('/api/notes', mem, 'POST', { title: `${tag} gone` }), 'note');
    expect((await call(`/api/notes/${note}`, mem, 'DELETE')).status).toBe(200);
    expect(await homeOf(note)).toBeUndefined();
  });

  it('a route not opened to members still refuses them', async () => {
    const r = await call('/api/contacts', mem, 'POST', { name: 'x' });
    expect(r.status).toBe(403);
    expect(r.json.reason).toBe('member-login');
  });

  it('an Admin user creates in Admin by default, in Team with ?ws=Team', async () => {
    const a = await call('/api/notes', owner, 'POST', { title: `${tag} owner note` });
    expect(a.status, a.text.slice(0, 200)).toBeLessThan(300);
    expect((await homeOf(idOf(a, 'note')))!.home).toBe(adminWs);
    const t = await call(`/api/notes?ws=${team}`, owner, 'POST', { title: `${tag} owner team` });
    expect(t.status, t.text.slice(0, 200)).toBeLessThan(300);
    expect((await homeOf(idOf(t, 'note')))!.home).toBe(team);
    expect(await privateOf(owner)).toBeUndefined();
  });
});
