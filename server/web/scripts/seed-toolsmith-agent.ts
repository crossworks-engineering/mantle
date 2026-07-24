/**
 * Seed "Toolsmith" — the user's API integration specialist.
 *
 * Toolsmith reads a service's API docs (web_fetch), authors templated HTTP
 * tools against them (api_tool_create, with {param} placeholders +
 * {{secret:service/label}} vault refs), proves them against the live API
 * (api_tool_test), bundles them into a tool group, and grants the group to
 * an agent — turning "here are the Mapbox docs, give my assistant travel
 * times" into a deployed capability in one prompt.
 *
 * Division of labour:
 *   - main assistant → delegates integration work to Toolsmith
 *               ("add a weather API for me") via invoke_agent.
 *   - API Console → its Assist panel talks to Toolsmith directly about
 *               the registry the console is displaying.
 *   - Claude Code → the same api_tool_* set is exposed over MCP, so
 *               advanced users can run the loop on their own subscription.
 *
 * Thin wrapper: the agent definition (prompt, tool groups, delegation,
 * assist surface) lives in the system manifest. This script just applies it.
 *
 * Usage:
 *   ALLOWED_USER_ID=<uuid> pnpm -C server/web seed:toolsmith
 */

import { fileURLToPath } from 'node:url';
import { applyManifest } from '../lib/system-manifest/seed';

export async function seedToolsmithAgent(ownerId: string): Promise<void> {
  await applyManifest(ownerId, { only: ['toolsmith'], mode: 'overwrite' });
  console.log('[toolsmith] seeded via manifest.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ownerId = process.env.ALLOWED_USER_ID;
  if (!ownerId) {
    console.error('ALLOWED_USER_ID env var required');
    process.exit(1);
  }
  seedToolsmithAgent(ownerId)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed] failed:', err);
      process.exit(1);
    });
}
