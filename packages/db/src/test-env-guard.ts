/**
 * CI never runs the suite with its database tests skipped (client logins
 * audit A31). Every `*.db.test.ts` file is `describe.skipIf(!URL)` on one of
 * these variables, so a CI job that forgets to set one reports green without
 * running a single row security, grant or route test. vitest.global-setup.ts
 * calls this before any test file loads and throws on a CI run with one
 * missing; a local run (no CI variable) still skips them as before.
 */
export const DB_TEST_ENV_VARS = ['MANTLE_TEST_DATABASE_URL', 'RUNS_TEST_DATABASE_URL'] as const;

function isCi(env: Record<string, string | undefined>): boolean {
  const ci = env.CI?.trim().toLowerCase();
  return !!ci && ci !== 'false' && ci !== '0';
}

/** The database test variables a CI run is missing (none outside CI). */
export function missingDbTestEnv(env: Record<string, string | undefined>): string[] {
  if (!isCi(env)) return [];
  return DB_TEST_ENV_VARS.filter((v) => !env[v]?.trim());
}
