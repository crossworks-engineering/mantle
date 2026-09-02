/**
 * Seed one or more manifest-defined agents onto a brain.
 *
 * Thin wrapper: every agent definition (prompt, tools, delegation wiring) lives
 * in the system manifest; this script just applies the named entries in
 * `overwrite` mode. It replaces the eight identical per-agent scripts
 * (seed-remy, seed-researcher, seed-reader, seed-coder-agent, ...).
 *
 * Usage:
 *   ALLOWED_USER_ID=<uuid> pnpm -C server/web seed:remy          # alias
 *   ALLOWED_USER_ID=<uuid> tsx scripts/seed-agent.ts remy pages  # any slugs
 */

import { fileURLToPath } from 'node:url';
import { applyManifest } from '../lib/system-manifest/seed';
import { env } from '@mantle/config';

export async function seedAgents(ownerId: string, slugs: string[]): Promise<void> {
  await applyManifest(ownerId, { only: slugs, mode: 'overwrite' });
  console.log(`[seed] ${slugs.join(', ')} seeded via manifest.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ownerId = env('ALLOWED_USER_ID');
  const slugs = process.argv.slice(2).filter(Boolean);
  if (!ownerId) {
    console.error('ALLOWED_USER_ID env var required');
    process.exit(1);
  }
  if (slugs.length === 0) {
    console.error('usage: seed-agent.ts <manifest-agent-slug> [more slugs...]');
    process.exit(1);
  }
  seedAgents(ownerId, slugs)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed] failed:', err);
      process.exit(1);
    });
}
