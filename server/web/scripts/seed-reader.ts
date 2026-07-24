/**
 * Seed "Reader" — the web-page reader specialist. Where the Researcher goes out
 * to the live web to *find* answers (Perplexity Sonar via `web_search`), the
 * Reader is handed a specific URL and *reads it*: it calls `web_fetch`, pages
 * through long documents, and hands the page's content back to the main
 * assistant as context. No search tiers, no brain lookups — just the page(s) it
 * was given.
 *
 * Thin wrapper: the agent definition (prompt, the `web-read` tool group,
 * delegation wiring) lives in the system manifest. This script just applies it.
 * Pair it with `seed:tool-groups` so the new `web-read` group's membership is
 * synced onto an existing brain (see docs/reader.md).
 *
 * Usage:
 *   ALLOWED_USER_ID=<uuid> pnpm -C server/web seed:reader
 */

import { fileURLToPath } from 'node:url';
import { applyManifest } from '../lib/system-manifest/seed';

export async function seedReader(ownerId: string): Promise<void> {
  await applyManifest(ownerId, { only: ['reader'], mode: 'overwrite' });
  console.log('[reader] seeded via manifest.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ownerId = process.env.ALLOWED_USER_ID;
  if (!ownerId) {
    console.error('ALLOWED_USER_ID env var required');
    process.exit(1);
  }
  seedReader(ownerId)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed] failed:', err);
      process.exit(1);
    });
}
