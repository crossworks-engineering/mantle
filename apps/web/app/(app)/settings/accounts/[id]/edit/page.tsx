import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAccount } from '@mantle/email';
import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { ImapForm } from '../../imap/imap-form';

/** Edit an existing IMAP account: connection knobs, history window, and an
 *  optional password rotation. The address is fixed (account identity). */
export default async function EditAccountPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await params;

  const account = await getAccount(user.id, id);
  if (!account) notFound();

  return (
    <div className="mx-auto max-w-md space-y-6 px-6 py-8">
      <SetPageTitle title="Edit account" />
      <ImapForm
        account={{
          id: account.id,
          address: account.address,
          displayName: account.displayName,
          imapHost: account.imapHost,
          imapPort: account.imapPort,
          imapSecure: account.imapSecure,
          smtpHost: account.smtpHost,
          smtpPort: account.smtpPort,
          smtpSecure: account.smtpSecure,
          firstScanDays: account.firstScanDays,
        }}
      />
      <p className="text-xs text-muted-foreground">
        <Link href="/settings/accounts" className="underline">
          ← Back to accounts
        </Link>
      </p>
    </div>
  );
}
