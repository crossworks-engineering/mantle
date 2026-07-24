import { Suspense } from 'react';
import { requireOwner } from '@/lib/auth';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { OnboardingClient } from './onboarding-client';

/**
 * First-run wizard entry. Requires a session (auth only — data-free). The
 * already-onboarded redirect (with the `?force=1` bypass for re-running on a
 * populated stack) and the resume state now live client-side in
 * OnboardingClient, fetched from GET /api/onboarding; each step posts to
 * POST /api/onboarding. Wrapped in <Suspense> because the client reads
 * useSearchParams (for ?force).
 */
export default async function OnboardingPage() {
  await requireOwner();
  return (
    <Suspense
      fallback={
        <div className="flex h-dvh items-center justify-center">
          <Spinner />
        </div>
      }
    >
      <OnboardingClient />
    </Suspense>
  );
}
