/**
 * The first sign-up on a fresh brain with the actor check on (task
 * d5289a8b). A fresh install is migrated with the check on (the checks'
 * floor, 0301), has no owner and no workspaces, and serves only its
 * signup. POST /api/auth/signup on the real app (createApp) makes the owner
 * and switches the brain onto workspaces (mantle_ws_migrate_locked): the
 * switch runs as system(first-owner-attach), the one request system exit
 * of the first owner (packages/db/src/first-owner-exit.ts), on the full
 * route. Before that exit the switch ran with no actor in the request
 * (runtime role off: a bare select, sent with no actor; on: refused before
 * it was sent) and the signup answered 503.
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
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let su: ReturnType<typeof postgres> | undefined;
  let app: import('hono').Hono;
  let dir = '';
  const email = `fresh-${randomUUID().slice(0, 6)}@example.invalid`;
  const password = 'a long enough password 1';

  const signup = async (body: Record<string, unknown>) => {
    const res = await app.request('/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    su = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    // As a fresh install's migrate leaves it (the checks' floor): on.
    await su`select mantle_set_actor_check('on')`;
    // What the database saw as the actor of each workspace row the switch
    // made: a test-only record, dropped with the scratch database.
    await su.unsafe(`
      create table fsu_ws_actor (bridge_key text, actor text);
      create function fsu_ws_actor_note() returns trigger language plpgsql as $$
      begin
        insert into fsu_ws_actor values (new.bridge_key, current_setting('mantle.actor', true));
        return new;
      end $$;
      create trigger fsu_ws_actor after insert on workspaces
        for each row execute function fsu_ws_actor_note();`);
    dir = await mkdtemp(path.join(tmpdir(), 'ws-fresh-signup-'));
    process.env.DATABASE_URL = scratch.url;
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
    await su?.end();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('the box is a fresh install with the check on: no owner, no workspaces', async () => {
    expect((await su!`select mantle_actor_check_mode() as m`)[0]!.m).toBe('on');
    expect((await su!`select mantle_ws_skip_reason() as r`)[0]!.r).toBe('no brain anchor yet');
    expect(Number((await su!`select count(*) as n from auth.users`)[0]!.n)).toBe(0);
    expect(Number((await su!`select count(*) as n from workspaces`)[0]!.n)).toBe(0);
  });

  it('POST /api/auth/signup makes the owner, in Admin, and the brain is on workspaces', async () => {
    const out = await signup({ email, password });
    expect(refused.why).toEqual([]);
    expect(out.status, out.text.slice(0, 300)).toBe(200);
    expect(JSON.parse(out.text)).toEqual({ ok: true });
    const users = await su!<{ id: string; email: string; owner: boolean; role: string }[]>`
      select id::text as id, email, is_owner as owner, role from auth.users`;
    expect(users).toEqual([{ id: expect.any(String), email, owner: true, role: 'admin' }]);
    expect((await su!`select mantle_ws_skip_reason() as r`)[0]!.r).toBeNull();
    const ws = await su!<{ key: string; admin: boolean; owner: string }[]>`
      select bridge_key as key, is_admin as admin, owner_id::text as owner from workspaces`;
    expect(ws).toEqual([{ key: 'admin', admin: true, owner: users[0]!.id }]);
    const inAdmin = await su!<{ moderator: boolean }[]>`
      select u.moderator from workspace_users u join workspaces w on w.id = u.workspace_id
       where w.is_admin and u.login_id = ${users[0]!.id}`;
    expect(inAdmin).toEqual([{ moderator: true }]);
    // The switch's writes ran as the first owner's exit (the Team workspace
    // it made and removed, then Admin).
    const seen = await su!<{ key: string; actor: string }[]>`
      select bridge_key as key, actor from fsu_ws_actor order by bridge_key`;
    expect(seen.map((r) => r.key)).toContain('admin');
    expect([...new Set(seen.map((r) => r.actor))]).toEqual(['system:first-owner-attach']);
    // No miss on the way (vitest.setup.ts fails a test on any, too).
    const misses = await su!`select source, check_name, actor from actor_check_misses`;
    expect(misses).toEqual([]);
  });

  it('a second sign-up is refused, as on any brain with an owner (unchanged)', async () => {
    const out = await signup({ email: `again-${email}`, password });
    expect(out.status).toBe(403);
    expect(Number((await su!`select count(*) as n from auth.users`)[0]!.n)).toBe(1);
  });

  it('the boot`s switch on the switched brain changes nothing (unchanged)', async () => {
    const m = await import('@mantle/db');
    const wm = await import('../lib/workspaces-migrate');
    const before = await su!`select id, bridge_key from workspaces order by id`;
    await m.systemWork(() => wm.migrateWorkspacesQuietly('boot'), 'boot:migrate-workspaces');
    expect(await su!`select id, bridge_key from workspaces order by id`).toEqual(before);
    expect(await wm.unmigratedBrainReason()).toBeNull();
  });
});
