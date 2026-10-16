/**
 * The checks' floor at migrate (migration 0301, check-floor.ts
 * raiseCheckFloor): a box below on with no recorded lowering is raised to
 * on; a box an operator lowered with a reason is left as it is; a bare
 * ALTER DATABASE (no record, or below the recorded mode) is raised again;
 * MANTLE_CHECK_FLOOR=keep leaves it, loudly, and records why. The SQL
 * setter's own rule (lowering needs a reason) is edit-check.db.test.ts's
 * "the floor (0301)".
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/check-floor.db.test.ts
 */
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CHECK_FLOOR_SQL,
  checkFloorPolicy,
  checkFloorWarning,
  raiseCheckFloor,
} from './check-floor';
import { createMigratedScratchDatabase } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the checks floor at migrate (0301)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let sql: ReturnType<typeof postgres>;
  const lines: string[] = [];
  const log = { info: (l: string) => lines.push(l), warn: (l: string) => lines.push(l) };

  /** A fresh session each read: a connection keeps the setting it opened with. */
  const floor = async () => {
    const s = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    try {
      return (await s.unsafe(CHECK_FLOOR_SQL))[0] as unknown as {
        actor: string;
        edit: string;
        lowered: string;
      };
    } finally {
      await s.end();
    }
  };

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    sql = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    // Whatever a test config switched the scratch database to: both on,
    // then both off with a reason (a recorded lowering).
    await sql`select mantle_set_actor_check('on')`;
    await sql`select mantle_set_edit_check('on')`;
    await sql`select mantle_set_edit_check('off', 50, 'test')`;
    await sql`select mantle_set_actor_check('off', 50, 'test')`;
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('raises a new database to on; keeps a recorded lowering; raises a bare ALTER DATABASE again', async () => {
    // The 'test' lowerings above are recorded: the floor keeps them.
    expect((await floor()).lowered).toMatch(/: test$/);
    expect(await raiseCheckFloor(sql, log)).toBe('kept');
    expect(await floor()).toMatchObject({ actor: 'off', edit: 'off' });
    // A database with no record (a new one, a restore): raised, actor first.
    await sql.unsafe(`alter database "${scratch.name}" reset mantle.check_lowered`);
    lines.length = 0;
    expect(await raiseCheckFloor(sql, log)).toBe('raised');
    expect(await floor()).toEqual({ actor: 'on', edit: 'on', lowered: '' });
    expect(lines).toEqual([
      '  actor check: off -> on (no lowering recorded; docs/update-prod.md)',
      '  edit check: off -> on (no lowering recorded; docs/update-prod.md)',
    ]);
    expect(await raiseCheckFloor(sql, log)).toBe('on');
    // An operator's lowering with a reason: left, with the record in the warning.
    await sql`select mantle_set_edit_check('warn', 50, 'an import, ticket 9')`;
    lines.length = 0;
    expect(await raiseCheckFloor(sql, log)).toBe('kept');
    expect(await floor()).toMatchObject({ actor: 'on', edit: 'warn' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/WARNING \[db\] SECURITY: the edit check is warn on this brain/);
    expect(lines[0]).toMatch(/Lowered by an operator: .* an import, ticket 9\./);
    // A bare ALTER DATABASE leaves no record: raised again.
    await sql`select mantle_set_edit_check('on')`;
    await sql.unsafe(`alter database "${scratch.name}" reset mantle.actor_check`);
    expect(await raiseCheckFloor(sql, log)).toBe('raised');
    expect(await floor()).toEqual({ actor: 'on', edit: 'on', lowered: '' });
    // The processes' line: none when both are on.
    expect(checkFloorWarning(await floor())).toBe('');
    await sql`select mantle_set_edit_check('off', 50, 'test')`;
    await sql`select mantle_set_actor_check('off', 50, 'test')`;
  });

  it('a bare ALTER DATABASE below a recorded lowering is raised; the other check stays on record', async () => {
    await sql`select mantle_set_actor_check('on')`;
    await sql`select mantle_set_edit_check('on')`;
    // Both lowered with a reason: both on record, one entry each.
    await sql`select mantle_set_edit_check('warn', 50, 'an import')`;
    await sql`select mantle_set_actor_check('warn', 50, 'a stuck job')`;
    const both = (await floor()).lowered;
    expect(both.split(' | ')).toHaveLength(2);
    expect(both).toMatch(/mantle\.edit_check on to warn by \S+: an import/);
    expect(both).toMatch(/mantle\.actor_check on to warn by \S+: a stuck job/);
    expect(await raiseCheckFloor(sql, log)).toBe('kept');
    // The edit check taken lower by hand, past its record (warn): raised;
    // the actor check's own record still covers it.
    await sql.unsafe(`alter database "${scratch.name}" reset mantle.edit_check`);
    lines.length = 0;
    expect(await raiseCheckFloor(sql, log)).toBe('raised');
    expect(lines).toEqual(['  edit check: off -> on (no lowering recorded; docs/update-prod.md)']);
    const after = await floor();
    expect(after).toMatchObject({ actor: 'warn', edit: 'on' });
    expect(after.lowered).toMatch(/^\S+ mantle\.actor_check on to warn by \S+: a stuck job$/);
    await sql`select mantle_set_actor_check('on')`;
    expect(await floor()).toEqual({ actor: 'on', edit: 'on', lowered: '' });
    await sql`select mantle_set_edit_check('off', 50, 'test')`;
    await sql`select mantle_set_actor_check('off', 50, 'test')`;
  });

  it('MANTLE_CHECK_FLOOR=keep leaves a box below on, says so loudly and records why', async () => {
    await sql.unsafe(`alter database "${scratch.name}" reset mantle.check_lowered`);
    const keep = checkFloorPolicy('keep', 'a bulk import, ticket 12');
    lines.length = 0;
    expect(await raiseCheckFloor(sql, log, keep)).toBe('held');
    const kept = await floor();
    expect(kept).toMatchObject({ actor: 'off', edit: 'off' });
    expect(kept.lowered).toMatch(
      /mantle\.actor_check kept at off by \S+: MANTLE_CHECK_FLOOR=keep at migrate, a bulk import, ticket 12/,
    );
    expect(kept.lowered).toMatch(/mantle\.edit_check kept at off by /);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^ {2}WARNING MANTLE_CHECK_FLOOR=keep: the actor check and the edit check left below on/,
    );
    // Recorded: the next migrate keeps it, whatever the env says then.
    expect(await raiseCheckFloor(sql, log)).toBe('kept');
    expect(await floor()).toMatchObject({ actor: 'off', edit: 'off' });
    // Anything but keep raises (said loudly when it is not raise).
    expect(checkFloorPolicy(undefined, undefined).policy).toBe('raise');
    const said: string[] = [];
    expect(checkFloorPolicy('kep', 'x', { warn: (l) => said.push(l) }).policy).toBe('raise');
    expect(said).toEqual(['  WARNING MANTLE_CHECK_FLOOR=kep is not raise or keep: raise']);
  });
});
