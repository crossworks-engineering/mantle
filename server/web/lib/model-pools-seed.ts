import { eq } from 'drizzle-orm';
import { db, curatedModels } from '@mantle/db';
import { CURATED_MODEL_POOLS } from '@mantle/client-types/model-pools-data';
import { MODEL_POOL_IDS } from '@mantle/client-types/model-pools';

/**
 * Seed the repo-shipped curated-model template into `curated_models` — but
 * ONLY for an owner with ZERO curated entries. One curated row (any pool)
 * means the owner (or their Curator) has judgment on record, and the template
 * must never overwrite or interleave with it. Fresh installs get the template
 * at onboarding; an existing brain that never curated picks it up on the
 * version-bump boot reconcile. Best-effort by design — pool ids that the
 * running build doesn't know (template newer than the kind enum) are skipped.
 */
export async function seedCuratedModelPools(
  ownerId: string,
): Promise<{ seeded: number; skipped: 'has-entries' | null }> {
  const [existing] = await db
    .select({ id: curatedModels.id })
    .from(curatedModels)
    .where(eq(curatedModels.ownerId, ownerId))
    .limit(1);
  if (existing) return { seeded: 0, skipped: 'has-entries' };
  const rows = CURATED_MODEL_POOLS.filter((e) => MODEL_POOL_IDS.has(e.pool)).map((e) => ({
    ownerId,
    pool: e.pool,
    position: e.position,
    name: e.name,
    vendor: e.vendor,
    routes: e.routes,
    pricing: e.pricing,
    rating: e.rating,
    note: e.note,
  }));
  if (rows.length === 0) return { seeded: 0, skipped: null };
  await db.insert(curatedModels).values(rows).onConflictDoNothing();
  return { seeded: rows.length, skipped: null };
}
