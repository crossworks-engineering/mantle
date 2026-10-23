/**
 * S8b's seat preflight SQL (scripts/roll.sh step 2e and the updater's
 * s8b_seat_refusal, infra/updater/updater.sh): the same text in both, and
 * on a real database the same count 0330's migrate refuses on (any login
 * with an Admin seat but not role admin: disabled ones and former clients
 * too), so a roll that 0330's migrate would refuse is refused before it
 * starts. 0 once 0330 is in (its guard function there: that migrate never
 * runs again). Whether a target ships 0330 is the deploy harness's
 * (scripts/test-deploy-scripts.sh).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/s8b-seat-preflight.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDatabaseBefore, ensureAdminUsers, ensureTestAnchor } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TAG = '0330_s8b_role_follows_membership';

/** The SQL between `cat <<'S8B_SEAT_SQL'` and its end line. */
function seatSql(rel: string): string {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  const m = text.match(/cat <<'S8B_SEAT_SQL'\n([\s\S]*?)\nS8B_SEAT_SQL\n/);
  if (!m) throw new Error(`no S8B_SEAT_SQL heredoc in ${rel}`);
  return m[1]!;
}

const SQL = seatSql('scripts/roll.sh');

describe('the S8b seat preflight SQL', () => {
  it('is the same text in roll.sh and the updater', () => {
    expect(seatSql('infra/updater/updater.sh')).toBe(SQL);
    expect(SQL).toMatch(/mantle_login_role_guard/);
  });

  it('roll.sh and the updater look for the migration by the name it has', () => {
    const names = readFileSync(join(ROOT, 'packages/db/migrations/meta/_journal.json'), 'utf8');
    expect(names).toContain(`"${TAG}"`);
    expect(readFileSync(join(ROOT, 'scripts/roll.sh'), 'utf8')).toContain(
      'S8B_MIGRATION=_s8b_role_follows_membership.sql',
    );
    expect(readFileSync(join(ROOT, 'infra/updater/updater.sh'), 'utf8')).toContain(
      "'_s8b_role_follows_membership\\.sql$'",
    );
  });
});

/** The preflight's one number, asked in a fresh session as the box asks it. */
async function ask(url: string): Promise<number> {
  const s = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const rows = await s.unsafe(SQL);
    expect(rows).toHaveLength(1);
    return Number(Object.values(rows[0]!)[0]);
  } finally {
    await s.end();
  }
}

describe.skipIf(!URL)('on a database stopped before 0330', () => {
  let db: Awaited<ReturnType<typeof createScratchDatabaseBefore>>;
  let sql: postgres.Sql;
  const tag = `sp${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    db = await createScratchDatabaseBefore(URL!, TAG);
    sql = postgres(db.url, { max: 1, prepare: false, onnotice: () => {} });
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await db?.drop();
  });

  const login = (id: string, role: 'admin' | 'member') =>
    sql`insert into auth.users (id, email, password_hash, is_owner, role)
        values (${id}, ${`${tag}-${id.slice(0, 8)}@example.test`}, 'x', false, ${role})`;

  it('counts what 0330 refuses on, refuses with that count, and is 0 once 0330 is in', async () => {
    const brain = await ensureTestAnchor(sql);
    expect(await ask(db.url)).toBe(0);
    const seated = randomUUID(); // enabled member, seated: counted
    const disabled = randomUUID(); // disabled member, seated: counted
    const former = randomUUID(); // former client, member, seated: counted
    const admin = randomUUID(); // role admin, seated: not counted
    const unseated = randomUUID(); // role admin, no seat: not counted (the NOTICE)
    await login(seated, 'member');
    await login(disabled, 'member');
    await login(former, 'member');
    await login(admin, 'admin');
    await login(unseated, 'admin');
    await sql`update auth.users set disabled_at = now() where id = ${disabled}`;
    await sql`insert into archive_client_logins (login_id, email, created_at, session_epoch)
              values (${former}, ${`${tag}-arc@example.test`}, now(), 0)`;
    await ensureAdminUsers(sql, [seated, disabled, former, admin]);
    expect(await ask(db.url)).toBe(3);

    const err = await db.migrateRest().then(
      () => null,
      (e: unknown) => e as { code?: string; message?: string },
    );
    expect(err?.code).toBe('42501');
    expect(err?.message).toMatch(/^mantle S8b: 3 login\(s\) hold an Admin seat without role admin/);
    expect(await ask(db.url)).toBe(3);

    // The first repair the refusal names: the seats taken away.
    await sql`delete from workspace_users u using workspaces w
               where u.workspace_id = w.id and w.owner_id = ${brain} and w.is_admin
                 and u.login_id in ${sql([seated, disabled, former])}`;
    expect(await ask(db.url)).toBe(0);
    await db.migrateRest();

    // 0330 is in: a seat planted by hand since is no roll's business (that
    // migrate never runs again), so the preflight answers 0.
    await sql`insert into workspace_users (workspace_id, login_id, moderator)
              select w.id, ${seated}::uuid, false from workspaces w
               where w.owner_id = ${brain} and w.is_admin and w.archived_at is null`;
    expect(await ask(db.url)).toBe(0);
  }, 300_000);
});
