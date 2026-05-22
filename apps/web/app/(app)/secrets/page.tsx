import { requireOwner } from '@/lib/auth';
import { listSecretTags, listSecrets } from '@/lib/secrets';
import { SetPageTitle } from '@/components/layout/page-title';
import { SecretsClient } from './secrets-client';

export default async function SecretsPage() {
  const user = await requireOwner();
  const [rows, tags] = await Promise.all([
    listSecrets(user.id),
    listSecretTags(user.id),
  ]);

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
      <SetPageTitle title="Secrets" />
      <SecretsClient initialSecrets={rows} availableTags={tags} />
    </div>
  );
}
