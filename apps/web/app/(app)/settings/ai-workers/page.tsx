import { nativeDocumentProviders } from '@mantle/voice';
import { requireOwner } from '@/lib/auth';
import { listAiWorkers } from '@/lib/ai-workers';
import { listApiKeys } from '@/lib/api-keys';
import { getTailnetPeerNames } from '@/lib/tailscale';
import { SetPageTitle } from '@/components/layout/page-title';
import { AiWorkersClient } from './ai-workers-client';
import { createAiWorkerAction, deleteAiWorkerAction, updateAiWorkerAction } from './actions';

export default async function AiWorkersPage({
  searchParams,
}: {
  searchParams: Promise<{ selected?: string }>;
}) {
  const user = await requireOwner();
  const sp = await searchParams;
  const [workers, keys, tailnetPeers] = await Promise.all([
    listAiWorkers(user.id),
    listApiKeys(user.id),
    getTailnetPeerNames(),
  ]);

  // Generic wrappers so the client can call them with a runtime-selected id.
  async function updateAction(id: string, formData: FormData) {
    'use server';
    await updateAiWorkerAction(id, formData);
  }
  async function deleteAction(id: string) {
    'use server';
    await deleteAiWorkerAction(id);
  }

  return (
    <>
      <SetPageTitle title="AI workers" />
      <AiWorkersClient
        workers={workers}
        keys={keys.map((k) => ({
          id: k.id,
          service: k.service,
          label: k.label,
          masked: k.masked,
        }))}
        initialSelectedId={sp.selected ?? null}
        createAction={createAiWorkerAction}
        updateAction={updateAction}
        deleteAction={deleteAction}
        nativeDocProviders={nativeDocumentProviders() as string[]}
        tailnetPeers={tailnetPeers}
      />
    </>
  );
}
