/**
 * The checks' floor preflight SQL (scripts/roll.sh step 2d and the
 * updater's check_floor_refusal, infra/updater/updater.sh): the same text
 * in both, and its answer on a real database: "<actor> <edit>", the box's
 * own modes, and "off off" on a schema from before 0280 (no
 * mantle_check_box_mode). Whether a target release ships the floor is the
 * deploy harness's (scripts/test-deploy-scripts.sh).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/check-floor-preflight.db.test.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase, createScratchDatabaseBefore } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The SQL between `cat <<'CHECK_MODES_SQL'` and its end line. */
function modesSql(rel: string): string {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  const m = text.match(/cat <<'CHECK_MODES_SQL'\n([\s\S]*?)\nCHECK_MODES_SQL\n/);
  if (!m) throw new Error(`no CHECK_MODES_SQL heredoc in ${rel}`);
  return m[1]!;
}

const SQL = modesSql('scripts/roll.sh');

describe("the checks' floor preflight SQL", () => {
  it('is the same text in roll.sh and the updater', () => {
    expect(modesSql('infra/updater/updater.sh')).toBe(SQL);
    expect(SQL).toMatch(/mantle_check_box_mode/);
  });
});

/** A fresh session each read: a connection keeps the setting it opened with. */
async function ask(url: string): Promise<string> {
  const s = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const rows = await s.unsafe(SQL);
    expect(rows).toHaveLength(1);
    return String(Object.values(rows[0]!)[0]);
  } finally {
    await s.end();
  }
}

describe.skipIf(!URL)('on a migrated database', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let sql: postgres.Sql;

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    sql = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('answers the two modes, actor first', async () => {
    await sql`select mantle_set_actor_check('on')`;
    await sql`select mantle_set_edit_check('on')`;
    expect(await ask(scratch.url)).toBe('on on');
    await sql`select mantle_set_edit_check('warn', 50, 'test')`;
    expect(await ask(scratch.url)).toBe('on warn');
    await sql`select mantle_set_actor_check('off', 50, 'test')`;
    expect(await ask(scratch.url)).toBe('off warn');
  });
});

describe.skipIf(!URL)('on a schema from before 0280 (no mantle_check_box_mode)', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>>;

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, '0280_edit_check');
  }, 120_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  it('answers off off', async () => {
    expect(await ask(scratch.url)).toBe('off off');
  });
});
