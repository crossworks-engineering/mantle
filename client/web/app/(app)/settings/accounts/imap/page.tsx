import Link from 'next/link';
import { SetPageTitle } from '@/components/layout/page-title';
import { ImapForm } from './imap-form';

export default async function AddImapAccountPage() {
  return (
    <div className="mx-auto max-w-md space-y-6 px-6 py-8">
      <SetPageTitle title="Add IMAP account" />
      <ImapForm />
      <p className="text-xs text-muted-foreground">
        <Link href="/settings/accounts" className="underline">
          ← Back to accounts
        </Link>
      </p>
    </div>
  );
}
