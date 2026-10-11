/**
 * 0269's fold of a team row whose agent was deleted, on a brain whose Team
 * workspace has no assistant (W7 integration fix 2): the row lands in the
 * Team bridge workspace, never in none (a row with no workspace reads as
 * Admin's, and its member would lose it). A second run of 0269 also moves a
 * row an earlier run folded with no workspace, its agent gone or still there
 * (W7 integration fix 3, L6).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/workspaces-user-threads-orphan.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql as dsql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDatabaseBefore, ensureTestViewerRoles } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const TAG = '0269_workspaces_user_threads';

describe.skipIf(!URL)('0269: an orphaned team row folds into the Team workspace', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>>;
  let sql: ReturnType<typeof postgres>;
  let m: typeof import('./index');
  const owner = randomUUID();
  const member = randomUUID();
  const gone = randomUUID();
  const row = randomUUID();
  // L6 (W7 integration fix 3): a row whose agent is still there, with no
  // workspace of its own.
  const kept = randomUUID();
  const row2 = randomUUID();
  let teamWs = '';

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, TAG);
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    await sql`insert into auth.users (id, email, password_hash, role, is_owner, display_name) values
      (${owner}, 'uo-o@example.invalid', 'x', 'admin', true, null),
      (${member}, 'uo-m@example.invalid', 'x', 'member', false, 'Member')`;
    await sql`select * from mantle_ws_migrate_locked()`;
    teamWs = String(
      (
        await sql`select id::text as id from workspaces
                  where owner_id = ${owner} and bridge_key = 'team'`
      )[0]!.id,
    );
    await sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${teamWs}, ${member}, false) on conflict do nothing`;
    // The Team workspace has no assistant; the row's agent is deleted.
    await sql`delete from workspace_resources where workspace_id = ${teamWs} and type = 'assistant'`;
    await sql`insert into agents (id, owner_id, slug, name, model, system_prompt, role)
      values (${gone}, ${owner}, 'uo-gone', 'Gone', 'test/model', 'x', 'responder')`;
    await sql`insert into team_messages (id, owner_id, login_id, direction, text, agent_id)
      values (${row}, ${owner}, ${member}, 'outbound', 'an old answer', ${gone})`;
    await sql`delete from agents where id = ${gone}`;
    await sql`insert into agents (id, owner_id, slug, name, model, system_prompt, role)
      values (${kept}, ${owner}, 'uo-kept', 'Kept', 'test/model', 'x', 'responder')`;
    await sql`update agents set workspace_id = null where id = ${kept}`;
    await sql`insert into team_messages (id, owner_id, login_id, direction, text, agent_id)
      values (${row2}, ${owner}, ${member}, 'outbound', 'another old answer', ${kept})`;
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    await ensureTestViewerRoles(URL!, process.env.MANTLE_MASTER_KEY);
    m = await import('./index');
    await scratch.migrateRest();
  }, 240_000);

  afterAll(async () => {
    await m?.closeDb();
    await sql?.end();
    await scratch?.drop();
  });

  const folded = async (id = row) =>
    (
      await sql`select workspace_id::text as ws, agent_id::text as agent, login_id::text as login
                  from assistant_messages where id = ${id}`
    )[0];

  const memberReads = async () =>
    m.withScope(await m.loginScopeFor(member), async () =>
      (
        (await m.db.execute(
          dsql`select id::text as id from assistant_messages where id = ${row}`,
        )) as unknown as { id: string }[]
      ).map((r) => r.id),
    );

  it('lands in the Team bridge workspace, its member still reads it', async () => {
    expect(await folded()).toEqual({ ws: teamWs, agent: null, login: member });
    expect(await memberReads()).toEqual([row]);
  });

  it('a second run moves a row an earlier run folded with no workspace', async () => {
    await sql`alter table assistant_messages disable trigger user`;
    await sql`update assistant_messages set workspace_id = null where id in (${row}, ${row2})`;
    await sql`alter table assistant_messages enable trigger user`;
    expect((await folded())!.ws).toBeNull();
    expect((await folded(row2))!.ws).toBeNull();
    const file = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations', `${TAG}.sql`),
      'utf8',
    );
    const statements = file
      .split('--> statement-breakpoint')
      .map((x) => x.trim())
      .filter(Boolean);
    await sql.begin(async (tx) => {
      for (const stmt of statements) await tx.unsafe(stmt);
    });
    expect(await folded()).toEqual({ ws: teamWs, agent: null, login: member });
    // L6: a row whose agent is still there is repaired the same way.
    expect(await folded(row2)).toEqual({ ws: teamWs, agent: kept, login: member });
  });
});
