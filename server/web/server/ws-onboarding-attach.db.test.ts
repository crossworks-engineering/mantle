/**
 * Onboarding's assistant attach through the real entry (plan v3.2 S2a
 * a1+a2, audit L2): POST /api/onboarding {action: 'provision'} on the real
 * app (createApp), with signed session cookies, on a migrated scratch
 * database. provision() runs provisionDefaults, which attaches the default
 * assistants (mantle_ws_attach_assistants, 0307) in the scope of the login
 * running the step (systemPoolTxInScope): the definer asks that login the
 * assistants area.
 *
 *  - an Admin user with the settings area but WITHOUT the assistants area
 *    runs the step: 200, the attach is refused (resources_admin_only), only
 *    logged, and nothing is attached (the next boot's system work attaches);
 *  - an Admin user with both areas runs it: the persona goes on Admin, its
 *    row and event as the attach writes them (no added_by, no event actor,
 *    `by: attach`).
 *
 * In the runtime role subset (CI's test:runtime-role paths match /ws-, and
 * the workstation runs the whole config): with MANTLE_DB_RUNTIME_ROLE on,
 * the app's system pool is mantle_runtime, checked here.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test:runtime-role server/web/server/ws-onboarding-attach.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('onboarding attaches the assistants in the login`s scope (provision)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let app: import('hono').Hono;
  let cookieOf: (id: string) => string;
  let dir = '';
  let adminWs = '';
  const owner = randomUUID(); // the anchor
  const adm = randomUUID(); // an Admin user, every area
  const noAsst = randomUUID(); // an Admin user, the assistants area off
  const persona = randomUUID(); // the persona onboarding would have made
  const tag = `woa${randomUUID().slice(0, 6)}`;

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const email = (who: string) => `${tag}-${who}@example.invalid`;
  const provision = async (as: string) => {
    const res = await app.request('/api/onboarding', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieOf(as) },
      body: JSON.stringify({ action: 'provision' }),
    });
    return { status: res.status, text: await res.text() };
  };
  const onAdmin = async () => ({
    res: await x<{ ref: string; write: boolean; added_by: string | null }>(sql`
      select ref_id as ref, write, added_by from workspace_resources
       where workspace_id = ${adminWs} and type = 'assistant'`),
    ev: await x<{ actor: string | null; subject: Record<string, unknown> }>(sql`
      select actor_id as actor, subject from workspace_events
       where workspace_id = ${adminWs} and action = 'resource.add'`),
  });

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'ws-onboarding-attach-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'ws-onboarding-attach-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${email('owner')}, 'x', true, 'admin', 'Olive Owner'),
      (${adm}, ${email('adm')}, 'x', false, 'admin', 'Ada Admin'),
      (${noAsst}, ${email('noasst')}, 'x', false, 'admin', 'Nia Admin')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
    const [a] = await x<{ id: string }>(sql`
      select id::text as id from workspaces where owner_id = ${owner} and is_admin`);
    adminWs = a!.id;
    // The fixtures write the four tables as the superuser (never through a
    // definer, never the runtime role).
    const su = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    try {
      await su`update workspace_users set limits = ${su.json({ areas: { assistants: false } })}
                where workspace_id = ${adminWs} and login_id = ${noAsst}`;
    } finally {
      await su.end();
    }
    // The persona onboarding makes when a key is saved (none here, so the
    // step makes no agent): an enabled admin-level responder on no
    // workspace, the one the attach picks for Admin.
    await x(sql`insert into agents (id, owner_id, slug, name, model, system_prompt, role, audience, enabled, priority)
                values (${persona}, ${owner}, ${`${tag}-persona`}, 'P', 'm', 'p', 'responder', 'admin', true, 1000)`);
    const tokens = await import('../lib/auth/tokens');
    cookieOf = (id) => `mantle_session=${tokens.buildSessionCookie(id).value}`;
    const { createApp } = await import('./app');
    app = await createApp();
  }, 240_000);

  afterAll(async () => {
    await (await import('../lib/audit')).auditsSettled();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('the app`s system pool is the runtime role when the config turns it on', async () => {
    const role = await m.systemPoolRole();
    if (process.env.MANTLE_DB_RUNTIME_ROLE === '1') {
      expect(role?.user).toBe(m.RUNTIME_ROLE);
      expect(role?.superuser).toBe(false);
    } else {
      expect(role).not.toBeNull();
    }
  });

  it('an Admin user without the assistants area: the step answers, the attach is refused and logged, nothing attached', async () => {
    expect(await onAdmin()).toEqual({ res: [], ev: [] });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const out = await provision(noAsst);
      expect(out.status, out.text.slice(0, 300)).toBe(200);
      const logged = errors.mock.calls
        .map((c) => c.map(String).join(' '))
        .filter((l) => l.includes('[workspaces] onboarding'));
      // The one failure line (failure() logs the wrapped query's message,
      // not the definer's code; the refusal itself is the 0307 cell
      // "the assistant attach").
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatch(/failed/);
    } finally {
      errors.mockRestore();
    }
    expect(await onAdmin()).toEqual({ res: [], ev: [] });
  });

  it('an Admin user with the assistants area: the persona goes on Admin as the attach writes it', async () => {
    const errors = vi.spyOn(console, 'error');
    try {
      const out = await provision(adm);
      expect(out.status, out.text.slice(0, 300)).toBe(200);
      expect(
        errors.mock.calls.filter((c) => String(c[0]).includes('[workspaces] onboarding')),
      ).toEqual([]);
    } finally {
      errors.mockRestore();
    }
    expect(await onAdmin()).toEqual({
      res: [{ ref: persona, write: true, added_by: null }],
      ev: [{ actor: null, subject: { kind: 'assistant', id: persona, by: 'attach' } }],
    });
  });
});
