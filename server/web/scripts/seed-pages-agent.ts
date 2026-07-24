/**
 * Seed "Pages" — the user's page-authoring & editing specialist (Phase 2a).
 *
 * Where the main assistant is a generalist conversationalist, Pages is a focused
 * design-conscious editor: importing markdown files into pages, restyling
 * existing pages with the rich Mantle dialect (callouts / asides / columns /
 * tables / task lists / KaTeX), and producing clean, on-brand documents.
 *
 * Division of labour:
 *   - main assistant → delegates to Pages whenever the user's intent is
 *               page-shaped ("import this file as a page", "style the draft",
 *               "make a doc summarising X"). The main assistant stays in the
 *               conversation; Pages does the document work.
 *   - Pages   → returns a short status (what changed, page id, suggested
 *               next step) — not a full document echo. The main assistant relays it.
 *
 * Thin wrapper: the agent definition (prompt, tools, skills, delegation
 * wiring) now lives in the system manifest. This script just applies it.
 *
 * Usage:
 *   ALLOWED_USER_ID=<uuid> pnpm -C server/web seed:pages
 */

import { fileURLToPath } from 'node:url';
import { applyManifest } from '../lib/system-manifest/seed';

export async function seedPagesAgent(ownerId: string): Promise<void> {
  await applyManifest(ownerId, { only: ['pages'], mode: 'overwrite' });
  console.log('[pages] seeded via manifest.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ownerId = process.env.ALLOWED_USER_ID;
  if (!ownerId) {
    console.error('ALLOWED_USER_ID env var required');
    process.exit(1);
  }
  seedPagesAgent(ownerId)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed] failed:', err);
      process.exit(1);
    });
}
