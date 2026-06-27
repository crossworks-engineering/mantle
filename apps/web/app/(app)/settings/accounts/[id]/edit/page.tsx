import Link from 'next/link';
import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { EditAccountClient } from './edit-account-client';

/** Edit an existing IMAP account: connection knobs, history window, and an
 *  optional password rotation. Data-free — EditAccountClient fetches the
 *  account from GET /api/email/accounts/[id] and seeds the shared ImapForm. */
export default async function EditAccountPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;

  return (
    <div className="mx-auto max-w-md space-y-6 px-6 py-8">
      <SetPageTitle title="Edit account" />
      <EditAccountClient id={id} />
      <p className="text-xs text-muted-foreground">
        <Link href="/settings/accounts" className="underline">
          ← Back to accounts
        </Link>
      </p>
    </div>
  );
}
