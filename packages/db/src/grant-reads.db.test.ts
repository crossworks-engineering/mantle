/**
 * "Does a workspace beyond Admin read this item" (sharedReadsSql, the grants
 * alone since W5b2 / 0261; any workspace beyond Admin since 0286, when Team
 * became a normal workspace), on a scratch database of its own. Checked:
 *
 *  - before the brain is migrated nothing reads as shared (no grants: fail
 *    closed), whatever the levels say;
 *  - after the switch every brain item answers from its grants (read_ws),
 *    and the levels mean nothing: a new item at 'team' is not shared; a
 *    personal-space row is, by its author's private workspace (W6b);
 *  - the switch keeps a Team that holds something as a normal workspace (no
 *    bridge_key, so mantle_brain_team_ws finds none);
 *  - the grant decides both ways, for Team and for any other workspace.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/grant-reads.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql as sqlTag } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sharedReadsAliasSql } from './grant-reads';
import { createMigratedScratchDatabase } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('grant reads: a workspace beyond Admin reads from the grants alone', () => {
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

  const reads = async (): Promise<Record<string, boolean>> => {
    const q = new PgDialect().sqlToQuery(sqlTag`
      select n.title, ${sharedReadsAliasSql('n')} as shared from nodes n order by n.title`);
    const rows = (await sql.unsafe(q.sql, q.params as never[])) as unknown as {
      title: string;
      shared: boolean;
    }[];
    return Object.fromEntries(rows.map((r) => [r.title, r.shared]));
  };
  const teamId = async () =>
    (
      await sql<{ id: string }[]>`select id::text as id from workspaces
        where owner_id = ${owner} and name = 'Team' and not is_admin`
    )[0]!.id;
  const grant = async (node_: string, ws: string, add: boolean) =>
    sql.begin(async (tx) => {
      await tx`select mantle_lock_heads(array[${node_}::uuid], 'update')`;
      if (add) {
        await tx`insert into item_grants (node_id, workspace_id, write) values (${node_}, ${ws}, false)`;
      } else {
        await tx`delete from item_grants where node_id = ${node_} and workspace_id = ${ws}`;
      }
    });

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

  it('before the migration: no grants, so nothing is shared (fail closed)', async () => {
    const r = await reads();
    expect(Object.keys(r).length).toBe(8);
    expect(Object.entries(r).filter(([, v]) => v)).toEqual([]);
  });

  it('after the switch: the grants, and levels mean nothing; Team is a normal workspace', async () => {
    const done = await sql<{ section: string }[]>`select * from mantle_ws_migrate()`;
    expect(done.filter((r) => r.section === 'reach-fail')).toEqual([]);
    // It holds the team items and the member: kept, with no built-in mark.
    const [t] = await sql<{ bridge_key: string | null; admin_moderated: boolean }[]>`
      select bridge_key, admin_moderated from workspaces where id = ${await teamId()}`;
    expect(t).toEqual({ bridge_key: null, admin_moderated: false });
    expect((await sql`select mantle_brain_team_ws() as t`)[0]!.t).toBeNull();
    expect(await reads()).toMatchObject({
      adminPage: false,
      teamPage: true,
      publicNote: true,
      email: false,
      // An embed never opens an app.
      embeddedApp: false,
      teamApp: true,
      adminApp: false,
      // A personal-space row: the spaces fold (W6b) homes it in its
      // author's private workspace, a workspace beyond Admin.
      draft: true,
    });
    // A new item at 'team' takes a home (Admin) and nothing from its level.
    await node('newTeamPage', owner, 'page', 'pages', 'team');
    expect((await reads()).newTeamPage).toBe(false);
  });

  it('the grant decides both ways, for Team and for any other workspace', async () => {
    const team = await teamId();
    await grant(ids.adminPage!, team, true);
    await grant(ids.teamPage!, team, false);
    expect(await reads()).toMatchObject({ adminPage: true, teamPage: false });
    const [other] = await sql<{ id: string }[]>`
      insert into workspaces (owner_id, name) values (${owner}, 'Projects') returning id::text as id`;
    await grant(ids.adminApp!, other!.id, true);
    expect((await reads()).adminApp).toBe(true);
    // An item Admin alone reads (its home) is not shared.
    const [e] = await sql<{ only_admin: boolean }[]>`
      select n.read_ws = array[w.id] as only_admin from nodes n, workspaces w
       where n.id = ${ids.email!} and w.owner_id = ${owner} and w.is_admin`;
    expect(e!.only_admin).toBe(true);
    expect((await reads()).email).toBe(false);
  });
});
