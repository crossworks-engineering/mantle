/**
 * Seed "Remy" — the user's memory-recall agent. Where the main assistant lives
 * in the present turn, Remy travels backward: given a vague ask ("last week we
 * discussed some topic, recall the exact conclusion"), Remy locates WHEN via
 * conversation digests (`find_window`), pulls the raw turns (`recall_window`),
 * reasons over them, and hands a faithful synthesis back to the main assistant.
 *
 * Reached via delegation — the manifest also adds `remy` to the enabled
 * responder's and assistant's `memory_config.delegate_to` so the path works
 * immediately.
 *
 * Thin wrapper: the agent definition (prompt, tools, delegation wiring) now
 * lives in the system manifest. This script just applies it.
 *
 * Usage:
 *   ALLOWED_USER_ID=<uuid> pnpm -C apps/web seed:remy
 */

import { fileURLToPath } from 'node:url';
import { applyManifest } from '../lib/system-manifest/seed';

export async function seedRemy(ownerId: string): Promise<void> {
  await applyManifest(ownerId, { only: ['remy'], mode: 'overwrite' });
  console.log('[remy] seeded via manifest.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ownerId = process.env.ALLOWED_USER_ID;
  if (!ownerId) {
    console.error('ALLOWED_USER_ID env var required');
    process.exit(1);
  }
  seedRemy(ownerId)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed] failed:', err);
      process.exit(1);
    });
}
