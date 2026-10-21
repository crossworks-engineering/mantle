/**
 * The first sign-up on a fresh brain with the actor check on. A fresh
 * install is migrated with the check on (the checks' floor, 0301), has no
 * owner and no workspaces, and serves only its signup. POST
 * /api/auth/signup on the real app (createApp) makes the owner and switches
 * the brain onto workspaces (mantle_ws_migrate_locked): the switch runs as
 * system(first-owner-attach), the first owner's request system exit
 * (packages/db/src/first-owner-exit.ts), on the full route. Before that
 * exit the switch's bare select went with no actor while the runtime role
 * was off, the check refused the switch's writes, and the signup answered
 * 503 (on, it ran as the request's system(http:no-login)).
 *
 * The exit's refusals: outside a request, in a request a login made,
 * inside another exit, twice in one request, on a brain with no login, and
 * on a brain already switched. The terminal wizard's first owner (no
 * request) switches as its own script actor. Answers for a brain with an
 * owner are unchanged (403; the boot's switch changes nothing).
 *
 * Runs in the full DB run (runtime role off, the narrow switch on), with
 * MANTLE_NARROW_SYSTEM=0 (narrow off), in test:actor-on and in
 * test:runtime-role (CI's subset matches /ws-): the box mode is set 'on'
 * here whatever the run's MANTLE_ACTOR_CHECK.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/ws-fresh-signup.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

// A brain left off workspaces stops its web process (refuseUnswitchedBrain):
// recorded here, never a real exit.
const refused = vi.hoisted(() => ({ why: [] as string[] }));
vi.mock('@/lib/auth/unswitched-brain', () => ({
  refuseUnswitchedBrain: (why: string) => {
    refused.why.push(why);
  },
}));

describe.skipIf(!URL)('the first sign-up on a fresh brain, actor check on', () => {
  type Ts = typeof import('@mantle/db/test-support');
  type Scratch = Awaited<ReturnType<Ts['createMigratedScratchDatabase']>>;
  const made: Scratch[] = [];
  const clients: ReturnType<typeof postgres>[] = [];
  let su: ReturnType<typeof postgres>;
  let app: import('hono').Hono;
  let dir = '';
  const email = `fresh-${randomUUID().slice(0, 6)}@example.invalid`;
  const password = 'a long enough password 1';

  /** A fresh install: migrated, the actor check on (as the checks' floor
   *  leaves it), and a test-only record of the actor the database saw for
   *  each workspace row made. The app's pools point at it. */
  const freshBrain = async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    const scratch = await ts.createMigratedScratchDatabase(URL!);
    made.push(scratch);
    const sql = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    clients.push(sql);
    await sql`select mantle_set_actor_check('on')`;
    await sql.unsafe(`
      create table fsu_ws_actor (bridge_key text, actor text);
      create function fsu_ws_actor_note() returns trigger language plpgsql as $$
      begin
        insert into fsu_ws_actor values (new.bridge_key, current_setting('mantle.actor', true));
        return new;
      end $$;
      create trigger fsu_ws_actor after insert on workspaces
        for each row execute function fsu_ws_actor_note();`);
    process.env.DATABASE_URL = scratch.url;
    return sql;
  };

  const signup = async (body: Record<string, unknown>) => {
    const res = await app.request('/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  };

  /** `fn` inside a request slot, as the HTTP gate opens one (`as`: the
   *  request's first actor; the gate's system(http:no-login) by default). */
  const inRequest = async <T>(fn: () => Promise<T>, as?: import('@mantle/db').Actor) => {
    const v = await import('@mantle/db/viewer');
    return v.runInRequestSlot(fn, as ? { startsAs: as } : {});
  };

  /** What a call answered: its value, or its error's message. */
  const outcome = async (p: Promise<unknown>) =>
    p.then(
      (ok) => ({ ok }),
      (err: Error) => ({ refused: err.message }),
    );

  beforeAll(async () => {
    su = await freshBrain();
    dir = await mkdtemp(path.join(tmpdir(), 'ws-fresh-signup-'));
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'ws-fresh-signup-secret-at-least-32-characters';
    delete process.env.MANTLE_DETACHED_DEV;
    delete process.env.MANTLE_SETUP_CODE;
    const { createApp } = await import('./app');
    app = await createApp();
  }, 240_000);

  afterAll(async () => {
    await (await import('../lib/audit')).auditsSettled();
    await (await import('@mantle/db')).closeDb();
    for (const c of clients) await c.end().catch(() => {});
    for (const s of made) await s.drop().catch(() => {});
    if (dir) await rm(dir, { recursive: true, force: true });
  }, 120_000);

  it('the box is a fresh install with the check on: no owner, no workspaces', async () => {
    expect((await su`select mantle_actor_check_mode() as m`)[0]!.m).toBe('on');
    expect((await su`select mantle_ws_skip_reason() as r`)[0]!.r).toBe('no brain anchor yet');
    expect(Number((await su`select count(*) as n from auth.users`)[0]!.n)).toBe(0);
    expect(Number((await su`select count(*) as n from workspaces`)[0]!.n)).toBe(0);
  });

  it('the exit refuses outside a request, in a request a login made, inside another exit, and on a brain with no login', async () => {
    const m = await import('@mantle/db');
    // The exit takes no function: one passed past the type, by a cast, is
    // never run (the exit runs the switch and nothing else).
    const ran: string[] = [];
    const sw = (id: string) =>
      (
        m.firstOwnerSwitch as unknown as (
          id: string,
          fn: () => Promise<unknown>,
        ) => Promise<unknown>
      )(id, async () => {
        ran.push(id);
        return 'other work';
      });
    const id = randomUUID();
    // A worker, a boot step, a script, a test's bare call: no request.
    expect(await outcome(sw(id))).toEqual({
      refused: "the first owner's exit refused: it runs only inside a request",
    });
    // A signed-in login's request (any login: the exit names none).
    expect(await outcome(inRequest(() => sw(id), m.loginActor(id)))).toEqual({
      refused: "the first owner's exit refused: it runs only in a request no login made",
    });
    // A request whose guard named a system reason (an Admin area route).
    expect(await outcome(inRequest(() => sw(id), m.systemActor('http:admin-area')))).toEqual({
      refused: "the first owner's exit refused: it runs only in a request no login made",
    });
    // Inside another exit of the same request.
    expect(await outcome(inRequest(() => m.asSystem(() => sw(id), 'test')))).toEqual({
      refused: "the first owner's exit refused: it runs outside every scope only",
    });
    // The right request, but the brain has no login: nothing to switch for.
    expect(await outcome(inRequest(() => sw(id)))).toEqual({
      refused:
        "the first owner's exit refused: only on a brain whose one login is this new owner, with no workspaces yet",
    });
    expect(ran).toEqual([]);
    expect(Number((await su`select count(*) as n from workspaces`)[0]!.n)).toBe(0);
  });

  it('the exit binds system(first-owner-attach) on the full route for its call only, once per request', async () => {
    const m = await import('@mantle/db');
    const v = await import('@mantle/db/viewer');
    const seen = await inRequest(async () => {
      const before = m.currentActor();
      const inside = await v.enterFirstOwnerExit(async () => ({
        actor: m.currentActor(),
        route: v.systemRouteNow(),
      }));
      const after = m.currentActor();
      const again = await outcome(v.enterFirstOwnerExit(async () => 'twice'));
      return { before, inside, after, again };
    });
    expect(seen).toEqual({
      before: { kind: 'system', reason: 'http:no-login' },
      inside: { actor: { kind: 'system', reason: 'first-owner-attach' }, route: 'full' },
      after: { kind: 'system', reason: 'http:no-login' },
      again: { refused: "the first owner's exit refused: it runs once per request" },
    });
  });

  it('POST /api/auth/signup makes the owner, in Admin, and the brain is on workspaces', async () => {
    const out = await signup({ email, password });
    expect(refused.why).toEqual([]);
    expect(out.status, out.text.slice(0, 300)).toBe(200);
    expect(JSON.parse(out.text)).toEqual({ ok: true });
    const users = await su<{ id: string; email: string; owner: boolean; role: string }[]>`
      select id::text as id, email, is_owner as owner, role from auth.users`;
    expect(users).toEqual([{ id: expect.any(String), email, owner: true, role: 'admin' }]);
    expect((await su`select mantle_ws_skip_reason() as r`)[0]!.r).toBeNull();
    const ws = await su<{ key: string; admin: boolean; owner: string }[]>`
      select bridge_key as key, is_admin as admin, owner_id::text as owner from workspaces`;
    expect(ws).toEqual([{ key: 'admin', admin: true, owner: users[0]!.id }]);
    const inAdmin = await su<{ moderator: boolean }[]>`
      select u.moderator from workspace_users u join workspaces w on w.id = u.workspace_id
       where w.is_admin and u.login_id = ${users[0]!.id}`;
    expect(inAdmin).toEqual([{ moderator: true }]);
    // The switch's writes ran as the first owner's exit (the Team workspace
    // it made and removed, then Admin).
    const seen = await su<{ key: string; actor: string }[]>`
      select bridge_key as key, actor from fsu_ws_actor order by bridge_key`;
    expect(seen.map((r) => r.key)).toContain('admin');
    expect([...new Set(seen.map((r) => r.actor))]).toEqual(['system:first-owner-attach']);
    // No miss on the way (vitest.setup.ts fails a test on any, too).
    expect(await su`select source, check_name, actor from actor_check_misses`).toEqual([]);
  });

  it('a second sign-up is refused, as on any brain with an owner (unchanged)', async () => {
    const out = await signup({ email: `again-${email}`, password });
    expect(out.status).toBe(403);
    expect(Number((await su`select count(*) as n from auth.users`)[0]!.n)).toBe(1);
  });

  it('the exit refuses on the switched brain, its owner`s id included, and runs nothing', async () => {
    const m = await import('@mantle/db');
    const [owner] = await su<{ id: string }[]>`select id::text as id from auth.users`;
    const before = await su`select id, bridge_key from workspaces order by id`;
    for (const id of [owner!.id, randomUUID()]) {
      expect(await outcome(inRequest(() => m.firstOwnerSwitch(id)))).toEqual({
        refused:
          "the first owner's exit refused: only on a brain whose one login is this new owner, with no workspaces yet",
      });
    }
    expect(await su`select id, bridge_key from workspaces order by id`).toEqual(before);
  });

  it('the boot`s switch on the switched brain changes nothing (unchanged)', async () => {
    const m = await import('@mantle/db');
    const wm = await import('../lib/workspaces-migrate');
    const before = await su`select id, bridge_key from workspaces order by id`;
    await m.systemWork(() => wm.migrateWorkspacesQuietly('boot'), 'boot:migrate-workspaces');
    expect(await su`select id, bridge_key from workspaces order by id`).toEqual(before);
    expect(await wm.unmigratedBrainReason()).toBeNull();
  });

  it('the terminal wizard`s first owner (no request) switches as its own script actor', async () => {
    const m = await import('@mantle/db');
    await m.closeDb();
    const sql = await freshBrain();
    const { createFirstOwner } = await import('../lib/auth/first-owner');
    const res = await m.runAsSystem('script:onboard', () =>
      createFirstOwner(`wizard-${email}`, password),
    );
    expect(res).toMatchObject({ ok: true, email: `wizard-${email}` });
    const ws = await sql<{ key: string }[]>`select bridge_key as key from workspaces`;
    expect(ws).toEqual([{ key: 'admin' }]);
    const seen = await sql<{ actor: string }[]>`select distinct actor from fsu_ws_actor`;
    expect(seen).toEqual([{ actor: 'system:script:onboard' }]);
    expect(await sql`select source from actor_check_misses`).toEqual([]);
  }, 240_000);
});
