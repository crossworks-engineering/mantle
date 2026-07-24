/**
 * Seed the manifest tool groups (capability bundles) for an owner.
 *
 * Tools & Skills split, Phase 0 (docs/tools-and-skills.md). The 19 default
 * groups mirror the `*_TOOLS` clusters in @mantle/tools. They are DORMANT: no
 * agent grants them yet, so seeding changes nothing at runtime — it just
 * populates `tool_groups` so the Tools manager + integrity checks have rows to
 * work with after migration 0080.
 *
 * Runs `applyManifest` with empty agent/skill filters in gap-fill mode, so it
 * touches ONLY the groups (+ idempotent builtin tools) and never clobbers an
 * existing agent/skill/operator edit.
 *
 * Usage:
 *   ALLOWED_USER_ID=<uuid> pnpm -C server/web seed:tool-groups
 *
 * Idempotent: each group is upserted by slug (gap-fill leaves an existing,
 * possibly operator-edited group untouched).
 */

import { fileURLToPath } from 'node:url';
import { applyManifest } from '../lib/system-manifest/seed';
import { MANIFEST_TOOL_GROUPS } from '../lib/system-manifest/manifest';

export async function seedToolGroups(ownerId: string): Promise<void> {
  // Overwrite: sync the group ROWS to the canonical manifest membership (so an
  // existing brain picks up redefinitions, e.g. the P5 no-delete contacts/journal
  // groups). Empty agent/skill filters mean this touches ONLY tool groups (+
  // idempotent builtin tools) — never an agent or skill.
  await applyManifest(ownerId, { only: [], onlySkills: [], mode: 'overwrite' });
  console.log(
    `[tool-groups] synced ${MANIFEST_TOOL_GROUPS.length} groups to manifest: ` +
      MANIFEST_TOOL_GROUPS.map((g) => g.slug).join(', '),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ownerId = process.env.ALLOWED_USER_ID;
  if (!ownerId) {
    console.error('ALLOWED_USER_ID env var required');
    process.exit(1);
  }
  seedToolGroups(ownerId)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed] failed:', err);
      process.exit(1);
    });
}
