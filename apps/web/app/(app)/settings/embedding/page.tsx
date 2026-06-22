import { requireOwner } from '@/lib/auth';
import { listApiKeys } from '@/lib/api-keys';
import { EMBEDDING_DIMS, getEmbeddingConfig } from '@/lib/embedding-config';
import { SetPageTitle } from '@/components/layout/page-title';
import { EmbeddingClient } from './embedding-client';
import {
  rebuildEmbeddingIndexAction,
  saveEmbeddingConfigAction,
  testEmbeddingRouteAction,
} from './actions';

export default async function EmbeddingPage() {
  const user = await requireOwner();
  const [config, keys] = await Promise.all([getEmbeddingConfig(user.id), listApiKeys(user.id)]);

  return (
    <>
      <SetPageTitle title="Embedding" />
      <EmbeddingClient
        config={
          config
            ? {
                model: config.model,
                dimensions: config.dimensions,
                primaryProvider: config.primaryProvider,
                primaryBaseUrl: config.primaryBaseUrl,
                primaryApiKeyId: config.primaryApiKeyId,
                primaryLabel: config.primaryLabel,
                backupEnabled: config.backupEnabled,
                backupProvider: config.backupProvider,
                backupBaseUrl: config.backupBaseUrl,
                backupApiKeyId: config.backupApiKeyId,
                backupLabel: config.backupLabel,
                lastFailoverAt: config.lastFailoverAt?.toISOString() ?? null,
                extractionConcurrency: config.extractionConcurrency,
                extractionTimeBudgetMinutes: config.extractionTimeBudgetMinutes,
                localEmbedBatchSize: config.localEmbedBatchSize,
                localEmbedRequestTimeoutMs: config.localEmbedRequestTimeoutMs,
              }
            : null
        }
        columnDims={EMBEDDING_DIMS}
        keys={keys.map((k) => ({ id: k.id, service: k.service, label: k.label, masked: k.masked }))}
        saveAction={saveEmbeddingConfigAction}
        testRouteAction={testEmbeddingRouteAction}
        rebuildAction={rebuildEmbeddingIndexAction}
      />
    </>
  );
}
