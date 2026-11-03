/**
 * Who reads the brain's activity, on a migrated scratch database switched
 * to workspaces, through the full HTTP pipeline (runRoute): the anchor,
 * another Admin user, a Moderator and a member, each against system work
 * (a trace of no login), an anchor's heartbeat fire (no login on the
 * trace, the anchor's turn), and each login's own turn.
 *
 *  - The anchor lists and reads the system's work, its own turns and its
 *    heartbeat fires, never another login's turn.
 *  - Another Admin user (the settings area) lists and reads the system's
 *    work and its own turns; never the anchor's turns or heartbeat fires,
 *    never another login's.
 *  - A Moderator and a member are refused the Activity column (an owner
 *    route), /traces and the journey (the settings area's): 403 each; the
 *    read rule alone gives them their own turn only.
 *
 * Fixtures are written as the superuser on this file's own client.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/activity-admins.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the activity every Admin user reads', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let runRoute: typeof import('./run-route').runRoute;
  let raw: postgres.Sql;
  let dir = '';
  const tag = `actadm${randomUUID().slice(0, 6)}`;
  const L = {
    owner: randomUUID(), // the anchor
    admin: randomUUID(), // another user of Admin
    mod: randomUUID(), // a Moderator of W
    member: randomUUID(), // a plain user of W
  };
  type Who = keyof typeof L;
  /** One trace per kind of row: the system's, the anchor's heartbeat fire,
   *  and each login's own turn. */
  const T = {
    system: randomUUID(),
    anchorFire: randomUUID(),
    owner: randomUUID(),
    admin: randomUUID(),
    mod: randomUUID(),
    member: randomUUID(),
  };
  type Row = keyof typeof T;

  const text = async (who: Who, url: string) => {
    const res = await runRoute(L[who], 'GET', url);
    return { status: res.status, body: await res.text() };
  };
  /** The rows of T a body names. */
  const named = (body: string): Row[] =>
    (Object.keys(T) as Row[]).filter((k) => body.includes(T[k])).sort();

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'activity-admins-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'activity-admins-test-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the activity test', { status: 503 })),
    );
    m = await import('@mantle/db');
    runRoute = (await import('./run-route')).runRoute;
    raw = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });

    for (const [who, id] of Object.entries(L)) {
      const admin = who === 'owner' || who === 'admin';
      await asSuperuser()`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
        values (${id}, ${`${tag}-${who}@example.invalid`}, 'x', ${who === 'owner'},
                ${admin ? 'admin' : 'member'}, ${who})`;
    }
    await raw`insert into spaces (id, kind, login_id) values (${L.owner}, 'brain', ${L.owner})
              on conflict (id) do nothing`;
    await raw`select * from mantle_ws_migrate()`;
    const adminWs = (
      await raw<{ id: string }[]>`select id::text as id from workspaces
                                    where owner_id = ${L.owner} and is_admin`
    )[0]!.id;
    await raw`insert into workspace_users (workspace_id, login_id, moderator)
      values (${adminWs}, ${L.admin}, true)
      on conflict (workspace_id, login_id) do update set moderator = true`;
    const w = (
      await raw<{ id: string }[]>`insert into workspaces (owner_id, name)
        values (${L.owner}, ${`${tag} W`}) returning id::text as id`
    )[0]!.id;
    await raw`delete from workspace_users where workspace_id = ${w}`;
    await raw`insert into workspace_users (workspace_id, login_id, moderator)
      values (${w}, ${L.mod}, true), (${w}, ${L.member}, false)`;
    for (const login of [L.mod, L.member]) {
      await raw`select "public"."mantle_ws_private_workspace"(
        set_config('mantle.scope_login', ${login}, true)::uuid)`;
    }

    // The anchor's heartbeat: its fire answers the anchor (answered_by
    // null) and its trace carries no login, as fire.ts stamps it.
    const [hb] = await raw<{ id: string }[]>`
      insert into heartbeats (owner_id, slug, name, agent_slug, skill_slug,
                              schedule_kind, schedule, surface)
      values (${L.owner}, ${`${tag}-hb`}, 'Check', 'assistant', 'check', 'manual',
              '{"kind":"manual"}'::jsonb, '{"kind":"web"}'::jsonb)
      returning id::text as id`;
    await raw`insert into traces (id, owner_id, kind, status, login_id) values
      (${T.system}, ${L.owner}, 'manual', 'success', null),
      (${T.anchorFire}, ${L.owner}, 'heartbeat_fire', 'success', null),
      (${T.owner}, ${L.owner}, 'responder_turn', 'success', ${L.owner}),
      (${T.admin}, ${L.owner}, 'responder_turn', 'success', ${L.admin}),
      (${T.mod}, ${L.owner}, 'responder_turn', 'success', ${L.mod}),
      (${T.member}, ${L.owner}, 'responder_turn', 'success', ${L.member})`;
    await raw`insert into heartbeat_fires (heartbeat_id, trace_id, disposition, answered_by)
      values (${hb!.id}, ${T.anchorFire}, 'fired', null)`;
  }, 240_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await raw?.end();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** What each Admin user lists and reads. */
  const ADMIN_SEES: Record<'owner' | 'admin', Row[]> = {
    owner: ['anchorFire', 'owner', 'system'],
    admin: ['admin', 'system'],
  };

  it.each(['owner', 'admin'] as const)(
    '%s: the Activity column, the journey feed and /traces list the same rows',
    async (who) => {
      const live = await text(who, '/api/activity');
      expect(live.status, live.body).toBe(200);
      expect(named(live.body)).toEqual(ADMIN_SEES[who]);
      const feed = await text(who, '/api/debug/journey');
      expect(feed.status, feed.body).toBe(200);
      expect(named(feed.body)).toEqual(ADMIN_SEES[who]);
      const list = await text(who, '/api/traces');
      expect(list.status, list.body).toBe(200);
      expect(named(list.body)).toEqual(ADMIN_SEES[who]);
    },
  );

  it.each(['owner', 'admin'] as const)(
    '%s: one trace and one journey read exactly the rows it lists',
    async (who) => {
      for (const row of Object.keys(T) as Row[]) {
        const want = ADMIN_SEES[who].includes(row) ? 200 : 404;
        const one = await text(who, `/api/traces/${T[row]}`);
        expect(one.status, `${who} reads trace ${row}: ${one.body}`).toBe(want);
        const story = await text(who, `/api/debug/journey/${T[row]}`);
        expect(story.status, `${who} reads journey ${row}: ${story.body}`).toBe(want);
      }
    },
  );

  it.each(['mod', 'member'] as const)(
    '%s: the Activity column, /traces and the journey are refused',
    async (who) => {
      for (const url of [
        '/api/activity',
        '/api/traces',
        '/api/debug/journey',
        `/api/traces/${T.system}`,
        `/api/debug/journey/${T.system}`,
        `/api/traces/${T[who]}`,
      ]) {
        const res = await text(who, url);
        expect(res.status, `${who} ${url}: ${res.body}`).toBe(403);
      }
    },
  );

  it('the read rule alone: a login without the system reads its own turn only', async () => {
    const { traceReadable } = await import('@/lib/traces');
    for (const who of ['mod', 'member'] as const) {
      const reader = { login: L[who], system: false };
      for (const row of Object.keys(T) as Row[]) {
        const readable = await m.asSystem(() => traceReadable(L.owner, T[row], reader), 'test');
        expect(readable, `${who} reads ${row}`).toBe(row === who);
      }
    }
  });
});
