/**
 * The roll preflight for the workspaces switch (W5b2 part B fix round 2,
 * H-a): scripts/roll.sh (step 2a) and the updater (ws_switch_refusal) send
 * the same plain SQL to a box before a roll to the switch release. It must
 * refuse a brain that is not on workspaces because it has clients (an
 * anchor, no Admin workspace, client logins or client-level items; plan
 * 21.9), on the schema such a box has TODAY: from v0.239.35 on (migration
 * 0232: no workspaces table, no mantle_ws_skip_reason). Checked here on
 * scratch databases:
 *  - at 0232 (a v0.239.35 box): a client login refuses, a client-level item
 *    refuses, a brain with members only goes ahead, a brain with no anchor
 *    goes ahead;
 *  - at 0271 (the switch release before W8a; 0272 turns every client login
 *    into a member and admits none after, so a client login is planted
 *    before it): a client box left unswitched by 0261 refuses; the same
 *    brain once set up (its Admin workspace made by the migration) goes
 *    ahead, a client login added later included;
 *  - the two copies (roll.sh, updater.sh) are the same text.
 * The answer is one row: refuse (1 or 0), client logins, client-level items.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/ws-switch-preflight.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScratchDatabaseBefore } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The SQL between `cat <<'WS_SWITCH_SQL'` and its end line. */
function preflightSql(rel: string): string {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  const m = text.match(/cat <<'WS_SWITCH_SQL'\n([\s\S]*?)\nWS_SWITCH_SQL\n/);
  if (!m) throw new Error(`no WS_SWITCH_SQL heredoc in ${rel}`);
  return m[1]!;
}

const SQL = preflightSql('scripts/roll.sh');

describe('the workspaces switch preflight SQL', () => {
  it('is the same text in roll.sh and the updater', () => {
    expect(preflightSql('infra/updater/updater.sh')).toBe(SQL);
    expect(SQL).toMatch(/bridge_key/);
  });
});

type Answer = [number, number, number];
async function ask(sql: postgres.Sql): Promise<Answer> {
  const rows = await sql.unsafe(SQL);
  expect(rows).toHaveLength(1);
  return Object.values(rows[0]!).map(Number) as Answer;
}

describe.skipIf(!URL)('on a v0.239.35 box (schema at 0232)', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>>;
  let sql: postgres.Sql;
  const owner = randomUUID();
  const client = randomUUID();

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, '0233_keep_existing_look');
    sql = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    const [w] = await sql<
      { t: string | null }[]
    >`select to_regclass('public.workspaces')::text as t`;
    expect(w!.t).toBeNull();
  }, 240_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('no anchor yet: goes ahead', async () => {
    expect(await ask(sql)).toEqual([0, 0, 0]);
  });

  it('members only: goes ahead', async () => {
    await sql`insert into auth.users (id, email, password_hash, role, is_owner) values
      (${owner}, 'pf-o@example.invalid', 'x', 'admin', true),
      (${randomUUID()}, 'pf-m@example.invalid', 'x', 'member', false)`;
    await sql`insert into nodes (id, owner_id, type, title, path, audience)
      values (${randomUUID()}, ${owner}, 'page', 'pf team', 'pages', 'team')`;
    expect(await ask(sql)).toEqual([0, 0, 0]);
  });

  it('a client-level item: refused', async () => {
    const page = randomUUID();
    await sql`insert into nodes (id, owner_id, type, title, path, audience)
      values (${page}, ${owner}, 'page', 'pf client', 'pages', 'client')`;
    expect(await ask(sql)).toEqual([1, 0, 1]);
    await sql`delete from nodes where id = ${page}`;
  });

  it('a client login: refused', async () => {
    await sql`insert into auth.users (id, email, password_hash, role, is_owner)
      values (${client}, 'pf-c@example.invalid', 'x', 'client', false)`;
    expect(await ask(sql)).toEqual([1, 1, 0]);
  });
});

describe.skipIf(!URL)('on a box with the switch release (schema at 0271)', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>>;
  let sql: postgres.Sql;
  const owner = randomUUID();
  const client = randomUUID();

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, '0272_workspaces_logins_carry_nothing');
    sql = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    await sql`insert into auth.users (id, email, password_hash, role, is_owner) values
      (${owner}, 'pf2-o@example.invalid', 'x', 'admin', true),
      (${client}, 'pf2-c@example.invalid', 'x', 'client', false)`;
    await sql`insert into nodes (id, owner_id, type, title, path, audience)
      values (${randomUUID()}, ${owner}, 'page', 'pf2 team', 'pages', 'team')`;
  }, 240_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('a client box not on workspaces: refused, as the release itself skips it', async () => {
    expect((await sql`select mantle_ws_skip_reason() as r`)[0]!.r).toMatch(/^clients present/);
    expect(await ask(sql)).toEqual([1, 1, 0]);
  });

  it('the same brain once set up: goes ahead, a client login added later too', async () => {
    // Set up (here: the client login is removed while the migration runs).
    await sql`delete from auth.users where id = ${client}`;
    const rows = await sql<{ section: string }[]>`select * from mantle_ws_migrate_locked()`;
    expect(rows.filter((r) => r.section === 'reach-fail')).toEqual([]);
    expect((await sql`select mantle_ws_skip_reason() as r`)[0]!.r).toBeNull();
    expect(await ask(sql)).toEqual([0, 0, 0]);
    await sql`insert into auth.users (id, email, password_hash, role, is_owner)
      values (${randomUUID()}, 'pf2-c2@example.invalid', 'x', 'client', false)`;
    expect(await ask(sql)).toEqual([0, 1, 0]);
  });
});
