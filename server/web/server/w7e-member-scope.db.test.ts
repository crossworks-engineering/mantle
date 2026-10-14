/**
 * Workspaces W7e, on a migrated scratch database through the real app
 * (createApp), with signed session cookies:
 *
 *  - a member's routes that read brain items run in its request scope (the
 *    /api/member Library and accepted-item routes answer 410);
 *  - every login fetches bytes in its scope on the owner routes
 *    (/api/files/files/:id?raw, /api/draws/:id/svg?raw): an id it does not
 *    read is a 404 that names nothing; a drawing keeps only the images whose
 *    file the login reads; the member byte routes answer 410 since W8d;
 *  - every login runs an app its workspaces hold on the owner runner routes
 *    (frame ticket, db broker, tool broker) at the team rules; an app it
 *    does not read is a 404; the member runner routes answer 410 since W8d;
 *  - the phone contract: whoami's workspaces, areas and isOwner;
 *    mobile-login answers 426 for a non-Admin login; a pairing claim of a
 *    member's code needs X-Jackdaw-Mobile at or above the minimum build (426
 *    otherwise, and the code stays unused); device-login is unchanged;
 *  - onboarding's profile step by a login other than the anchor saves to
 *    that login, never the anchor's row;
 *  - fix round 1: the owner frame opens only for a ticket naming an active
 *    Admin user, and a session naming no login is refused on the runner
 *    routes (a row still marked client is no login since W8a); the member
 *    home runs in the member's scope; raw bytes are never cached; a member
 *    writes an app's rows when its workspace's grant has Write on.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/w7e-member-scope.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

describe.skipIf(!URL)('W7e: member routes in the request scope, the phone contract', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let app: import('hono').Hono;
  let tokens: typeof import('../lib/auth/tokens');
  let cookieOf: (id: string) => string;
  let dir = '';
  const owner = randomUUID(); // the anchor
  const admin2 = randomUUID(); // a second Admin user
  const mem = randomUUID(); // a member (Team)
  const mem2 = randomUUID(); // a member alone in "Side"
  const nobody = randomUUID(); // no login row at all
  const tag = `w7e${randomUUID().slice(0, 6)}`;
  const PASSWORD = 'a long enough password';
  const teamApp = randomUUID();
  const sideApp = randomUUID();
  const teamDraw = randomUUID();
  const sideDraw = randomUUID();
  let team = '';
  let side = '';
  let teamFile = '';
  let sideFile = '';

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const email = (who: string) => `${tag}-${who}@example.invalid`;

  const call = async (
    url: string,
    as: string | null,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{
    status: number;
    text: string;
    json: Json;
    outcome: RequestOutcome | null;
    headers: Headers;
  }> => {
    seen.last = null;
    const h: Record<string, string> = { 'content-type': 'application/json', ...headers };
    if (as) h.cookie = cookieOf(as);
    const res = await app.request(url, {
      method,
      headers: h,
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    });
    const text = await res.text();
    let json: Json = {};
    try {
      json = JSON.parse(text) as Json;
    } catch {
      // not JSON (bytes, an SVG)
    }
    return {
      status: res.status,
      text,
      json,
      outcome: seen.last as RequestOutcome | null,
      headers: res.headers,
    };
  };

  const homeIn = async (id: string, ws: string) => {
    await m.withHeads([id], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${id}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
                           values (${id}, ${ws}, true)`);
    });
  };
  const alsoIn = async (id: string, ws: string, write = false) => {
    await m.withHeads([id], 'update', async (tx) => {
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, write)
                           values (${id}, ${ws}, ${write})
                           on conflict (node_id, workspace_id) do update set write = ${write}`);
    });
  };
  const brainText = async (filename: string, content: string) => {
    const r = await call('/api/files/files', owner, 'POST', {
      parentPath: 'files',
      filename,
      content,
    });
    expect(r.status, r.text.slice(0, 200)).toBeLessThan(300);
    return ((r.json.file as Json | undefined)?.id ?? r.json.id) as string;
  };
  const sym = (id: string, b64: string) =>
    `<symbol id="image-${id}"><image href="data:image/png;base64,${b64}" width="100%" height="100%"></image></symbol>`;

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'w7e-member-scope-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'w7e-member-scope-secret-at-least-32-characters';
    delete process.env.MANTLE_DETACHED_DEV;
    delete process.env.MANTLE_ADMIN_READS;
    m = await import('@mantle/db');
    const hash = (await import('bcryptjs')).default.hashSync(PASSWORD, 4);
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${email('owner')}, ${hash}, true, 'admin', 'Olive Owner'),
      (${admin2}, ${email('admin2')}, ${hash}, false, 'admin', 'Ada Admin'),
      (${mem}, ${email('mem')}, ${hash}, false, 'member', 'Mia Member'),
      (${mem2}, ${email('mem2')}, ${hash}, false, 'member', 'Max Member')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
    const ws = await x<{ id: string; key: string | null }>(sql`
      select id::text as id, (case when is_admin then 'admin' when name = 'Team' then 'team' end) as key from workspaces where owner_id = ${owner}`);
    team = ws.find((w) => w.key === 'team')!.id;
    tokens = await import('../lib/auth/tokens');
    cookieOf = (id) => `mantle_session=${tokens.buildSessionCookie(id).value}`;
    const { createApp } = await import('./app');
    app = await createApp();
    side = (await call('/api/workspaces', mem2, 'POST', { name: 'Side' })).json.id as string;
    expect(side).toBeTruthy();

    // Files: one the Team reads, one only Side reads.
    teamFile = await brainText(`${tag}-team.txt`, 'TEAM BYTES');
    await alsoIn(teamFile, team);
    sideFile = await brainText(`${tag}-side.txt`, 'SIDE BYTES');
    await homeIn(sideFile, side);

    // A drawing the Team reads, with an image of each file; one only Side reads.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><defs>${sym('sceneTeam', 'VEVBTQ==')}${sym('sceneSide', 'U0lERQ==')}</defs><use href="#image-sceneTeam"/><use href="#image-sceneSide"/></svg>`;
    for (const [id, title] of [
      [teamDraw, `${tag} team drawing`],
      [sideDraw, `${tag} side drawing`],
    ] as const) {
      await x(sql`insert into nodes (id, owner_id, type, title, path)
                  values (${id}, ${owner}, 'draw', ${title}, 'draws')`);
      await x(sql`insert into draws (node_id, scene, scene_svg, svg_engine, file_refs)
        values (${id}, '{"elements":[]}'::jsonb, ${svg}, 'excalidraw',
                ${JSON.stringify({ sceneTeam: teamFile, sceneSide: sideFile })}::jsonb)`);
    }
    await alsoIn(teamDraw, team);
    await homeIn(sideDraw, side);

    // Apps with a green published build: the Team's (read only for it) and
    // Side's.
    const green = JSON.stringify({ ok: true, storageKey: `apps/${tag}.js`, builtAt: '2026-10-11' });
    for (const [id, title] of [
      [teamApp, `${tag} Team app`],
      [sideApp, `${tag} Side app`],
    ] as const) {
      await x(sql`insert into nodes (id, owner_id, type, title, path)
                  values (${id}, ${owner}, 'app', ${title}, 'apps')`);
      await x(sql`insert into apps (node_id, manifest, published_build)
                  values (${id}, '{}'::jsonb, ${green}::jsonb)`);
    }
    await alsoIn(teamApp, team, false);
    await homeIn(sideApp, side);
  }, 240_000);

  afterAll(async () => {
    // A write's api.write audit row is fire and forget (auditFireAndForget):
    // the last test's frame-ticket POST may still be inserting it. Ending the
    // pool while that insert opens a connection rejects postgres.js's type
    // fetch with CONNECTION_CLOSED, an unhandled rejection that fails the run
    // though every test passed (CI on v0.300.13 and on A4 step 3b part 5).
    // Let the detached writes land first.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('a member fetches file bytes in its scope on the owner route; an unreadable id is a 404', async () => {
    const raw = await call(`/api/files/files/${teamFile}?raw=1`, mem);
    expect(raw.status, raw.text.slice(0, 200)).toBe(200);
    expect(raw.text).toBe('TEAM BYTES');
    expect(raw.outcome).toMatchObject({ kind: 'user', loginId: mem });
    // Read in the login's scope: never kept by a cache (W7e fix round 1, L2).
    expect(raw.headers.get('cache-control')).toBe('private, no-store');
    for (const id of [sideFile, randomUUID()]) {
      for (const q of ['raw=1', 'thumb=1']) {
        const r = await call(`/api/files/files/${id}?${q}`, mem);
        expect(r.status, `${id} ${q}`).toBe(404);
        expect(r.text).not.toContain('side.txt');
      }
    }
    // An <img> src: the member's own asset token (the shell mints it).
    const at = (await call('/api/shell', mem)).json.assetToken as string;
    expect(at).toBeTruthy();
    // A member's token is the short one (W7e fix round 1, L3).
    expect(tokens.verifyAssetToken(at)).toMatchObject({ uid: owner, act: mem });
    const payload = JSON.parse(Buffer.from(at.split('.')[0]!, 'base64url').toString('utf8')) as {
      exp: number;
    };
    const exp = payload.exp;
    expect(exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(
      tokens.SHORT_ASSET_TOKEN_TTL_SECONDS,
    );
    const byToken = await call(
      `/api/files/files/${teamFile}?raw=1&at=${encodeURIComponent(at)}`,
      null,
    );
    expect(byToken.status).toBe(200);
    expect(byToken.text).toBe('TEAM BYTES');
    const sideByToken = await call(
      `/api/files/files/${sideFile}?raw=1&at=${encodeURIComponent(at)}`,
      null,
    );
    expect(sideByToken.status).toBe(404);
    // The member route is gone (W8d): 410, the bytes of neither file.
    for (const id of [teamFile, sideFile]) {
      const old = await call(`/api/member/files/${id}`, mem);
      expect(old.status).toBe(410);
      expect(old.text).not.toContain('BYTES');
    }
    // The other member reads the Side file (its workspace); an Admin user
    // who is not in Side does not.
    expect((await call(`/api/files/files/${sideFile}?raw=1`, mem2)).text).toBe('SIDE BYTES');
    expect((await call(`/api/files/files/${sideFile}?raw=1`, owner)).status).toBe(404);
  });

  it('a member reads a drawing in its scope with only the images it may read', async () => {
    for (const url of [`/api/draws/${teamDraw}/svg?raw=1`]) {
      const r = await call(url, mem);
      expect(r.status, `${url} ${r.text.slice(0, 200)}`).toBe(200);
      expect(r.text).toContain('VEVBTQ==');
      expect(r.text).not.toContain('U0lERQ==');
      expect(r.outcome).toMatchObject({ kind: 'user', loginId: mem });
      // Read in the member's scope: a cache revalidates before reuse (W7d+e).
      expect(r.headers.get('cache-control'), url).toBe('private, no-cache');
    }
    const json = await call(`/api/draws/${teamDraw}/svg`, mem);
    expect(json.status).toBe(200);
    expect(String(json.json.svg)).not.toContain('U0lERQ==');
    for (const url of [
      `/api/draws/${sideDraw}/svg?raw=1`,
      `/api/draws/${randomUUID()}/svg?raw=1`,
    ]) {
      const r = await call(url, mem);
      expect(r.status, url).toBe(404);
      expect(r.text).not.toContain('side drawing');
    }
    expect((await call(`/api/draws/${sideDraw}/svg`, mem)).json).toEqual({ svg: null });
    // The member route is gone (W8d).
    const old = await call(`/api/member/draws/${teamDraw}/svg`, mem);
    expect(old.status).toBe(410);
    expect(old.text).not.toContain('VEVBTQ==');
  });

  it('a member runs a Team app on the owner runner routes; an app it does not read is a 404', async () => {
    const t = await call(`/api/apps/${teamApp}/frame-ticket`, mem, 'POST', {});
    expect(t.status, t.text.slice(0, 200)).toBe(200);
    expect(t.outcome).toMatchObject({ kind: 'user', loginId: mem });
    const claims = tokens.verifyAppFrameTicket(t.json.ticket as string);
    expect(claims).toMatchObject({ ownerId: owner, appId: teamApp, loginId: mem });
    const q = await call(`/api/apps/${teamApp}/db-broker`, mem, 'POST', {
      op: 'query',
      sql: 'select 1 as one',
    });
    expect(q.status, q.text.slice(0, 200)).toBe(200);
    expect(q.json).toMatchObject({ ok: true, output: [{ one: 1 }] });
    // The Team's grant has Write off: its data is read only for the member.
    const w = await call(`/api/apps/${teamApp}/db-broker`, mem, 'POST', {
      op: 'exec',
      sql: 'create table t (a int)',
    });
    expect(w.status).toBe(403);
    // A tool the app does not declare is refused by the team rules.
    const tool = await call(`/api/apps/${teamApp}/tool-broker`, mem, 'POST', { slug: 'note_list' });
    expect(tool.status).toBe(403);
    expect(tool.outcome).toMatchObject({ kind: 'user', loginId: mem });
    for (const route of ['frame-ticket', 'db-broker', 'tool-broker']) {
      const body = route === 'db-broker' ? { op: 'query', sql: 'select 1' } : { slug: 'x' };
      for (const id of [sideApp, randomUUID()]) {
        const r = await call(`/api/apps/${id}/${route}`, mem, 'POST', body);
        expect(r.status, `${route} ${id}`).toBe(404);
        expect(r.text).not.toContain('Side app');
      }
    }
    // The member runner is gone (W8d): 410, no ticket.
    for (const route of ['frame-ticket', 'db-broker', 'tool-broker']) {
      const old = await call(`/api/member/apps/${teamApp}/${route}`, mem, 'POST', {});
      expect(old.status, route).toBe(410);
      expect(old.json.ticket, route).toBeUndefined();
    }
    // An Admin user still gets the owner ticket (draft allowed, no login claim).
    const own = await call(`/api/apps/${teamApp}/frame-ticket`, owner, 'POST', {});
    expect(own.status).toBe(200);
    const ownClaims = tokens.verifyAppFrameTicket(own.json.ticket as string);
    expect(ownClaims?.loginId).toBeUndefined();
    expect(ownClaims?.actorId).toBe(owner);
  });

  it('the member Library and accepted-item routes answer 410; the member content routes run in its scope', async () => {
    for (const url of [
      '/api/member/library',
      `/api/member/library/${teamFile}`,
      '/api/member/accepted',
      `/api/member/accepted/${teamFile}`,
    ]) {
      const r = await call(url, mem);
      expect(r.status, url).toBe(410);
      expect(r.json.code).toBe('gone');
      expect(r.outcome).toMatchObject({ kind: 'user', loginId: mem });
    }
    // The member app list is gone (W8d).
    const apps = await call('/api/member/apps', mem);
    expect(apps.status).toBe(410);
    expect(apps.json.code).toBe('gone');
    // The member home reads team pages and apps: in its scope too (W7e fix
    // round 1, L1). Since task d78e7bde it is the Team workspace's landing
    // page (workspaces.landing_app_id). Its own things (its push devices)
    // hold their own rule.
    await x(sql`update workspaces set landing_app_id = ${teamApp} where id = ${team}`);
    const home = await call('/api/member/home', mem);
    expect(home.status, home.text.slice(0, 200)).toBe(200);
    expect(home.outcome).toMatchObject({ kind: 'user', loginId: mem });
    expect(home.json.homeApp).toMatchObject({ appId: teamApp });
    // A home app Team does not hold: the built-in home.
    await x(sql`update workspaces set landing_app_id = ${sideApp} where id = ${team}`);
    expect((await call('/api/member/home', mem)).json).toMatchObject({ homeApp: null, hub: null });
    await x(sql`update workspaces set landing_app_id = null where id = ${team}`);
    expect((await call('/api/member/push/subscriptions', mem)).outcome).toMatchObject({
      kind: 'own-rule',
    });
  });

  it('whoami answers the workspaces, the areas and isOwner (the shell builder)', async () => {
    const me = await call('/api/auth/whoami', mem);
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ role: 'member', loginId: mem, areas: [], isOwner: false });
    const memWs = (me.json.workspaces as Array<{ id: string }>).map((w) => w.id);
    expect(memWs).toContain(team);
    expect(memWs).not.toContain(side);
    const shell = await call('/api/shell', mem);
    expect(me.json.workspaces).toEqual(shell.json.workspaces);

    const o = await call('/api/auth/whoami', owner);
    expect(o.json).toMatchObject({ role: 'admin', loginId: owner, isOwner: true });
    expect((o.json.areas as string[]).length).toBeGreaterThan(0);
    expect((o.json.workspaces as Array<{ isAdmin: boolean }>).some((w) => w.isAdmin)).toBe(true);
    const a2 = await call('/api/auth/whoami', admin2);
    expect(a2.json).toMatchObject({ role: 'admin', loginId: admin2, isOwner: false });
  });

  it('mobile-login answers 426 for a non-Admin login; device-login is unchanged', async () => {
    const old = await call('/api/auth/mobile-login', null, 'POST', {
      email: email('mem'),
      password: PASSWORD,
    });
    expect(old.status).toBe(426);
    expect(old.json.reason).toBe('update-app');
    expect(old.json).not.toHaveProperty('token');
    const admin = await call('/api/auth/mobile-login', null, 'POST', {
      email: email('admin2'),
      password: PASSWORD,
    });
    expect(admin.status).toBe(200);
    expect(admin.json.token).toBeTruthy();
    const device = await call('/api/auth/device-login', null, 'POST', {
      email: email('mem'),
      password: PASSWORD,
    });
    expect(device.status).toBe(200);
    expect(device.json).toMatchObject({ role: 'member', loginId: mem });
    // A wrong password stays the one 401, whatever the role.
    expect(
      (
        await call('/api/auth/mobile-login', null, 'POST', {
          email: email('mem'),
          password: 'not the password',
        })
      ).status,
    ).toBe(401);
  });

  it('a member pairs its own phone: 426 without the workspace build, the code stays usable', async () => {
    const issued = await call('/api/auth/pair', mem, 'POST', {});
    expect(issued.status, issued.text.slice(0, 200)).toBe(200);
    const code = issued.json.code as string;
    const claim = (headers: Record<string, string>) =>
      call('/api/auth/pair/claim', null, 'POST', { code, deviceName: 'Phone' }, headers);
    expect((await claim({})).status).toBe(426);
    expect((await claim({ 'x-jackdaw-mobile': '26' })).status).toBe(426);
    expect((await claim({ 'x-jackdaw-mobile': '1.14.0+26' })).status).toBe(426);
    const ok = await claim({ 'x-jackdaw-mobile': '1.15.0+27' });
    expect(ok.status, ok.text.slice(0, 200)).toBe(200);
    expect(ok.json).toMatchObject({ loginId: mem });
    expect(ok.json.token).toBeTruthy();
    // Single use, as before.
    expect((await claim({ 'x-jackdaw-mobile': '27' })).status).toBe(401);
    // The status poll names it claimed, for its own login only.
    const st = await call(`/api/auth/pair/${issued.json.id as string}`, mem);
    expect(st.json.status).toBe('claimed');
    // An admin's code claims from any build, as before.
    const a = await call('/api/auth/pair', admin2, 'POST', {});
    const ac = await call('/api/auth/pair/claim', null, 'POST', { code: a.json.code });
    expect(ac.status).toBe(200);
  });

  it('onboarding profile by a login other than the anchor saves to that login', async () => {
    const tz = async (id: string) =>
      (
        await x<{ tz: string | null }>(sql`
          select preferences->>'timezone' as tz from profiles where user_id = ${id}`)
      )[0]?.tz ?? null;
    const before = await tz(owner);
    const r = await call('/api/onboarding', admin2, 'POST', {
      action: 'profile',
      timezone: 'Pacific/Chatham',
      locale: 'en-NZ',
      displayName: 'Ada',
    });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(await tz(owner)).toBe(before);
    expect(await tz(admin2)).toBe('Pacific/Chatham');
  });

  it("a member writes an app's rows when its workspace holds the app with Write on", async () => {
    // The schema is the author's (an Admin user's run); a member changes rows only.
    const made = await call(`/api/apps/${teamApp}/db-broker`, owner, 'POST', {
      op: 'exec',
      sql: 'create table if not exists w (a int)',
    });
    expect(made.status, made.text.slice(0, 200)).toBe(200);
    await alsoIn(teamApp, team, true);
    try {
      const w = await call(`/api/apps/${teamApp}/db-broker`, mem, 'POST', {
        op: 'exec',
        sql: 'insert into w (a) values (7)',
      });
      expect(w.status, w.text.slice(0, 200)).toBe(200);
      expect(w.json.ok).toBe(true);
      expect(w.outcome).toMatchObject({ kind: 'user', loginId: mem });
      const q = await call(`/api/apps/${teamApp}/db-broker`, mem, 'POST', {
        op: 'query',
        sql: 'select a from w',
      });
      expect(q.json).toMatchObject({ ok: true, output: [{ a: 7 }] });
      // Rows only, never the schema, even with Write on.
      const ddl = await call(`/api/apps/${teamApp}/db-broker`, mem, 'POST', {
        op: 'exec',
        sql: 'drop table w',
      });
      expect(ddl.json.ok).not.toBe(true);
      // An app its workspaces do not hold: still the plain 404.
      const other = await call(`/api/apps/${sideApp}/db-broker`, mem, 'POST', {
        op: 'exec',
        sql: 'insert into w (a) values (8)',
      });
      expect(other.status).toBe(404);
    } finally {
      await alsoIn(teamApp, team, false);
    }
  });

  it('a session naming no login, and a frame ticket naming no active Admin user, are refused (fix round 1, M1)', async () => {
    const days30 = 30 * 24 * 60 * 60;
    const session = tokens.buildSessionCookie(nobody, { ttlSeconds: days30 }).value;
    const asNobody = (url: string, method = 'GET', body?: unknown) =>
      call(url, null, method, body, { cookie: `mantle_session=${session}` });
    // A signed cookie whose login has no row is no login (a row still
    // marked client resolves the same way since W8a).
    expect((await asNobody('/api/shell')).status).toBe(401);
    expect((await asNobody('/api/auth/whoami')).status).toBe(401);
    // Running an app: never the Admin path (no owner ticket, no SQL, no
    // tool), for an app the Team reads and one it does not.
    for (const id of [teamApp, sideApp]) {
      for (const route of ['frame-ticket', 'db-broker', 'tool-broker']) {
        const body =
          route === 'db-broker' ? { op: 'query', sql: 'select 1 as one' } : { slug: 'x' };
        const r = await asNobody(`/api/apps/${id}/${route}`, 'POST', body);
        expect(r.status, `${route} ${id} ${r.text.slice(0, 160)}`).toBe(401);
        expect(r.json).not.toHaveProperty('ticket');
        expect(r.json).not.toHaveProperty('output');
      }
    }

    // The frame: an owner ticket naming no login, a ticket of the old client
    // shape, a member-shaped one naming no login, and an owner ticket naming
    // a member are all refused.
    const frame = (t: string) =>
      call(`/api/apps/${teamApp}/frame?t=${encodeURIComponent(t)}`, null);
    for (const t of [
      tokens.buildAppFrameTicket({ ownerId: owner, appId: teamApp, actorId: nobody }),
      tokens.buildAppFrameTicket({
        ownerId: owner,
        appId: teamApp,
        loginId: nobody,
        clientEpoch: 0,
      }),
      tokens.buildAppFrameTicket({ ownerId: owner, appId: teamApp, loginId: nobody }),
      tokens.buildAppFrameTicket({ ownerId: owner, appId: teamApp, actorId: mem }),
    ]) {
      const r = await frame(t);
      expect(r.status, r.text.slice(0, 120)).toBe(401);
    }
    // An Admin user's own ticket still gets past that check.
    const own = await call(`/api/apps/${teamApp}/frame-ticket`, owner, 'POST', {});
    expect(own.status).toBe(200);
    expect((await frame(own.json.ticket as string)).status).not.toBe(401);
  });
});
