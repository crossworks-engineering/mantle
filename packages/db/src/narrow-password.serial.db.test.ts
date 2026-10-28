/**
 * The narrow login changes its own password and commits; the derived
 * password then fails (28P01), and migrate's role step sets it again (the
 * b1 re-audit's P5, end to end). The role is the cluster's, so a committed
 * change would fail every other test file's narrow login while it holds:
 * this file runs alone (`pnpm test:serial`, vitest.serial.config.ts: no
 * other file at the same time; the default configs leave
 * `*.serial.db.test.ts` out).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test:serial
 */
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('the narrow login changes its own password (alone on the cluster)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let su: ReturnType<typeof postgres>;
  let rr: typeof import('./runtime-role');
  const KEY = () => process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    su = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    rr = await import('./runtime-role');
  }, 120_000);

  afterAll(async () => {
    // Whatever happened above, the derived password again.
    if (rr) {
      await rr.ensureRuntimeRoles(su, KEY(), { login: true, warn: () => {} });
    }
    await su?.end();
    await scratch?.drop();
  });

  /** One login as the narrow role with `password`: its answer, or the
   *  refusal's code. */
  const login = async (password: string) => {
    const one = postgres(rr.runtimeDatabaseUrl(scratch.url, password, rr.NARROW_ROLE), {
      max: 1,
      prepare: false,
      onnotice: () => {},
    });
    try {
      const [row] = await one.unsafe<{ u: string }[]>('select current_user::text as u');
      return row!.u;
    } catch (err) {
      return (err as { code?: string }).code;
    } finally {
      await one.end({ timeout: 1 });
    }
  };

  it('commits its own new password; the derived one gets 28P01; the migrate role step sets it again', async () => {
    const derived = rr.narrowRolePassword(KEY());
    expect(await login(derived)).toBe(rr.NARROW_ROLE);
    // The narrow login changes its own password, committed.
    const nl = postgres(rr.runtimeDatabaseUrl(scratch.url, derived, rr.NARROW_ROLE), {
      max: 1,
      prepare: false,
      onnotice: () => {},
    });
    try {
      await nl.unsafe(`alter role current_user password 'not-the-derived-one'`);
    } finally {
      await nl.end();
    }
    expect(await login(derived)).toBe('28P01');
    expect(await login('not-the-derived-one')).toBe(rr.NARROW_ROLE);
    // migrate's role step (beforeMigrations runs it each migrate).
    expect(await rr.ensureRuntimeRoles(su, KEY(), { login: true, warn: () => {} })).toBe('ok');
    expect(await login(derived)).toBe(rr.NARROW_ROLE);
    expect(await login('not-the-derived-one')).toBe('28P01');
  });
});
