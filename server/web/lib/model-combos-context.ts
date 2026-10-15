import { asc, eq } from 'drizzle-orm';
import { db, curatedModels } from '@mantle/db';
import { findProviderKeyIds } from '@mantle/api-keys';
import { listAgents } from '@/lib/agents';
import { listAiWorkers } from '@/lib/ai-workers';
import { MODEL_POOL_IDS } from '@/lib/model-pools';
import type { PoolEntry, TargetInput } from '@/lib/model-combos';

/** Load everything a combo diff needs for this owner. Shared with apply. */
export async function loadComboContext(ownerId: string) {
  const entryRows = await db
    .select()
    .from(curatedModels)
    .where(eq(curatedModels.ownerId, ownerId))
    .orderBy(asc(curatedModels.pool), asc(curatedModels.position));
  const entries: PoolEntry[] = entryRows.map((e) => ({
    pool: e.pool,
    position: e.position,
    name: e.name,
    rating: e.rating,
    note: e.note,
    routes: e.routes as PoolEntry['routes'],
    pricing: e.pricing as PoolEntry['pricing'],
  }));

  const agents = await listAgents(ownerId);
  const workers = await listAiWorkers(ownerId);
  const targets: TargetInput[] = [
    ...agents
      .filter((a) => a.enabled)
      .map((a) => ({
        id: a.id,
        kind: 'agent' as const,
        label: a.name,
        pool: 'agents',
        provider: a.provider,
        model: a.model,
      })),
    ...workers
      .filter((w) => w.isDefault && MODEL_POOL_IDS.has(w.kind))
      .map((w) => ({
        id: w.id,
        kind: 'worker' as const,
        label: w.name,
        pool: w.kind,
        provider: w.provider,
        model: w.model,
      })),
  ];

  // One key per service: the one an unpinned lookup uses.
  const keyIdByService = await findProviderKeyIds(ownerId);
  return { entries, targets, keyIdByService };
}
