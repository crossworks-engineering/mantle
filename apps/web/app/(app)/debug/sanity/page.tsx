import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { DebugTabs } from '../debug-tabs';
import { SanityClient } from './sanity-client';

export const dynamic = 'force-dynamic';

/**
 * System sanity checker. Read-only config-correctness checks for the class of
 * break that hides in env vars or in a step only scripts/up.sh performs — a
 * missing MinIO bucket, an unconfigured updater (MANTLE_STACK_DIR), missing
 * secrets, a cwd-relative files root, a localhost public URL, an unloaded
 * embedder model, a missing job schema. Each failure shows the fix; nothing is
 * mutated from here.
 */
export default async function SanityPage() {
  await requireOwner();

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-6 py-8">
      <DebugTabs />
      <SetPageTitle title="Sanity check" />
      <SanityClient />
    </div>
  );
}
