/**
 * Re-express an owner's agents onto tool groups — the Phase 3 "break up the
 * god-grant" transform applied to an EXISTING brain (docs/tools-and-skills.md).
 *
 * For each agent: compute its current effective tool set (direct tool_slugs ∪
 * enabled attached-skill tools ∪ tools from already-granted groups), then
 * decompose it with the shared deriveGroupGrants helper — grant every fully
 * covered tool group and keep only the residual as direct tool_slugs.
 *
 * Behavior-IDENTICAL: the runtime re-assembles residual ∪ group tools, so the
 * effective set is unchanged. Idempotent: full is reconstructed from groups too,
 * so re-running yields the same decomposition.
 *
 * Fresh installs don't need this — onboarding + applyManifest already seed agents
 * decomposed. This is the retrofit for a brain provisioned before P3.
 *
 * Usage:
 *   ALLOWED_USER_ID=<uuid> pnpm -C apps/web seed:reexpress-tools
 */

import { fileURLToPath } from 'node:url';
import { db, agents, skills, toolGroups, eq } from '@mantle/db';
// Import the helper from the manifest MODULE directly (not the index) to avoid
// pulling integrity.ts's '@/'-aliased imports into a plain tsx run.
import { deriveGroupGrants } from '../lib/system-manifest/manifest';

export async function reexpressAgentTools(ownerId: string): Promise<void> {
  const skillRows = await db
    .select({ slug: skills.slug, enabled: skills.enabled, toolSlugs: skills.toolSlugs })
    .from(skills)
    .where(eq(skills.ownerId, ownerId));
  const skillTools = new Map(skillRows.filter((s) => s.enabled).map((s) => [s.slug, s.toolSlugs ?? []]));

  const groupRows = await db
    .select({ slug: toolGroups.slug, enabled: toolGroups.enabled, toolSlugs: toolGroups.toolSlugs })
    .from(toolGroups)
    .where(eq(toolGroups.ownerId, ownerId));
  const groupTools = new Map(groupRows.filter((g) => g.enabled).map((g) => [g.slug, g.toolSlugs ?? []]));

  const ags = await db
    .select({ id: agents.id, slug: agents.slug, toolSlugs: agents.toolSlugs, skillSlugs: agents.skillSlugs, toolGroupSlugs: agents.toolGroupSlugs })
    .from(agents)
    .where(eq(agents.ownerId, ownerId));

  for (const a of ags) {
    const full = new Set<string>(a.toolSlugs ?? []);
    for (const s of a.skillSlugs ?? []) for (const t of skillTools.get(s) ?? []) full.add(t);
    for (const g of a.toolGroupSlugs ?? []) for (const t of groupTools.get(g) ?? []) full.add(t);
    const { toolSlugs, toolGroupSlugs } = deriveGroupGrants([...full]);
    await db
      .update(agents)
      .set({ toolSlugs, toolGroupSlugs, updatedAt: new Date() })
      .where(eq(agents.id, a.id));
    console.log(`[reexpress] ${a.slug}: ${full.size} tools → ${toolSlugs.length} direct + ${toolGroupSlugs.length} groups [${toolGroupSlugs.join(', ')}]`);
  }
  console.log('[reexpress] done — effective tool sets unchanged (groups expand back at runtime).');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ownerId = process.env.ALLOWED_USER_ID;
  if (!ownerId) {
    console.error('ALLOWED_USER_ID env var required');
    process.exit(1);
  }
  reexpressAgentTools(ownerId)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[reexpress] failed:', err);
      process.exit(1);
    });
}
