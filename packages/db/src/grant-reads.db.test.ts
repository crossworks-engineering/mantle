/**
 * Workspaces W5b2 (bridge off, migration 0261): "does the Team workspace
 * read this item" is the Team grant alone, on a scratch database of its own.
 * Checked:
 *
 *  - before the brain is migrated nothing reads as Team's (no Team: fail
 *    closed), whatever the levels say;
 *  - after the migration every brain item answers from its Team grant
 *    (read_ws), and the levels mean nothing: a new item at 'team' is not
 *    Team's, a personal-space row is not Team's (no grants until W6b);
 *  - the grant decides both ways; the Write switch is read the same way;
 *  - the system form (the row owner's Team) and the viewer form (the
 *    brain's Team, mantle_brain_team_ws) agree;
 *  - the workspace role may ask for the Team workspace (the level roles are
 *    retired since W8c and hold no right).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/grant-reads.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql as sqlTag, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { teamReadsAliasSql } from './grant-reads';
import { createMigratedScratchDatabase } from './test-support';
import { runInTurnScope } from './viewer';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Cmp = { id: string; title: string; sys: boolean; viewer: boolean; inws: boolean };

describe.skipIf(!URL)('grant reads (W5b2): Team reads from the grants alone', () => {
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
    shareLevel: string | null = null,
    embeddedLevel: string | null = null,
  ) => {
    const id = randomUUID();
    await sql`insert into nodes (id, owner_id, type, title, path, audience, share_level, embedded_level)
      values (${id}, ${owner_}, ${type}::node_type, ${key}, ${path}::ltree, ${audience},
              ${shareLevel}, ${embeddedLevel})`;
    ids[key] = id;
    return id;
  };

  /** Both forms of the helper, next to the plain "Team in read_ws". */
  const compare = async (): Promise<Cmp[]> => {
    // Built in a workspace scope (the viewer form); only the SQL is taken.
    const scope = { kind: 'assistant' as const, loginId: null, ws: [randomUUID()], modWs: [] };
    const viewerForm = await runInTurnScope(scope, async () => teamReadsAliasSql('n'));
    const q = new PgDialect().sqlToQuery(sqlTag`
      select n.id::text as id, n.title, ${teamReadsAliasSql('n')} as sys,
             ${viewerForm as SQL} as viewer,
             coalesce(mantle_brain_team_ws() = any(n.read_ws), false) as inws
        from nodes n order by n.title`);
    return (await sql.unsafe(q.sql, q.params as never[])) as unknown as Cmp[];
  };
  const reads = async () => Object.fromEntries((await compare()).map((r) => [r.title, r.sys]));

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
    await node('embeddedApp', owner, 'app', 'apps', 'admin', null, 'team');
    await node('teamApp', owner, 'app', 'apps', 'team');
    await node('adminApp', owner, 'app', 'apps', 'admin');
    await sql`insert into apps (node_id, source) values
      (${ids.embeddedApp!}, '{}'::jsonb), (${ids.teamApp!}, '{}'::jsonb),
      (${ids.adminApp!}, '{}'::jsonb)`;
    await node('draft', spaceA, 'page', 'pages', 'team');
  }, 180_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('before the migration: no Team, so nothing is Team’s (fail closed)', async () => {
    expect((await sql`select mantle_brain_team_ws() as t`)[0]!.t).toBeNull();
    const rows = await compare();
    expect(rows.length).toBe(8);
    expect(rows.filter((r) => r.sys || r.viewer).map((r) => r.title)).toEqual([]);
  });

  it('after the migration: the Team grant, in both forms, and levels mean nothing', async () => {
    const done = await sql<{ section: string }[]>`select * from mantle_ws_migrate()`;
    expect(done.filter((r) => r.section === 'reach-fail')).toEqual([]);
    const team = (await sql<{ t: string }[]>`select mantle_brain_team_ws()::text as t`)[0]!.t;
    expect(team).toMatch(/^[0-9a-f-]{36}$/);
    const rows = await compare();
    expect(rows.filter((r) => r.sys !== r.inws || r.viewer !== r.inws)).toEqual([]);
    expect(await reads()).toMatchObject({
      adminPage: false,
      teamPage: true,
      publicNote: true,
      email: false,
      // An embed never opens an app.
      embeddedApp: false,
      teamApp: true,
      adminApp: false,
      // A personal-space row: no grants until W6b.
      draft: false,
    });
    // A new item at 'team' takes a home (Admin) and nothing from its level.
    await node('newTeamPage', owner, 'page', 'pages', 'team');
    expect((await reads()).newTeamPage).toBe(false);
  });

  it('the grant decides both ways, and the Write switch reads the same', async () => {
    const team = (await sql<{ t: string }[]>`select mantle_brain_team_ws()::text as t`)[0]!.t;
    await sql.begin(async (tx) => {
      await tx`select mantle_lock_heads(array[${ids.adminPage!}::uuid, ${ids.teamPage!}::uuid], 'update')`;
      await tx`insert into item_grants (node_id, workspace_id, write)
               values (${ids.adminPage!}, ${team}, true)`;
      await tx`delete from item_grants where node_id = ${ids.teamPage!} and workspace_id = ${team}`;
    });
    expect(await reads()).toMatchObject({ adminPage: true, teamPage: false });
    const [w] = await sql<{ writes: boolean }[]>`
      select ${team}::uuid = any(write_ws) as writes from nodes where id = ${ids.adminPage!}`;
    expect(w!.writes).toBe(true);
  });

  it('the workspace role may ask for the Team workspace', async () => {
    for (const role of ['mantle_view_user']) {
      const t = await sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${role}`);
        return (await tx`select mantle_brain_team_ws() is not null as ok`)[0]!.ok;
      });
      expect([role, t]).toEqual([role, true]);
    }
  });
});
