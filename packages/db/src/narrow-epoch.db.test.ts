/**
 * The narrow counts' epoch, on a real, migrated Postgres:
 *
 *  - migrate's step (migrator-steps.ts ensureNarrowEpoch) writes one
 *    narrow-epoch row for a version; a second run of the same version
 *    writes none; a new version writes its own; a roll back to a version
 *    already written writes none; no version writes none;
 *  - the box count's query (scripts/arch-scoreboard-box.sh) reads the
 *    narrow rows since the latest epoch row, all time with none, and never
 *    counts the epoch row; the epoch query prints a plain version and its
 *    time, a hand reset's free text as `reset`.
 *
 * The reaper's side (it keeps the epoch rows) is
 * server/web/lib/maintenance/actor-misses-reap.db.test.ts.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/narrow-epoch.db.test.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase } from './test-support';
import { NARROW_EPOCH_CHECK, ensureNarrowEpoch } from './migrator-steps';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const ROOT = join(__dirname, '..', '..', '..');

/** A query of the box script, by the shell variable it sets. */
function boxQuery(name: string): string {
  const script = readFileSync(join(ROOT, 'scripts', 'arch-scoreboard-box.sh'), 'utf8');
  const query = new RegExp(`^${name}=\\$\\(q <<SQL \\|\\| true\\n([\\s\\S]*?)\\nSQL$`, 'm').exec(
    script,
  )?.[1];
  expect(query, name).toBeTruthy();
  return query!;
}

describe.skipIf(!URL)('the narrow counts` epoch', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let su: ReturnType<typeof postgres>;

  const epochs = async () =>
    (
      await su<{ detail: string; source: string }[]>`
        select detail, source from public.actor_check_misses
         where check_name = ${NARROW_EPOCH_CHECK} order by id`
    ).map((r) => `${r.source} ${r.detail}`);
  const row = (check: string, actor: string, detail: string, ago: string, source = 'sql') =>
    su`insert into public.actor_check_misses (at, source, check_name, actor, detail)
       values (now() - ${ago}::interval, ${source}, ${check}, ${actor}, ${detail})`;
  const first = async (query: string) => {
    const [out] = await su.unsafe<Record<string, string>[]>(query);
    return out ? Object.values(out)[0] : undefined;
  };

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    su = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
  }, 180_000);

  afterAll(async () => {
    await su?.end();
    await scratch?.drop();
  }, 60_000);

  it('migrate`s step writes one row per version, and none on a second run', async () => {
    await su`delete from public.actor_check_misses where check_name like 'narrow-%'`;
    expect(await ensureNarrowEpoch(su, '9.8.7')).toBe('written');
    expect(await epochs()).toEqual(['migrate 9.8.7']);
    // The same release's migrate again (a restart, a re-run): nothing.
    expect(await ensureNarrowEpoch(su, '9.8.7')).toBe('present');
    expect(await epochs()).toEqual(['migrate 9.8.7']);
    // No version read: nothing.
    expect(await ensureNarrowEpoch(su, null)).toBe('no-version');
    // The next release: its own row.
    expect(await ensureNarrowEpoch(su, '9.8.8')).toBe('written');
    // A roll back to the older release: the newer epoch holds.
    expect(await ensureNarrowEpoch(su, '9.8.7')).toBe('present');
    expect(await epochs()).toEqual(['migrate 9.8.7', 'migrate 9.8.8']);
    const [shape] = await su<{ actor: string; recent: boolean }[]>`
      select actor, at > now() - interval '1 minute' as recent from public.actor_check_misses
       where check_name = ${NARROW_EPOCH_CHECK} and detail = '9.8.8'`;
    expect(shape).toEqual({ actor: '', recent: true });
  });

  it('the box counts read since the latest epoch; all time with none; the epoch row is no count', async () => {
    const narrow = boxQuery('narrow');
    const epoch = boxQuery('narrow_epoch');
    await su`delete from public.actor_check_misses where check_name like 'narrow-%'`;
    // Before any epoch: every row counts, and the epoch reads none. Only
    // narrow-denied is a count (a report row of a release before 0344 is
    // not), by distinct actor and detail.
    await row('narrow-denied', 'system:admin-area', 'permission denied for table facts', '3 days');
    await row('narrow-would-refuse', 'system:admin-area', 'public.audit_log DELETE', '3 days');
    expect(await first(narrow)).toBe('1');
    expect(await first(epoch)).toBeUndefined();

    // A release's epoch two days ago: the older rows drop out.
    await row(NARROW_EPOCH_CHECK, '', '9.8.7', '2 days', 'migrate');
    expect(await first(narrow)).toBe('0');
    await row('narrow-denied', 'system:admin-area', 'permission denied for table nodes', '1 day');
    await row('narrow-denied', 'system:admin-area', 'permission denied for table nodes', '2 hours');
    await row('narrow-denied', 'system:http:admin-area', 'text:a-do-block', '1 day');
    expect(await first(narrow)).toBe('2');
    expect(await first(epoch)).toMatch(/^9\.8\.7 \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    // A later release's epoch: from 0 again.
    await row(NARROW_EPOCH_CHECK, '', '9.8.8', '1 hour', 'migrate');
    expect(await first(narrow)).toBe('0');
    await row(
      'narrow-denied',
      'system:http:admin-area',
      'permission denied for table users',
      '1 minute',
    );
    expect(await first(narrow)).toBe('1');
    expect(await first(epoch)).toMatch(/^9\.8\.8 /);

    // A hand reset (docs/runtime-role.md): its reason never leaves the box.
    await su`insert into public.actor_check_misses (source, check_name, actor, detail)
             values ('operator', 'narrow-epoch', '', 'reset: cause fixed by hand')`;
    expect(await first(narrow)).toBe('0');
    expect(await first(epoch)).toMatch(/^reset \d{4}-/);
  });
});
