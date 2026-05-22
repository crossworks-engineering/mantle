import { requireOwner } from '@/lib/auth';
import { listApiKeys } from '@/lib/api-keys';
import { SetPageTitle } from '@/components/layout/page-title';
import { KeysClient } from './keys-client';

export default async function KeysSettingsPage() {
  const user = await requireOwner();
  const keys = await listApiKeys(user.id);

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-8">
      <SetPageTitle title="API keys" />

      <KeysClient
        initialKeys={keys.map((k) => ({
          id: k.id,
          service: k.service,
          label: k.label,
          masked: k.masked,
          lastUsed: k.lastUsed?.toISOString() ?? null,
          updatedAt: k.updatedAt.toISOString(),
        }))}
      />
    </div>
  );
}
