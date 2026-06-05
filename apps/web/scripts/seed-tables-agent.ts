/**
 * Seed "Tables" — Jason's typed-grid specialist. The Pages-equivalent for
 * tabular data: building database grids, importing spreadsheets, adding totals
 * and formulas, and doing per-row edits the operator describes ("set row 3 to
 * paid", "total the price column", "sort by date").
 *
 * Division of labour:
 *   - Saskia  → delegates to Tables whenever the user's intent is grid-shaped
 *               ("make a table of …", "import this xlsx", "add a totals row",
 *               "update the stock count for the bolts"). Saskia stays in the
 *               conversation; Tables does the grid work and reports a status.
 *   - Tables  → reads rows by id, edits into the DRAFT, returns a short status
 *               (what changed, the table id, the review URL). Never echoes the
 *               whole grid.
 *
 * Thin wrapper: the agent definition (prompt, tools, skills, delegation
 * wiring) now lives in the system manifest. This script just applies it.
 *
 * Usage:
 *   ALLOWED_USER_ID=<uuid> pnpm -C apps/web seed:tables
 */

import { fileURLToPath } from 'node:url';
import { applyManifest } from '../lib/system-manifest/seed';

export async function seedTablesAgent(ownerId: string): Promise<void> {
  await applyManifest(ownerId, { only: ['tables'], mode: 'overwrite' });
  console.log('[tables] seeded via manifest.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ownerId = process.env.ALLOWED_USER_ID;
  if (!ownerId) {
    console.error('ALLOWED_USER_ID env var required');
    process.exit(1);
  }
  seedTablesAgent(ownerId)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed] failed:', err);
      process.exit(1);
    });
}
