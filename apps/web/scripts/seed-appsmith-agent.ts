/**
 * Seed "Appsmith" — the user's mini-app builder specialist (the /apps surface).
 *
 * Appsmith writes real TSX against the app's shadcn-style components + theme,
 * bundles it with esbuild, and renders it in a sandboxed iframe. The main
 * assistant delegates "build me an app" work to it; Appsmith in turn delegates
 * data-tool work to the Toolsmith.
 *
 * Thin wrapper: the agent definition (prompt, tool groups, skill, delegation
 * wiring) lives in the system manifest. This script applies it for an existing
 * brain — the boot reconcile provisions it automatically on a version bump, so
 * this is for manual/forced resync (or to overwrite to the canonical definition).
 *
 * Usage:
 *   ALLOWED_USER_ID=<uuid> pnpm -C apps/web seed:appsmith
 */

import { fileURLToPath } from 'node:url';
import { applyManifest } from '../lib/system-manifest/seed';

export async function seedAppsmithAgent(ownerId: string): Promise<void> {
  await applyManifest(ownerId, { only: ['appsmith'], mode: 'overwrite' });
  console.log('[appsmith] seeded via manifest.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ownerId = process.env.ALLOWED_USER_ID;
  if (!ownerId) {
    console.error('ALLOWED_USER_ID env var required');
    process.exit(1);
  }
  seedAppsmithAgent(ownerId)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed] failed:', err);
      process.exit(1);
    });
}
