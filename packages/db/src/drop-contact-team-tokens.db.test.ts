/**
 * Migration 0178 (member logins Phase 6) on a real, migrated Postgres: the
 * retired team codes' table (contact_team_tokens) is dropped and nothing
 * else is touched.
 *
 * The migrated database already ran 0178, so the test first proves the table
 * is gone, then puts it back from its own migration (0112, IF NOT EXISTS),
 * reads its foreign keys from the catalog, seeds a team code next to the rows
 * that must survive (its contact, a member login linked to it, an invite, the
 * contact's old portal chat and access log, an app with its node, a sandbox)
 * and runs 0178's statements again. It proves: the foreign keys are the one
 * the migration names; an unexpected dependency (a view) fails the drop
 * instead of being dropped with the table (no CASCADE); the table goes and
 * every other row stays, with the same counts; a second run is a no-op.
 *
 * The seeded rows are left in place (the test database is throwaway, and
 * apps, app nodes and sandboxes are never deleted, not even by a test).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/drop-contact-team-tokens.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const MIGRATIONS = join(__dirname, '..', 'migrations');

const statementsOf = (file: string) =>
  readFileSync(join(MIGRATIONS, file), 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);

type Row = Record<string, unknown>;

describe.skipIf(!URL)('migration 0178: drop contact_team_tokens', () => {
  let sql: ReturnType<typeof postgres>;
  let goneAfterMigrate = false;
  const owner = randomUUID();
  const tag = `drop-codes-${owner.slice(0, 8)}`;
  const id = {
    contact: randomUUID(),
    member: randomUUID(),
    invite: randomUUID(),
    appNode: randomUUID(),
    sandbox: randomUUID(),
    teamMessage: randomUUID(),
    access: randomUUID(),
    teamToken: randomUUID(),
  };

  const drop = statementsOf('0178_drop_contact_team_tokens.sql');
  const runDrop = async (tx: postgres.Sql | postgres.TransactionSql = sql) => {
    for (const stmt of drop) await tx.unsafe(stmt);
  };
  const tablePresent = async () => {
    const [r] = await sql<{ t: string | null }[]>`
      select to_regclass('public.contact_team_tokens')::text as t`;
    return r!.t !== null;
  };
  /** Every count the drop must leave alone, for the seeded brain (other test
   *  files write rows brain-wide while this one runs). */
  const counts = async () => {
    const [r] = await sql<Row[]>`
      select (select count(*) from nodes where owner_id = ${owner})::int as nodes,
             (select count(*) from nodes where owner_id = ${owner} and type = 'contact')::int as contacts,
             (select count(*) from nodes where owner_id = ${owner} and type = 'app')::int as app_nodes,
             (select count(*) from apps a join nodes n on n.id = a.node_id
               where n.owner_id = ${owner})::int as apps,
             (select count(*) from sandboxes where owner_id = ${owner})::int as sandboxes,
             (select count(*) from team_messages where owner_id = ${owner})::int as team_messages,
             (select count(*) from team_access_log where owner_id = ${owner})::int as team_access_log,
             (select count(*) from member_invites where owner_id = ${owner})::int as member_invites,
             (select count(*) from auth.users where id in (${owner}, ${id.member}))::int as users`;
    return r!;
  };

  beforeAll(async () => {
    sql = postgres(URL!, { max: 1, onnotice: () => {} });
    // The migration drop tests rebuild tables that reference nodes (ALTER
    // TABLE ... ADD FOREIGN KEY locks nodes); two of them at once deadlock.
    // One session lock, shared by every such test, runs them one at a time;
    // sql.end() releases it.
    await sql`select pg_advisory_lock(hashtext('mantle-migration-drop-tests'))`;
    goneAfterMigrate = !(await tablePresent());
    // The table as the team codes had it.
    for (const stmt of statementsOf('0112_contact_team_tokens.sql')) await sql.unsafe(stmt);

    await sql`insert into auth.users (id, email, password_hash, role)
              values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`;
    await sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`;
    await sql`insert into nodes (id, owner_id, type, title, path, data) values
      (${id.contact}, ${owner}, 'contact', 'A member', 'contacts', '{}'::jsonb),
      (${id.appNode}, ${owner}, 'app', 'An app', 'apps', '{}'::jsonb)`;
    await sql`insert into auth.users (id, email, password_hash, role, contact_id)
              values (${id.member}, ${`member-${tag}@example.invalid`}, 'x', 'member', ${id.contact})`;
    await sql`insert into member_invites (id, owner_id, contact_id, email, code_hash, expires_at)
              values (${id.invite}, ${owner}, ${id.contact}, ${`invite-${tag}@example.invalid`},
                      ${`invite-${tag}`}, now() + interval '1 hour')`;
    await sql`insert into apps (node_id) values (${id.appNode})`;
    await sql`insert into sandboxes (id, owner_id, name, image)
              values (${id.sandbox}, ${owner}, ${tag}, 'alpine')`;
    await sql`insert into team_messages (id, owner_id, contact_id, direction, text)
              values (${id.teamMessage}, ${owner}, ${id.contact}, 'inbound', 'old portal chat')`;
    await sql`insert into team_access_log (id, owner_id, contact_id, kind, detail)
              values (${id.access}, ${owner}, ${id.contact}, 'auth', '{}'::jsonb)`;
    await sql`insert into contact_team_tokens (id, owner_id, contact_id, token_hash)
              values (${id.teamToken}, ${owner}, ${id.contact}, ${`hash-${tag}`})`;
  }, 60_000);

  afterAll(async () => {
    // Leave no code table behind if a test failed midway.
    await runDrop();
    await sql.end();
  });

  it('the migrated database has no contact_team_tokens', () => {
    expect(goneAfterMigrate).toBe(true);
  });

  it('has exactly the foreign key the migration names: contact_id to nodes, CASCADE', async () => {
    const fks = await sql<Row[]>`
      select conname as name, conrelid::regclass::text as on_table,
             confrelid::regclass::text as references, confdeltype as on_delete
        from pg_constraint
       where contype = 'f'
         and (conrelid = 'public.contact_team_tokens'::regclass
              or confrelid = 'public.contact_team_tokens'::regclass)
       order by conname`;
    expect(fks).toEqual([
      {
        name: 'contact_team_tokens_contact_id_fkey',
        on_table: 'contact_team_tokens',
        references: 'nodes',
        on_delete: 'c',
      },
    ]);
    // The SQL itself, comments aside: the FK by name, and no CASCADE.
    const code = drop
      .join('\n')
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(code).toContain('DROP CONSTRAINT IF EXISTS "contact_team_tokens_contact_id_fkey"');
    expect(code).toContain('DROP TABLE IF EXISTS "contact_team_tokens"');
    expect(code).not.toMatch(/cascade/i);
  });

  it('fails on a dependency it does not know about instead of dropping it (no CASCADE)', async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe(
          `create view contact_team_tokens_probe_v as select id from contact_team_tokens`,
        );
        await runDrop(tx);
      }),
    ).rejects.toThrow(/depend/);
    // Rolled back: the table and nothing else is as it was.
    expect(await tablePresent()).toBe(true);
    const [v] = await sql`select to_regclass('public.contact_team_tokens_probe_v') as v`;
    expect(v!.v).toBeNull();
  });

  it('drops the table and leaves every other row, with the same counts', async () => {
    const before = await counts();
    expect(before).toEqual({
      nodes: 2,
      contacts: 1,
      app_nodes: 1,
      apps: 1,
      sandboxes: 1,
      team_messages: 1,
      team_access_log: 1,
      member_invites: 1,
      users: 2,
    });
    await runDrop();

    expect(await tablePresent()).toBe(false);
    const leftovers = await sql`
      select relname as name from pg_class where relname like 'contact\\_team\\_tokens%'
      union all
      select conname from pg_constraint where conname like 'contact\\_team\\_tokens%'`;
    expect(leftovers).toEqual([]);

    expect(await counts()).toEqual(before);
    expect(
      await sql`select 1 from nodes where id = ${id.contact} and type = 'contact'`,
    ).toHaveLength(1);
    expect(
      await sql`select 1 from auth.users where id = ${id.member} and contact_id = ${id.contact}`,
    ).toHaveLength(1);
    expect(await sql`select 1 from member_invites where id = ${id.invite}`).toHaveLength(1);
    expect(await sql`select 1 from team_messages where id = ${id.teamMessage}`).toHaveLength(1);
    expect(await sql`select 1 from team_access_log where id = ${id.access}`).toHaveLength(1);
    expect(await sql`select 1 from apps where node_id = ${id.appNode}`).toHaveLength(1);
    expect(await sql`select 1 from sandboxes where id = ${id.sandbox}`).toHaveLength(1);
  });

  it('a second run is a no-op', async () => {
    const before = await counts();
    await expect(runDrop()).resolves.toBeUndefined();
    expect(await tablePresent()).toBe(false);
    expect(await counts()).toEqual(before);
  });
});
