/**
 * Seed "Researcher" — the user's outward-facing agent (Remy's twin). Where Remy
 * goes inward into the conversation archive, Researcher goes out to the live
 * internet: it plans queries, calls `web_search` (Perplexity Sonar via
 * OpenRouter), cross-checks sources, and hands a synthesised, cited answer back
 * to the main assistant.
 *
 * Division of labour (per the "main assistant decides" capture model):
 *   - researcher       → web_search + search_nodes/node_read; returns a synthesis.
 *                        Does NOT persist — keeps it focused on finding answers.
 *   - main assistant   → gets the synthesis, decides if it's worth keeping, and
 *                        saves it with `note_create` (which the extractor indexes
 *                        into the brain).
 *
 * Thin wrapper: the agent definition (prompt, tools, delegation + note_create
 * wiring) now lives in the system manifest. This script just applies it.
 *
 * Usage:
 *   ALLOWED_USER_ID=<uuid> pnpm -C apps/web seed:researcher
 */

import { fileURLToPath } from 'node:url';
import { applyManifest } from '../lib/system-manifest/seed';

export async function seedResearcher(ownerId: string): Promise<void> {
  await applyManifest(ownerId, { only: ['researcher'], mode: 'overwrite' });
  console.log('[researcher] seeded via manifest.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ownerId = process.env.ALLOWED_USER_ID;
  if (!ownerId) {
    console.error('ALLOWED_USER_ID env var required');
    process.exit(1);
  }
  seedResearcher(ownerId)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed] failed:', err);
      process.exit(1);
    });
}
