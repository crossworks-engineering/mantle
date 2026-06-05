/**
 * Seeds the `table_authoring` skill — the capability pack for working with
 * typed database grids (the Tables feature).
 *
 * Thin wrapper: the skill definition (instructions, the safe table_* tool
 * subset) now lives in the system manifest, which also attaches it to the
 * personas that should carry it. This script applies that skill from the
 * manifest.
 *
 * Optional: pass `ATTACH_AGENT=<slug>` to ALSO attach `table_authoring` to a
 * specific agent's skill_slugs (an override beyond the manifest's default
 * wiring) — e.g. to let Saskia build grids inline.
 *
 * Usage:
 *   ALLOWED_USER_ID=<uuid> pnpm tsx scripts/seed-tables-skill.ts
 *   ALLOWED_USER_ID=<uuid> ATTACH_AGENT=saskia pnpm tsx scripts/seed-tables-skill.ts
 *
 * Idempotent: refreshes the skill; optionally attaches to ATTACH_AGENT.
 */

import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { db, agents } from '@mantle/db';
import { applyManifest } from '../lib/system-manifest/seed';

const SKILL_SLUG = 'table_authoring';

/** Attach the skill to an explicit ATTACH_AGENT override (beyond the manifest's
 *  default wiring). No-op if the agent already has it. */
async function attachToAgent(ownerId: string, agentSlug: string): Promise<void> {
  const [row] = await db
    .select({ id: agents.id, skillSlugs: agents.skillSlugs })
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.slug, agentSlug)))
    .limit(1);
  if (!row) {
    console.warn(`[seed] ATTACH_AGENT='${agentSlug}' not found — skipped`);
    return;
  }
  const current = row.skillSlugs ?? [];
  if (current.includes(SKILL_SLUG)) {
    console.log(`[seed] agent ${agentSlug} already has skill ${SKILL_SLUG}`);
    return;
  }
  await db.update(agents).set({ skillSlugs: [...current, SKILL_SLUG], updatedAt: new Date() }).where(eq(agents.id, row.id));
  console.log(`[seed] attached skill ${SKILL_SLUG} to agent ${agentSlug}`);
}

export async function seedTablesSkill(ownerId: string): Promise<void> {
  await applyManifest(ownerId, { onlySkills: ['table_authoring'], mode: 'overwrite' });
  console.log('[seed] table_authoring seeded via manifest.');
  const ATTACH_AGENT = process.env.ATTACH_AGENT;
  if (ATTACH_AGENT) await attachToAgent(ownerId, ATTACH_AGENT);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ownerId = process.env.ALLOWED_USER_ID;
  if (!ownerId) {
    console.error('ALLOWED_USER_ID env var required');
    process.exit(1);
  }
  seedTablesSkill(ownerId)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed] failed:', err);
      process.exit(1);
    });
}
