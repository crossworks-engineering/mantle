import Link from 'next/link';
import { requireOwner } from '@/lib/auth';
import { ImapForm } from './imap-form';

export default async function AddImapAccountPage() {
  await requireOwner();
  return (
    <div className="mx-auto max-w-md space-y-6 px-6 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Add IMAP account</h1>
        <p className="text-sm text-muted-foreground">
          Mantle will scan the last 12 months of headers to populate your senders list. Bodies and
          attachments are only stored for senders you approve.
        </p>
      </header>
      <ImapForm />
      <p className="text-xs text-muted-foreground">
        <Link href="/settings/accounts" className="underline">
          ← Back to accounts
        </Link>
      </p>
    </div>
  );
}
