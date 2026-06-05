/**
 * Seeds the `rich_writing` skill — the behaviour pack that gives Saskia her
 * Notion-style writing ability.
 *
 * Thin wrapper: the skill definition (instructions, tools) now lives in the
 * system manifest, which also attaches it to the personas that should carry it.
 * This script applies that skill from the manifest.
 *
 * Optional: pass `AGENT_SLUG=<slug>` to ALSO attach `rich_writing` to a specific
 * agent's skill_slugs (an override beyond the manifest's default wiring).
 *
 * Usage:
 *   ALLOWED_USER_ID=<uuid> pnpm tsx scripts/seed-rich-writing-skill.ts
 *   ALLOWED_USER_ID=<uuid> AGENT_SLUG=saskia pnpm tsx scripts/seed-rich-writing-skill.ts
 *
 * Idempotent: re-running refreshes the skill and adds it to the override
 * agent's skill_slugs only if missing.
 */

import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { db, agents } from '@mantle/db';
import { applyManifest } from '../lib/system-manifest/seed';

const SKILL_SLUG = 'rich_writing';

/** Attach the skill to an explicit AGENT_SLUG override (beyond the manifest's
 *  default wiring). No-op if the agent already has it. */
async function attachToAgent(ownerId: string, agentSlug: string): Promise<void> {
  const [row] = await db
    .select({ id: agents.id, skillSlugs: agents.skillSlugs })
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.slug, agentSlug)))
    .limit(1);
  if (!row) {
    console.warn(`[seed] AGENT_SLUG='${agentSlug}' not found — skipped`);
    return;
  }
  const current = row.skillSlugs ?? [];
  if (current.includes(SKILL_SLUG)) {
    console.log(`[seed] agent ${agentSlug} already has skill ${SKILL_SLUG}`);
    return;
  }
  await db
    .update(agents)
    .set({ skillSlugs: [...current, SKILL_SLUG], updatedAt: new Date() })
    .where(eq(agents.id, row.id));
  console.log(`[seed] attached skill ${SKILL_SLUG} to agent ${agentSlug}`);
}

export async function seedRichWritingSkill(ownerId: string): Promise<void> {
  await applyManifest(ownerId, { onlySkills: ['rich_writing'], mode: 'overwrite' });
  console.log('[seed] rich_writing seeded via manifest.');
  const AGENT_SLUG_OVERRIDE = process.env.AGENT_SLUG;
  if (AGENT_SLUG_OVERRIDE) await attachToAgent(ownerId, AGENT_SLUG_OVERRIDE);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ownerId = process.env.ALLOWED_USER_ID;
  if (!ownerId) {
    console.error('ALLOWED_USER_ID env var required');
    process.exit(1);
  }
  seedRichWritingSkill(ownerId)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed] failed:', err);
      process.exit(1);
    });
}
