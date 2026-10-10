/**
 * Workspaces W5b1 fix round 1 (audit M1): a fresh install is put on
 * workspaces when its first owner signs up, and at boot; a box with client
 * logins is still skipped (owner rule 21.9), and the integrity row says why.
 * Own scratch databases (the migration writes brain-wide rows).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/workspaces-migrate.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Ts = typeof import('@mantle/db/test-support');

describe.skipIf(!URL)('workspaces for a fresh install (W5b1 audit M1)', () => {
  const made: Array<{ drop: () => Promise<void> }> = [];
  const clients: Array<ReturnType<typeof postgres>> = [];

  afterAll(async () => {
    const m = await import('@mantle/db');
    await m.closeDb().catch(() => {});
    for (const c of clients) await c.end().catch(() => {});
    for (const s of made) await s.drop().catch(() => {});
  });

  async function brain() {
    const ts: Ts = await import('@mantle/db/test-support');
    const scratch = await ts.createMigratedScratchDatabase(URL!);
    made.push(scratch);
    const sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    clients.push(sql);
    return { scratch, sql };
  }

  it('the first owner gets Admin, Team and the bridges, with no drift; a second run and a boot change nothing', async () => {
    const { scratch, sql } = await brain();
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET ??= 'workspaces-migrate-db-test-secret-32-chars';
    expect((await sql`select mantle_ws_skip_reason() as r`)[0]!.r).toBe('no brain anchor yet');

    const { createFirstOwner } = await import('./auth/first-owner');
    const res = await createFirstOwner('owner@example.invalid', 'a long enough password 1');
    expect(res.ok).toBe(true);
    const owner = (res as { id: string }).id;

    const ws = await sql<{ key: string; admin: boolean }[]>`
      select bridge_key as key, is_admin as admin from workspaces order by bridge_key`;
    expect(ws).toEqual([
      { key: 'admin', admin: true },
      { key: 'team', admin: false },
    ]);
    const users = await sql<{ key: string }[]>`
      select w.bridge_key as key from workspace_users u join workspaces w on w.id = u.workspace_id
       where u.login_id = ${owner} order by 1`;
    expect(users.map((u) => u.key)).toContain('admin');
    expect((await sql`select mantle_ws_skip_reason() as r`)[0]!.r).toBeNull();

    // The bridges run: a new team page gets its Team grant at once.
    const page = randomUUID();
    await sql`insert into nodes (id, owner_id, type, title, path, audience)
      values (${page}, ${owner}, 'page', 'p', 'pages'::ltree, 'team')`;
    const [g] = await sql<{ n: number }[]>`
      select count(*)::int as n from item_grants g join workspaces w on w.id = g.workspace_id
       where g.node_id = ${page} and w.bridge_key = 'team'`;
    expect(g!.n).toBe(1);
    expect(Number((await sql`select mantle_bridge_drift() as d`)[0]!.d)).toBe(0);
    expect(await sql`select * from mantle_ws_reach_diff() where section = 'reach-fail'`).toEqual(
      [],
    );

    // Idempotent: the boot step finds it migrated, writes nothing.
    const { migrateWorkspaces } = await import('./workspaces-migrate');
    const again = await migrateWorkspaces();
    expect(again).toEqual([
      { section: 'skip', subject: 'workspaces', metric: 'already migrated', n: 1 },
    ]);
    expect(Number((await sql`select count(*) as n from workspaces`)[0]!.n)).toBe(2);
  });

  it('a box with a client login is skipped, and the integrity row says clients are present', async () => {
    const { sql } = await brain();
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
