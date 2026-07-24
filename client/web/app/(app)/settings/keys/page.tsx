import { SetPageTitle } from '@/components/layout/page-title';
import { KeysClient } from './keys-client';

/**
 * /settings/api-keys — sealed provider API keys. Data-free: KeysClient fetches
 * GET /api/keys, mutates via POST/DELETE /api/keys (+ /[id]/rotate), and probes
 * a key via POST /api/keys/test.
 */
export default async function KeysSettingsPage() {
  return (
    <>
      <SetPageTitle title="API keys" />
      <KeysClient />
    </>
  );
}
