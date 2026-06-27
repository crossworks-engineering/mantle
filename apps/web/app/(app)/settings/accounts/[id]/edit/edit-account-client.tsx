'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api-fetch';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { ImapForm, type ImapFormAccount } from '../../imap/imap-form';

/**
 * Edit an existing IMAP account, data-free: fetch the (credential-stripped)
 * account from GET /api/email/accounts/[id] and seed the shared ImapForm.
 */
export function EditAccountClient({ id }: { id: string }) {
  const accountQuery = useQuery({
    queryKey: ['email', 'accounts', id],
    queryFn: () => apiFetch<{ account: ImapFormAccount }>(`/api/email/accounts/${id}`),
    retry: false,
  });

  if (accountQuery.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }

  if (accountQuery.isError) {
    const notFound = accountQuery.error instanceof ApiError && accountQuery.error.status === 404;
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-center text-sm text-muted-foreground">
        <p>{notFound ? 'That account no longer exists.' : "Couldn't load this account."}</p>
        {notFound ? (
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/accounts">← Back to accounts</Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={() => accountQuery.refetch()}>
            Retry
          </Button>
        )}
      </div>
    );
  }

  const a = accountQuery.data.account;
  return (
    <ImapForm
      account={{
        id: a.id,
        address: a.address,
        displayName: a.displayName,
        imapHost: a.imapHost,
        imapPort: a.imapPort,
        imapSecure: a.imapSecure,
        smtpHost: a.smtpHost,
        smtpPort: a.smtpPort,
        smtpSecure: a.smtpSecure,
        firstScanDays: a.firstScanDays,
      }}
    />
  );
}
