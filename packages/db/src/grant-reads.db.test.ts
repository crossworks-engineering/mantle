/**
 * Workspaces W5b1 (migration 0256): "does the Team workspace read this item"
 * from the grants, on a scratch database of its own. Checked:
 *
 *  - before the brain is migrated, and for personal-space rows after, the
 *    answer is the team role's level rule (the fallback);
 *  - after the migration, every brain item answers from its Team grant, and
 *    that answer equals the level rule while the bridge runs (behaviour
 *    unchanged, plan S2);
 *  - the grant wins when the two disagree (the function reads read_ws);
 *  - the level roles and the workspace role may call it.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/grant-reads.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql as sqlTag } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { teamReadsAliasSql } from './grant-reads';
import { createMigratedScratchDatabase } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Cmp = { id: string; title: string; grant: boolean; level: boolean; home: string | null };

describe.skipIf(!URL)('grant reads (0256): Team reads from the grants', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let sql: ReturnType<typeof postgres>;
  const owner = randomUUID();
  const member = randomUUID();
  const ids: Record<string, string> = {};

  const node = async (
    key: string,
    owner_: string,
    type: string,
    path: string,
    audience = 'admin',
  ) => {
    const id = randomUUID();
    await sql`insert into nodes (id, owner_id, type, title, path, audience)
      values (${id}, ${owner_}, ${type}::node_type, ${key}, ${path}::ltree, ${audience})`;
    ids[key] = id;
    return id;
  };

  /** The helper's SQL next to the level rule it replaces, for every node. */
  const compare = async (): Promise<Cmp[]> => {
    const q = new PgDialect().sqlToQuery(sqlTag`
      select n.id::text as id, n.title, ${teamReadsAliasSql('n')} as grant,
             mantle_team_reads(n.type, n.audience, n.inherited_level,
               case when n.type = 'app' then null else n.embedded_level end) as level,
             n.home_ws::text as home
        from nodes n order by n.title`);
    return (await sql.unsafe(q.sql, q.params as never[])) as unknown as Cmp[];
  };

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    sql = postgres(scratch.url, { max: 3, prepare: false, onnotice: () => {} });
    await sql`insert into auth.users (id, email, password_hash, role, is_owner) values
      (${owner}, 'o@example.invalid', 'x', 'admin', true),
      (${member}, 'm@example.invalid', 'x', 'member', false)`;
    const spaceA = (
      await sql<
        { id: string }[]
      >`select id from spaces where kind = 'personal' and login_id = ${member}`
    )[0]!.id;
    await node('adminPage', owner, 'page', 'pages', 'admin');
    await node('teamPage', owner, 'page', 'pages', 'team');
    await node('publicNote', owner, 'note', 'notes', 'public');
    await node('email', owner, 'email', 'emails', 'admin');
    const folder = await node('folder', owner, 'branch', 'pages.shared', 'admin');
    await sql`update nodes set share_level = 'team' where id = ${folder}`;
    await node('inFolder', owner, 'page', 'pages.shared', 'admin');
    await node('embeddedPage', owner, 'page', 'pages', 'admin');
    await node('embeddedApp', owner, 'app', 'apps', 'admin');
    await sql`update nodes set embedded_level = 'team'
               where id in (${ids.embeddedPage!}, ${ids.embeddedApp!})`;
    await node('teamApp', owner, 'app', 'apps', 'team');
    await node('publicApp', owner, 'app', 'apps', 'public');
    await node('adminApp', owner, 'app', 'apps', 'admin');
    await sql`insert into apps (node_id, source) values
      (${ids.embeddedApp!}, '{}'::jsonb), (${ids.teamApp!}, '{}'::jsonb),
      (${ids.publicApp!}, '{}'::jsonb), (${ids.adminApp!}, '{}'::jsonb)`;
    await node('draft', spaceA, 'page', 'pages', 'team');
  }, 180_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('before the migration: the level rule, for every row', async () => {
    expect((await sql`select mantle_brain_team_ws() as t`)[0]!.t).toBeNull();
    const rows = await compare();
    expect(rows.length).toBe(12);
    expect(rows.filter((r) => r.grant !== r.level).map((r) => r.title)).toEqual([]);
    const byTitle = Object.fromEntries(rows.map((r) => [r.title, r.grant]));
    expect(byTitle).toMatchObject({
      adminPage: false,
      teamPage: true,
      publicNote: true,
      email: false,
      inFolder: true,
      embeddedPage: true,
      embeddedApp: false,
      teamApp: true,
      publicApp: true,
      adminApp: false,
      draft: true,
    });
  });

  it('after the migration: the Team grant, equal to the level rule while the bridge runs', async () => {
    const done = await sql<{ section: string }[]>`select * from mantle_ws_migrate()`;
    expect(done.filter((r) => r.section === 'reach-fail')).toEqual([]);
    const team = (await sql<{ t: string }[]>`select mantle_brain_team_ws()::text as t`)[0]!.t;
    expect(team).toMatch(/^[0-9a-f-]{36}$/);
    const rows = await compare();
    expect(rows.filter((r) => r.grant !== r.level).map((r) => r.title)).toEqual([]);
    // Brain items answer from their grants; the personal draft keeps the
    // level rule (no grants until W6b).
    const grantPath = await sql<{ title: string; inws: boolean }[]>`
      select n.title, ${team}::uuid = any(n.read_ws) as inws from nodes n
       where n.home_ws is not null order by n.title`;
    const byTitle = Object.fromEntries(rows.map((r) => [r.title, r.grant]));
    for (const g of grantPath) expect([g.title, byTitle[g.title]]).toEqual([g.title, g.inws]);
    expect(rows.find((r) => r.title === 'draft')).toMatchObject({ home: null, grant: true });
  });

  it('the grant wins over the levels when they disagree', async () => {
    const team = (await sql<{ t: string }[]>`select mantle_brain_team_ws()::text as t`)[0]!.t;
    const home = randomUUID();
    const [r] = await sql<{ granted: boolean; removed: boolean; fallback: boolean }[]>`
      select mantle_item_team_reads(array[${team}::uuid], ${home}::uuid, 'page', 'admin', null, null, ${team}::uuid) as granted,
             mantle_item_team_reads('{}'::uuid[], ${home}::uuid, 'page', 'team', 'team', 'team', ${team}::uuid) as removed,
             mantle_item_team_reads('{}'::uuid[], null, 'page', 'team', null, null, ${team}::uuid) as fallback`;
    expect(r).toEqual({ granted: true, removed: false, fallback: true });
  });

  it('the level roles and the workspace role may ask for the Team workspace', async () => {
    for (const role of [
      'mantle_view_team',
      'mantle_view_client',
      'mantle_view_public',
      'mantle_view_space',
      'mantle_view_user',
    ]) {
      const t = await sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${role}`);
        return (await tx`select mantle_brain_team_ws() is not null as ok`)[0]!.ok;
      });
      expect([role, t]).toEqual([role, true]);
    }
  });
});
