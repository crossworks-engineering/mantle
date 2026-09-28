/**
 * Runs once before the whole vitest run.
 *
 * It generates server/web/server/route-manifest.gen.ts (gitignored; normally
 * written by `typecheck`, `dev` and `build`). The security sweeps (auth,
 * member, admin-space, member-space bytes) drive every route in that
 * manifest, and used to skip silently when it was missing, so a plain
 * `vitest run` on a fresh checkout reported green without running them.
 * Generating it here also keeps it in step with the route files.
 */
import { fileURLToPath } from 'node:url';

export default async function setup(): Promise<void> {
  // The generator is a script: importing it runs it (it scans server/web/app).
  await import(
    fileURLToPath(new URL('./server/web/scripts/gen-route-manifest.ts', import.meta.url))
  );
}
