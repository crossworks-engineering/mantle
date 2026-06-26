import Link from 'next/link';
import { Plug } from 'lucide-react';
import { listImapAccounts } from '@mantle/email';
import { requireOwner } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { SetPageTitle } from '@/components/layout/page-title';
import { DiscoverClient } from './discover-client';

/**
 * /settings/discover — find senders who recently emailed you but aren't yet in
 * your contacts. Contacts are the inbound allowlist, so anyone here is NOT being
 * ingested until you add them. The scan is live (reads IMAP on demand, persists
 * nothing); see actions.ts.
 */
export default async function DiscoverPage() {
  const user = await requireOwner();
  const accounts = await listImapAccounts(user.id, { enabledOnly: true });

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

      {accounts.length === 0 ? (
        <div className="space-y-4 rounded-lg border border-border bg-muted/20 px-6 py-12 text-center">
          <Plug className="mx-auto size-7 text-muted-foreground" aria-hidden />
          <p className="text-sm text-muted-foreground">
            No email accounts connected yet — connect one to discover senders.
          </p>
          <Button asChild>
            <Link href="/settings/accounts">
              <Plug aria-hidden /> Connect an account
            </Link>
          </Button>
        </div>
      ) : (
        <DiscoverClient />
      )}
    </div>
  );
}
