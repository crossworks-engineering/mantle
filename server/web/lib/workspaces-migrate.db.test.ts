/**
 * Workspaces W5b1 fix round 1 (audit M1): a fresh install is put on
 * workspaces when its first owner signs up, and at boot; a box with client
 * logins (one from before 0272, which ends the client role) is still skipped
 * (owner rule 21.9), and the integrity row says why.
 * Since W5b2 (0261) the migration ends with plain grants (no bridge) and the
 * boot step repairs nothing: an item left without a home is what
 * workspaces:check counts. Own scratch databases (the migration writes
 * brain-wide rows).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/workspaces-migrate.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Ts = typeof import('@mantle/db/test-support');

describe.skipIf(!URL)('workspaces for a fresh install (W5b1 audit M1)', () => {
  const made: Array<{ drop: () => Promise<void> }> = [];
  const clients: Array<ReturnType<typeof postgres>> = [];
  const urls: string[] = [];

  afterAll(async () => {
    const m = await import('@mantle/db');
    await m.closeDb().catch(() => {});
    for (const c of clients) await c.end().catch(() => {});
    for (const s of made) await s.drop().catch(() => {});
    // Several scratch databases to drop: each DROP DATABASE checkpoints, slow
    // under a full suite.
  }, 120_000);

  /** A scratch brain, fully migrated, or stopped before the migration
   *  `before` names. */
  async function brain(before?: string) {
    const ts: Ts = await import('@mantle/db/test-support');
    const scratch = before
      ? await ts.createScratchDatabaseBefore(URL!, before)
      : await ts.createMigratedScratchDatabase(URL!);
    made.push(scratch);
    urls.push(scratch.url);
    const sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    clients.push(sql);
    return { scratch, sql };
  }

  it('the first owner gets Admin (no Team since 0286), plain grants and a home for every item; a second run and a boot change nothing', async () => {
    const { scratch, sql } = await brain();
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET ??= 'workspaces-migrate-db-test-secret-32-chars';
    expect((await sql`select mantle_ws_skip_reason() as r`)[0]!.r).toBe('no brain anchor yet');

    const { createFirstOwner } = await import('./auth/first-owner');
    // The signup's attach runs in the new owner's own scope (0307): it must
    // not fail (a failure is only logged).
    const errors = vi.spyOn(console, 'error');
    const res = await createFirstOwner('owner@example.invalid', 'a long enough password 1');
    expect(res.ok).toBe(true);
    expect(errors.mock.calls.filter((c) => String(c[0]).includes('[workspaces]'))).toEqual([]);
    errors.mockRestore();
    const owner = (res as { id: string }).id;

    // A new brain has no Team workspace (owner decision 2026-10-13): the
    // switch made one, found it held nothing, and removed it with its events.
    const ws = await sql<{ key: string; admin: boolean }[]>`
      select bridge_key as key, is_admin as admin from workspaces order by bridge_key`;
    expect(ws).toEqual([{ key: 'admin', admin: true }]);
    expect(
      Number(
        (await sql`select count(*) as n from workspace_events where workspace_id is null`)[0]!.n,
      ),
    ).toBe(0);
    const users = await sql<{ key: string }[]>`
      select w.bridge_key as key from workspace_users u join workspaces w on w.id = u.workspace_id
       where u.login_id = ${owner} order by 1`;
    expect(users.map((u) => u.key)).toContain('admin');
    expect((await sql`select mantle_ws_skip_reason() as r`)[0]!.r).toBeNull();

    // No bridge: a new page gets its home in Admin and nothing more, whatever
    // level the insert names.
    const page = randomUUID();
    await sql`insert into nodes (id, owner_id, type, title, path, audience)
      values (${page}, ${owner}, 'page', 'p', 'pages'::ltree, 'team')`;
    const g = await sql<{ key: string; home: boolean }[]>`
      select w.bridge_key as key, g.is_home as home from item_grants g
        join workspaces w on w.id = g.workspace_id
       where g.node_id = ${page}`;
    expect(g).toEqual([{ key: 'admin', home: true }]);
    expect(Number((await sql`select count(*) as n from item_grants where bridge`)[0]!.n)).toBe(0);
    const { runWorkspacesCheck } = await import('@mantle/db');
    expect(await runWorkspacesCheck()).toMatchObject({
      migrated: true,
      grantDrift: 0,
      orphanGrants: 0,
      itemsWithoutHome: 0,
    });

    // Idempotent: the boot step finds it migrated, writes nothing.
    const wm = await import('./workspaces-migrate');
    const { systemWork } = await import('@mantle/db');
    // The boot's form: workspace system work (systemWork, server/main.ts).
    const boot = <T>(fn: () => Promise<T>) => systemWork(fn, 'boot:migrate-workspaces');
    const again = await wm.migrateWorkspaces();
    expect(again).toEqual([
      { section: 'skip', subject: 'workspaces', metric: 'already migrated', n: 1 },
    ]);
    expect(Number((await sql`select count(*) as n from workspaces`)[0]!.n)).toBe(1);

    // Fix round 2, M-new: onboarding makes the assistants after the signup
    // migrated the brain; the step after the manifest seed attaches them.
    const assistants = async () =>
      sql<{ key: string; slug: string }[]>`
        select w.bridge_key as key, a.slug from workspace_resources r
          join workspaces w on w.id = r.workspace_id
          join agents a on a.id::text = r.ref_id
         where r.type = 'assistant' order by 1`;
    expect(await assistants()).toEqual([]);
    // As onboarding leaves it: the OpenRouter key, then the manifest seed.
    await sql`insert into api_keys (id, user_id, service, label, key_enc)
      values (${randomUUID()}, ${owner}, 'openrouter', 'default', '\\x00'::bytea)`;
    const seed = await import('./system-manifest/seed');
    await seed.applyManifest(owner);
    await sql`insert into agents (owner_id, slug, name, role, audience, model, system_prompt)
      values (${owner}, 'persona-test', 'Persona', 'responder', 'admin', 'test/model', 'p')`;
    // The persona goes on Admin. The team responder ships closed (admin
    // level): 0251 attaches it only at team level, and an admin-level
    // assistant on Team would bring admin-level tools into Team turns.
    // Onboarding's form: in the owner's own scope (the assistants area). With
    // no acting login and no system work it is refused (0307).
    await expect(wm.attachDefaultAssistants()).rejects.toThrow();
    expect(await wm.attachDefaultAssistants(owner)).toBe(1);
    expect(await assistants()).toEqual([{ key: 'admin', slug: 'persona-test' }]);
    // A brain whose admin opened it before W7b (levels are frozen since
    // 0268, so the fixture sets it past the freeze): with no Team (0286),
    // the attach puts it nowhere; an Admin user attaches it to a workspace.
    const [tr] = await sql<{ id: string }[]>`
      select id from agents where owner_id = ${owner} and slug = 'team-responder'`;
    const setLevel = (level: string) =>
      sql.begin(async (tx) => {
        await tx`select mantle_heads_bypass('test fixture')`;
        await tx`update agents set audience = ${level} where id = ${tr!.id}`;
      });
    await setLevel('team');
    expect(await boot(() => wm.attachDefaultAssistants())).toBe(0);
    expect(await assistants()).toEqual([{ key: 'admin', slug: 'persona-test' }]);
    // Each attach is logged on its workspace (audit nit).
    expect(
      await sql`
        select w.bridge_key as key, e.subject->>'by' as by from workspace_events e
          join workspaces w on w.id = e.workspace_id
         where e.action = 'resource.add' order by 1`,
    ).toEqual([{ key: 'admin', by: 'attach' }]);
    // A boot changes nothing either.
    await boot(() => wm.migrateWorkspacesQuietly('boot'));
    expect(await assistants()).toEqual([{ key: 'admin', slug: 'persona-test' }]);
    await setLevel('admin');

    // No boot repair (W5b2): an item that lost its grants stays as it is,
    // and the check counts it.
    await sql.begin(async (tx) => {
      await tx`select mantle_lock_heads(array[${page}::uuid], 'update')`;
      await tx`delete from item_grants where node_id = ${page}`;
    });
    await boot(() => wm.migrateWorkspacesQuietly('boot'));
    expect(
      Number((await sql`select count(*) as n from item_grants where node_id = ${page}`)[0]!.n),
    ).toBe(0);
    expect(await runWorkspacesCheck()).toMatchObject({ itemsWithoutHome: 1, grantDrift: 0 });
  });

  it('fix round 2, L-a: an item made while the migration runs is left without a home, and counted', async () => {
    const { sql } = await brain();
    const owner = randomUUID();
    await sql`insert into auth.users (id, email, password_hash, role, is_owner) values
      (${owner}, 'o3@example.invalid', 'x', 'admin', true)`;
    const page = randomUUID();
    const other = postgres(urls.at(-1)!, { max: 1, prepare: false, onnotice: () => {} });
    clients.push(other);
    // Another transaction inserts a team page and has not committed when the
    // migration runs: the migration cannot see it, its trigger saw no
    // workspaces.
    const reserved = await other.reserve();
    await reserved`begin`;
    await reserved`insert into nodes (id, owner_id, type, title, path, audience)
      values (${page}, ${owner}, 'page', 'late', 'pages'::ltree, 'team')`;
    const rows = await sql<{ section: string }[]>`select * from mantle_ws_migrate_locked()`;
    expect(rows.filter((r) => r.section === 'reach-fail')).toEqual([]);
    await reserved`commit`;
    reserved.release();
    const grants = async () =>
      Number((await sql`select count(*) as n from item_grants where node_id = ${page}`)[0]!.n);
    expect(await grants()).toBe(0);
    // The drift repair is gone (0261): nothing gives it grants behind the
    // owner's back. workspaces:check counts it; the owner homes it by hand.
    expect(Number((await sql`select mantle_ws_repair_drift() as n`)[0]!.n)).toBe(0);
    expect(await grants()).toBe(0);
    const { WORKSPACES_CHECK_SQL, parseWorkspacesCheck } = await import('@mantle/db');
    const c = parseWorkspacesCheck((await sql.unsafe(WORKSPACES_CHECK_SQL))[0] as never);
    expect(c).toMatchObject({ itemsWithoutHome: 1, grantDrift: 0, orphanGrants: 0 });
  });

  it('fix round 2, L-b: the locked migration waits at most 10 s for a lock', async () => {
    const { sql } = await brain();
    const [r] = await sql<{ cfg: string[] }[]>`
      select proconfig as cfg from pg_proc where proname = 'mantle_ws_migrate_locked'`;
    expect(r!.cfg).toContain('lock_timeout=10s');
  });

  it('a box with a client login is skipped, and the integrity row says clients are present', async () => {
    // A box before W8a: 0272 turns every client login into a member and the
    // role CHECK admits none after it.
    const { sql } = await brain('0272_workspaces_logins_carry_nothing');
    const owner = randomUUID();
    await sql`insert into auth.users (id, email, password_hash, role, is_owner) values
      (${owner}, 'o2@example.invalid', 'x', 'admin', true),
      (${randomUUID()}, 'c2@example.invalid', 'x', 'client', false)`;
    expect((await sql`select mantle_ws_skip_reason() as r`)[0]!.r).toBe(
      'clients present: 1 client login(s), 0 client-level item(s)',
    );
    const rows = await sql<
      { section: string; subject: string }[]
    >`select * from mantle_ws_migrate_locked()`;
    expect(rows.map((r) => [r.section, r.subject])).toEqual([
      ['skip', 'clients present: 1 client login(s), 0 client-level item(s)'],
    ]);
    expect(Number((await sql`select count(*) as n from workspaces`)[0]!.n)).toBe(0);
  });
});
