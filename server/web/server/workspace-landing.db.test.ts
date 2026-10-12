/**
 * Each workspace's landing page (task d78e7bde), on a migrated scratch
 * database through the real app (createApp), with signed session cookies:
 *
 *  - migration 0275 makes the old brain-wide member home app (the anchor's
 *    `teamHubAppId` preference) the Team workspace's home app;
 *  - PATCH /api/workspaces/:id `landingAppId`: a Moderator of that workspace
 *    only (no Admin area stands in), an app the workspace holds with a green
 *    published build only, `null` clears; the screen names it;
 *  - GET /api/home?ws=: every login's landing page, read in its scope and
 *    kept to what the named workspace reads (sections, counts, apps); a
 *    login only ever sees its own workspaces' data; a workspace it may not
 *    name is 404; an app the workspace lost is the Built-in home;
 *  - GET /api/member/home (older apps): the Team workspace's landing page.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/workspace-landing.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestOutcome } from '@mantle/db';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const seen = vi.hoisted(() => ({ last: null as unknown }));

vi.mock('@mantle/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@mantle/db')>();
  return {
    ...orig,
    runInRequestSlot: <T>(fn: () => T) =>
      orig.runInRequestSlot(async () => {
        try {
          return await fn();
        } finally {
          seen.last = orig.currentRequestOutcome();
        }
      }),
  };
});

type Json = Record<string, unknown>;
type Hub = {
  sections: Array<{ token: string }>;
  counts: Record<string, number>;
  apps: Array<{ token: string }>;
};

describe.skipIf(!URL)('workspace landing pages (task d78e7bde)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let app: import('hono').Hono;
  let cookieOf: (id: string) => string;
  let dir = '';
  const owner = randomUUID(); // the anchor, an Admin user
  const mem = randomUUID(); // a member in Team only
  const mem2 = randomUUID(); // a member in Team, and the Moderator of Side
  const mem3 = randomUUID(); // a user of Side only, not its Moderator
  const tag = `wl${randomUUID().slice(0, 6)}`;
  const teamPage = randomUUID();
  const sidePage = randomUUID();
  const adminPage = randomUUID();
  const teamApp = randomUUID();
  const teamApp2 = randomUUID();
  const sideApp = randomUUID();
  const draftApp = randomUUID();
  let team = '';
  let side = '';
  let adminWs = '';

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const email = (who: string) => `${tag}-${who}@example.invalid`;

  const call = async (
    url: string,
    as: string,
    method = 'GET',
    body?: unknown,
  ): Promise<{ status: number; text: string; json: Json; outcome: RequestOutcome | null }> => {
    seen.last = null;
    const res = await app.request(url, {
      method,
      headers: { 'content-type': 'application/json', cookie: cookieOf(as) },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    });
    const text = await res.text();
    let json: Json = {};
    try {
      json = JSON.parse(text) as Json;
    } catch {
      // not JSON
    }
    return { status: res.status, text, json, outcome: seen.last as RequestOutcome | null };
  };
  const home = async (as: string, ws?: string) => {
    const r = await call(ws ? `/api/home?ws=${ws}` : '/api/home', as);
    return r as typeof r & {
      json: { ws: string | null; homeApp: { appId: string } | null; hub: Hub };
    };
  };
  const tokens = (h: Hub) => h.sections.map((s) => s.token);
  const appTokens = (h: Hub) => h.apps.map((a) => a.token);
  const setLanding = (as: string, ws: string, landingAppId: string | null) =>
    call(`/api/workspaces/${ws}`, as, 'PATCH', { landingAppId });

  const homeIn = async (id: string, ws: string) => {
    await m.withHeads([id], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${id}`);
      // The delete re-derives an item in a folder: take that row over.
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
                           values (${id}, ${ws}, true)
                           on conflict (node_id, workspace_id)
                           do update set is_home = true, via_folder_id = null, excluded = false`);
    });
  };
  const alsoIn = async (id: string, ws: string) => {
    await m.withHeads([id], 'update', async (tx) => {
      await tx.execute(sql`insert into item_grants (node_id, workspace_id)
                           values (${id}, ${ws}) on conflict do nothing`);
    });
  };
  const outOf = async (id: string, ws: string) => {
    await m.withHeads([id], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${id} and workspace_id = ${ws}`);
    });
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'workspace-landing-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'workspace-landing-secret-at-least-32-characters';
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
    const ws = await x<{ id: string; key: string | null; is_admin: boolean }>(sql`
      select id::text as id, bridge_key as key, is_admin from workspaces where owner_id = ${owner}`);
    team = ws.find((w) => w.key === 'team')!.id;
    adminWs = ws.find((w) => w.is_admin)!.id;
    const tokensMod = await import('../lib/auth/tokens');
    cookieOf = (id) => `mantle_session=${tokensMod.buildSessionCookie(id).value}`;
    const { createApp } = await import('./app');
    app = await createApp();
    side = (await call('/api/workspaces', mem2, 'POST', { name: 'Side' })).json.id as string;
    expect(side).toBeTruthy();
    // A login made after the migration is in no workspace: Side's Moderator
    // adds it to Side, without the Moderator tick.
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
                values (${mem3}, ${email('mem3')}, 'x', false, 'member', 'Sam Side')`);
    const added = await call(`/api/workspaces/${side}/users`, mem2, 'POST', { loginId: mem3 });
    expect(added.status, added.text.slice(0, 200)).toBeLessThan(300);

    // Pages: one Team reads, one only Side reads, one only Admin reads.
    for (const [id, title] of [
      [teamPage, `${tag} team page`],
      [sidePage, `${tag} side page`],
      [adminPage, `${tag} admin page`],
    ] as const) {
      await x(sql`insert into nodes (id, owner_id, type, title, path)
                  values (${id}, ${owner}, 'page', ${title}, 'pages')`);
    }
    await homeIn(teamPage, team);
    await homeIn(sidePage, side);
    await homeIn(adminPage, adminWs);

    // Apps: two green ones Team holds, a green one Side holds, and one Team
    // holds with no published build.
    const green = JSON.stringify({ ok: true, storageKey: `apps/${tag}.js`, builtAt: '2026-10-12' });
    for (const [id, title, build] of [
      [teamApp, `${tag} Team home`, green],
      [teamApp2, `${tag} Team tool`, green],
      [sideApp, `${tag} Side home`, green],
      [draftApp, `${tag} Draft`, null],
    ] as const) {
      await x(sql`insert into nodes (id, owner_id, type, title, path)
                  values (${id}, ${owner}, 'app', ${title}, 'apps')`);
      await x(sql`insert into apps (node_id, manifest, published_build)
                  values (${id}, '{}'::jsonb, ${build}::jsonb)`);
    }
    await homeIn(teamApp, adminWs);
    await alsoIn(teamApp, team);
    await homeIn(teamApp2, adminWs);
    await alsoIn(teamApp2, team);
    await homeIn(sideApp, side);
    await homeIn(draftApp, adminWs);
    await alsoIn(draftApp, team);
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('0275 makes the old member home app the Team workspace home app', async () => {
    await x(sql`update workspaces set landing_app_id = null where owner_id = ${owner}`);
    await x(sql`insert into profiles (user_id, preferences)
                values (${owner}, ${JSON.stringify({ teamHubAppId: teamApp })}::jsonb)
                on conflict (user_id) do update
                set preferences = profiles.preferences || excluded.preferences`);
    const file = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../packages/db/migrations/0275_workspace_landing.sql',
    );
    const run = async () => {
      for (const stmt of readFileSync(file, 'utf8').split('--> statement-breakpoint')) {
        if (stmt.replace(/--.*$/gm, '').trim()) await x(sql.raw(stmt));
      }
    };
    await run();
    const rows = await x<{ id: string; landing: string | null }>(sql`
      select id::text as id, landing_app_id::text as landing from workspaces
       where owner_id = ${owner}`);
    expect(rows.find((r) => r.id === team)?.landing).toBe(teamApp);
    expect(rows.filter((r) => r.id !== team).every((r) => r.landing === null)).toBe(true);
    // Re-runnable: a second run changes nothing, and a set landing page is
    // never overwritten by the old preference.
    await x(sql`update workspaces set landing_app_id = ${teamApp2} where id = ${team}`);
    await run();
    const [after] = await x<{ landing: string }>(sql`
      select landing_app_id::text as landing from workspaces where id = ${team}`);
    expect(after?.landing).toBe(teamApp2);
    // A preference that names no app of the brain is not taken.
    await x(sql`update workspaces set landing_app_id = null where id = ${team}`);
    await x(
      sql`update profiles set preferences = preferences || ${JSON.stringify({
        teamHubAppId: teamPage,
      })}::jsonb where user_id = ${owner}`,
    );
    await run();
    const [none] = await x<{ landing: string | null }>(sql`
      select landing_app_id::text as landing from workspaces where id = ${team}`);
    expect(none?.landing).toBeNull();
    // Nor an app Team does not hold (audit M2): a later share would make
    // it the landing page by itself.
    await x(
      sql`update profiles set preferences = preferences || ${JSON.stringify({
        teamHubAppId: sideApp,
      })}::jsonb where user_id = ${owner}`,
    );
    await run();
    const [unheld] = await x<{ landing: string | null }>(sql`
      select landing_app_id::text as landing from workspaces where id = ${team}`);
    expect(unheld?.landing).toBeNull();
  });

  it('only a Moderator of the workspace sets its landing page, to an app it holds with a green build', async () => {
    // A user of Side who is not its Moderator: 403, nothing changes.
    const notMod = await setLanding(mem3, side, sideApp);
    expect(notMod.status).toBe(403);
    expect(notMod.json).toMatchObject({ code: 'forbidden' });
    // An Admin user with every area is no Moderator of Side: 403 (no Admin
    // area stands in for the Moderator tick).
    const adminOther = await setLanding(owner, side, sideApp);
    expect(adminOther.status).toBe(403);
    // Side is not the member's: 404, as every workspace route answers.
    expect((await setLanding(mem, side, sideApp)).status).toBe(404);
    const still = await x<{ landing: string | null }>(sql`
      select landing_app_id::text as landing from workspaces where id in (${team}, ${side})`);
    expect(still.map((r) => r.landing)).toEqual([null, null]);

    // The Moderator (an Admin user is one in Team): only an app Team holds,
    // with a green published build.
    const notHeld = await setLanding(owner, team, sideApp);
    expect(notHeld.status).toBe(409);
    expect(notHeld.json).toMatchObject({ code: 'landing_app_not_held' });
    expect(notHeld.text).not.toContain('Side home');
    const notReady = await setLanding(owner, team, draftApp);
    expect(notReady.status).toBe(409);
    expect(notReady.json).toMatchObject({ code: 'landing_app_not_ready' });
    expect((await setLanding(owner, team, 'not-a-uuid')).status).toBe(400);
    const ok = await setLanding(owner, team, teamApp);
    expect(ok.status, ok.text.slice(0, 200)).toBe(200);
    const detail = await call(`/api/workspaces/${team}`, mem);
    expect(detail.json.landingApp).toEqual({
      held: true,
      appId: teamApp,
      title: `${tag} Team home`,
      ready: true,
    });
    const events = await x<{ action: string }>(sql`
      select action from workspace_events where workspace_id = ${team} and action = 'workspace.landing'`);
    expect(events.length).toBe(1);

    // Side's Moderator (a member) sets Side's.
    expect((await setLanding(mem2, side, sideApp)).status).toBe(200);
    // null clears; set again for the reads below.
    expect((await setLanding(mem2, side, null)).status).toBe(200);
    expect((await call(`/api/workspaces/${side}`, mem2)).json.landingApp).toBeNull();
    expect((await setLanding(mem2, side, sideApp)).status).toBe(200);
    // An Admin user outside Side sees the screen, but not which app (audit L1).
    const outside = await call(`/api/workspaces/${side}`, owner);
    expect(outside.status).toBe(200);
    expect(outside.json.landingApp).toEqual({ held: true, appId: null, title: null, ready: true });
    expect(outside.text).not.toContain('Side home');
  });

  it("the landing page follows the workspace, in the login's scope, kept to that workspace", async () => {
    // Team for its member: Team's home app, Team's data only.
    const t = await home(mem, team);
    expect(t.status, t.text.slice(0, 200)).toBe(200);
    expect(t.outcome).toMatchObject({ kind: 'user', loginId: mem });
    expect(t.json.ws).toBe(team);
    expect(t.json.homeApp?.appId).toBe(teamApp);
    expect(tokens(t.json.hub)).toContain(teamPage);
    expect(tokens(t.json.hub)).not.toContain(sidePage);
    expect(tokens(t.json.hub)).not.toContain(adminPage);
    expect(t.json.hub.counts.page).toBe(1);
    // The other apps Team holds that the member may run, never the home app,
    // a draft or Side's.
    expect(appTokens(t.json.hub)).toEqual([teamApp2]);
    expect(t.text).not.toContain('Side home');

    // A workspace the member is not in: 404, nothing named.
    const other = await home(mem, side);
    expect(other.status).toBe(404);
    expect(other.text).not.toContain('Side');
    expect((await home(mem, 'not-a-uuid')).status).toBe(404);
    expect((await home(mem, randomUUID())).status).toBe(404);

    // All my workspaces: the Built-in home over the member's own workspaces.
    const all = await home(mem);
    expect(all.json).toMatchObject({ ws: null, homeApp: null });
    expect(tokens(all.json.hub)).toContain(teamPage);
    expect(tokens(all.json.hub)).not.toContain(sidePage);

    // A login in two workspaces: each landing page holds its own data.
    const s = await home(mem2, side);
    expect(s.json.homeApp?.appId).toBe(sideApp);
    expect(tokens(s.json.hub)).toEqual([sidePage]);
    expect(appTokens(s.json.hub)).toEqual([]);
    // A user of Side who is not its Moderator lands on the same page.
    const s3 = await home(mem3, side);
    expect(s3.json.homeApp?.appId).toBe(sideApp);
    expect(tokens(s3.json.hub)).toEqual([sidePage]);
    expect((await home(mem3, team)).status).toBe(404);
    const t2 = await home(mem2, team);
    expect(t2.json.homeApp?.appId).toBe(teamApp);
    expect(tokens(t2.json.hub)).not.toContain(sidePage);
    const all2 = await home(mem2);
    expect(tokens(all2.json.hub)).toEqual(expect.arrayContaining([teamPage, sidePage]));
    expect(all2.json.homeApp).toBeNull();

    // An Admin user lands on the Built-in home of the Admin workspace, with
    // what Admin reads, and never Side's data (it is not in Side).
    const a = await home(owner, adminWs);
    expect(a.status).toBe(200);
    expect(a.json.homeApp).toBeNull();
    expect(tokens(a.json.hub)).toContain(adminPage);
    expect(tokens(a.json.hub)).not.toContain(teamPage);
    expect(tokens((await home(owner)).json.hub)).not.toContain(sidePage);
  });

  const landingOf = async (ws: string) =>
    (
      await x<{ landing: string | null }>(sql`
        select landing_app_id::text as landing from workspaces where id = ${ws}`)
    )[0]?.landing ?? null;

  it('a workspace that stops holding its home app forgets it; a new share does not bring it back', async () => {
    expect(await landingOf(team)).toBe(teamApp);
    await outOf(teamApp, team);
    // Cleared at commit by the item_grants trigger (0275, audit M2).
    expect(await landingOf(team)).toBeNull();
    const t = await home(mem, team);
    expect(t.json.homeApp).toBeNull();
    expect(t.text).not.toContain('Team home');
    expect((await call(`/api/workspaces/${team}`, mem)).json.landingApp).toBeNull();
    expect((await call('/api/member/home', mem)).json).toEqual({ homeApp: null, hub: null });
    // Shared again: held, but no landing page until a Moderator picks it.
    await alsoIn(teamApp, team);
    expect(await landingOf(team)).toBeNull();
    expect((await home(mem, team)).json.homeApp).toBeNull();

    // A path that takes the grant away and gives it back in one transaction
    // keeps the landing page: the check runs at commit.
    expect((await setLanding(owner, team, teamApp)).status).toBe(200);
    await m.withHeads([teamApp], 'update', async (tx) => {
      await tx.execute(
        sql`delete from item_grants where node_id = ${teamApp} and workspace_id = ${team}`,
      );
      await tx.execute(sql`insert into item_grants (node_id, workspace_id)
                           values (${teamApp}, ${team})`);
    });
    expect(await landingOf(team)).toBe(teamApp);
  });

  it('a pointer left from before names nothing, and a Moderator clears it', async () => {
    // As a brain could hold it before 0275's trigger: Team points at an app
    // it does not hold.
    await x(sql`update workspaces set landing_app_id = ${sideApp} where id = ${team}`);
    try {
      const d = await call(`/api/workspaces/${team}`, mem);
      expect(d.json.landingApp).toEqual({ held: false, appId: null, title: null, ready: false });
      expect(d.text).not.toContain('Side home');
      expect((await home(mem, team)).json.homeApp).toBeNull();
      const cleared = await setLanding(owner, team, null);
      expect(cleared.status).toBe(200);
      expect(await landingOf(team)).toBeNull();
    } finally {
      await x(sql`update workspaces set landing_app_id = ${teamApp} where id = ${team}`);
    }
  });

  it('a home app whose build went red is the Built-in home, named on the screen as not ready', async () => {
    await x(
      sql`update apps set published_build = '{"ok":false}'::jsonb where node_id = ${teamApp}`,
    );
    try {
      expect((await home(mem, team)).json.homeApp).toBeNull();
      expect((await call(`/api/workspaces/${team}`, mem)).json.landingApp).toEqual({
        held: true,
        appId: teamApp,
        title: `${tag} Team home`,
        ready: false,
      });
    } finally {
      await x(
        sql`update apps set published_build = ${JSON.stringify({
          ok: true,
          storageKey: `apps/${tag}.js`,
        })}::jsonb where node_id = ${teamApp}`,
      );
    }
  });

  it("a folder's grant: removing it clears a folder-held home app; a hand row removed under it keeps it", async () => {
    // An app in a folder, both homed in Admin; Team gets a hand row on the
    // app first, then the folder's grant (audit L-b).
    const folder = randomUUID();
    const app = randomUUID();
    await x(sql`insert into nodes (id, owner_id, type, title, path)
                values (${folder}, ${owner}, 'branch', ${`${tag} landing folder`}, 'apps.lf')`);
    await x(sql`insert into nodes (id, owner_id, type, title, path)
                values (${app}, ${owner}, 'app', ${`${tag} Folder app`}, 'apps.lf')`);
    await x(sql`insert into apps (node_id, manifest, published_build)
                values (${app}, '{}'::jsonb, ${JSON.stringify({ ok: true, storageKey: 'x' })}::jsonb)`);
    await homeIn(folder, adminWs);
    await homeIn(app, adminWs);
    await alsoIn(app, team);
    const share = await call(`/api/grants/${folder}`, owner, 'POST', { wsId: team, confirm: true });
    expect(share.status, share.text.slice(0, 200)).toBe(200);
    expect((await setLanding(owner, team, app)).status).toBe(200);
    try {
      // The app's own row goes while the folder still grants: the folder's
      // row comes back in the same transaction, so Team still holds the
      // app and keeps its landing page (the check runs at commit).
      await m.withHeads([app], 'update', async (tx) => {
        await tx.execute(
          sql`delete from item_grants where node_id = ${app} and workspace_id = ${team}`,
        );
      });
      const derived = await x<{ via: string | null }>(sql`
        select via_folder_id::text as via from item_grants
         where node_id = ${app} and workspace_id = ${team}`);
      expect(derived).toEqual([{ via: folder }]);
      expect(await landingOf(team)).toBe(app);
      expect((await home(mem, team)).json.homeApp?.appId).toBe(app);
      // The folder's grant goes: Team no longer holds the app, so it forgets
      // its landing page.
      const unshare = await call(`/api/grants/${folder}/${team}?confirm=1`, owner, 'DELETE');
      expect(unshare.status, unshare.text.slice(0, 200)).toBe(200);
      expect(await landingOf(team)).toBeNull();
      expect((await home(mem, team)).json.homeApp).toBeNull();
    } finally {
      await x(sql`update workspaces set landing_app_id = ${teamApp} where id = ${team}`);
    }
  });

  it('a removal that commits while a pick is open still clears that pick', async () => {
    // Audit L-a: a pick checked "held" and holds the workspace row; the
    // grant removal commits meanwhile. Its trigger waits for the row, then
    // sees the pick and clears it.
    const postgres = (await import('postgres')).default;
    const raw = postgres(scratch!.url, { max: 1, onnotice: () => {} });
    let removal: Promise<void> | null = null;
    try {
      await raw.begin(async (t1) => {
        await t1`select 1 from workspaces where id = ${team} for update`;
        await t1`update workspaces set landing_app_id = ${teamApp2} where id = ${team}`;
        removal = outOf(teamApp2, team);
        await new Promise((r) => setTimeout(r, 500));
      });
      await removal;
      expect(await landingOf(team)).toBeNull();
    } finally {
      await raw.end();
      await alsoIn(teamApp2, team);
      await x(sql`update workspaces set landing_app_id = ${teamApp} where id = ${team}`);
    }
  });

  it("under the rollback switch an Admin user's landing page still reads in its own workspaces", async () => {
    // MANTLE_ADMIN_READS=system puts an Admin user's requests on the system
    // pool; the landing page reads through withViewer all the same.
    expect((await setLanding(owner, adminWs, teamApp2)).status).toBe(200);
    process.env.MANTLE_ADMIN_READS = 'system';
    try {
      const a = await home(owner, adminWs);
      expect(a.status, a.text.slice(0, 200)).toBe(200);
      expect(a.json.homeApp?.appId).toBe(teamApp2);
      expect(tokens(a.json.hub)).toContain(adminPage);
      expect(tokens(a.json.hub)).not.toContain(teamPage);
      expect(tokens((await home(owner)).json.hub)).not.toContain(sidePage);
    } finally {
      delete process.env.MANTLE_ADMIN_READS;
      expect((await setLanding(owner, adminWs, null)).status).toBe(200);
    }
  });

  it("an older app's member home is the Team workspace's landing page", async () => {
    const r = await call('/api/member/home', mem);
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(r.outcome).toMatchObject({ kind: 'user', loginId: mem });
    const body = r.json as { homeApp: { appId: string }; hub: Hub };
    expect(body.homeApp.appId).toBe(teamApp);
    expect(tokens(body.hub)).not.toContain(sidePage);
    // The apps list marks a workspace's home app.
    const list = await call('/api/apps', owner);
    const rows = list.json.apps as Array<{ id: string; isHub: boolean }>;
    expect(rows.find((a) => a.id === teamApp)?.isHub).toBe(true);
    expect(rows.find((a) => a.id === teamApp2)?.isHub).toBe(false);
  });
});
