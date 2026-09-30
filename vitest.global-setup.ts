/**
 * Runs once before the whole vitest run.
 *
 * It generates server/web/server/route-manifest.gen.ts (gitignored; normally
 * written by `typecheck`, `dev` and `build`). The security sweeps (auth,
 * member, admin-space, member-space bytes) drive every route in that
 * manifest, and used to skip silently when it was missing, so a plain
 * `vitest run` on a fresh checkout reported green without running them.
 * Generating it here also keeps it in step with the route files.
 *
 * On CI it also refuses to start without the database test URLs.
 */
import { fileURLToPath } from 'node:url';
import { missingDbTestEnv } from './packages/db/src/test-env-guard';

export default async function setup(): Promise<void> {
  // CI must not report green with the database tests skipped (client logins
  // audit A31): every *.db.test.ts skips without its URL, so a CI job that
  // forgot one would pass without running them. Fail the whole run instead.
  const missing = missingDbTestEnv(process.env);
  if (missing.length > 0) {
    throw new Error(
      `CI run without ${missing.join(' and ')}: the database tests would be skipped. ` +
        'Set them in the workflow step that runs vitest.',
    );
  }

  // The generator is a script: importing it runs it (it scans server/web/app).
  await import(
    fileURLToPath(new URL('./server/web/scripts/gen-route-manifest.ts', import.meta.url))
  );

  // The viewer roles are cluster-wide: bring them to their wanted state once
  // here, so the test files that each ensure them at start find them in
  // place (a CREATE never races) and their ALTERs retry less. Parallel files
  // racing on these rows were the "tuple concurrently updated" setup
  // failures (folder audit T2).
  const url = process.env.MANTLE_TEST_DATABASE_URL;
  if (url) {
    const { ensureTestViewerRoles } = await import('./packages/db/src/test-support');
    await ensureTestViewerRoles(url, process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key');
  }
}
