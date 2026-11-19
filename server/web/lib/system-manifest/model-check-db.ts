/**
 * DB-loading wrapper around the pure model check (./model-check.ts). Reads
 * config columns only: each worker kind's running worker (the runtime's own
 * resolver, getDefaultWorker) and each agent's slug, switch, provider and
 * model. Read-only.
 */
import { db, agents, eq, getDefaultWorker, type AiWorkerKind } from '@mantle/db';
import { APP_VERSION } from '@mantle/client-types/version';
import { registerModelCheckProvider } from '@mantle/tools';
import { MANIFEST_WORKERS } from './manifest';
import {
  checkModels,
  modelCheckReport,
  type ModelCheckReport,
  type ModelCheckWorkerRow,
} from './model-check';

export async function computeModelCheck(ownerId: string): Promise<ModelCheckReport> {
  const [workerRows, agentRows] = await Promise.all([
    Promise.all(
      MANIFEST_WORKERS.map(async (w): Promise<ModelCheckWorkerRow | null> => {
        const row = await getDefaultWorker(ownerId, w.kind as AiWorkerKind);
        return row
          ? { kind: row.kind, provider: row.provider, model: row.model, params: row.params }
          : null;
      }),
    ),
    db
      .select({
        slug: agents.slug,
        enabled: agents.enabled,
        provider: agents.provider,
        model: agents.model,
      })
      .from(agents)
      .where(eq(agents.ownerId, ownerId)),
  ]);
  const workers = workerRows.filter((r): r is ModelCheckWorkerRow => r !== null);
  return modelCheckReport(checkModels({ workers, agents: agentRows }), APP_VERSION);
}

/** Install the check into the model check bridge (@mantle/tools), for
 *  config_models_check. Boot calls it once. */
export function installModelCheckProvider(): void {
  registerModelCheckProvider(computeModelCheck);
}
