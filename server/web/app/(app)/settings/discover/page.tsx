import Link from 'next/link';
import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { DiscoverClient } from './discover-client';

/**
 * /settings/discover — find senders who recently emailed you but aren't yet in
 * your contacts (the inbound allowlist). Auth gate only; the account gate, the
 * live IMAP scan, and the promote-to-contact action are all client-fetched via
 * `/api/email/**` (Phase 2 · Task 4).
 */
export default async function DiscoverPage() {
  await requireOwner();
  return (
    <div className="mx-auto max-w-2xl space-y-6 px-6 py-6">
      <SetPageTitle title="Discover senders" />
      <header className="space-y-1">
        <h1 className="text-lg font-semibold">Discover senders</h1>
        <p className="text-sm text-muted-foreground">
          Mantle only ingests mail from people in your{' '}
          <Link href="/contacts" className="text-primary underline-offset-2 hover:underline">
            contacts
          </Link>
          . This is a live look at who else has recently written, so you can add the ones worth
          keeping.
        </p>
      </header>

      <DiscoverClient />
    </div>
  );
}
