import { Suspense } from 'react';
import { SetPageTitle } from '@/components/layout/page-title';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { MicrosoftClient } from './microsoft-client';

/**
 * /settings/microsoft — connect Microsoft 365 (SharePoint / OneDrive / Outlook).
 * Auth gate only; the Azure-app config, connected accounts, per-account drives,
 * and mail status are all client-fetched via `/api/microsoft/**` (Phase 2 ·
 * Task 4). The OAuth start/callback stay as plain server routes (they 302 to
 * Microsoft).
 */
export default async function MicrosoftSettingsPage() {
  return (
    <>
      <SetPageTitle title="Microsoft" />
      {/* useSearchParams (OAuth result banner) needs a Suspense boundary. */}
      <Suspense
        fallback={
          <div className="flex items-center justify-center py-16">
            <Spinner />
          </div>
        }
      >
        <MicrosoftClient />
      </Suspense>
    </>
  );
}
