'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, Plug, UserCheck } from 'lucide-react';
import type { MessageDetailDTO } from '@mantle/client-types';
import type { PublicEmailAccount, FolderFacet, MessageListItem } from '@mantle/email';
import { apiFetch, apiSend } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { EmailRow } from '@/components/email-row';
import { ReadingPane } from '@/components/reading-pane';
import { MailClient } from '@/components/mail/mail-client';
import { folderLabel } from '@/components/mail/folder-icon';
import type { FolderLink } from '@/components/mail/mail-nav';
import type { MailAccount } from '@/components/mail/account-switcher';

type MessageDetail = MessageDetailDTO;

/** Build a /inbox URL preserving the 3-pane navigation context. */
function inboxHref(p: {
  account: string;
  folder?: string | null;
  tab?: string;
  email?: string | null;
}): string {
  const params = new URLSearchParams();
  params.set('account', p.account);
  if (p.folder) params.set('folder', p.folder);
  if (p.tab && p.tab !== 'all') params.set('tab', p.tab);
  if (p.email) params.set('email', p.email);
  return `/inbox?${params.toString()}`;
}

/**
 * Client orchestrator for the 3-pane inbox. Replaces the old SSR page body:
 * every read is now a `useQuery` against `/api/email/**`, and the two gates
 * (no accounts / empty contact allowlist) render client-side. Navigation is
 * still URL-driven — the nav/switcher emit `?account=&folder=&tab=&email=`
 * Links, which re-key the queries here.
 */
export function InboxClient() {
  const search = useSearchParams();
  const queryClient = useQueryClient();

  const accountParam = search.get('account') ?? undefined;
  const folderParam = search.get('folder') ?? undefined;
  const tab: 'all' | 'unread' = search.get('tab') === 'unread' ? 'unread' : 'all';
  const selectedId = search.get('email') ?? undefined;

  const accountsQuery = useQuery({
    queryKey: ['email', 'accounts'],
    queryFn: () =>
      apiFetch<{ accounts: PublicEmailAccount[] }>('/api/email/accounts').then((r) => r.accounts),
  });

  const gateQuery = useQuery({
    queryKey: ['email', 'contact-gate'],
    queryFn: () => apiFetch<{ isEmpty: boolean }>('/api/email/contact-gate').then((r) => r.isEmpty),
  });

  const accounts = accountsQuery.data ?? [];
  const currentAccount = accounts.find((a) => a.id === accountParam) ?? accounts[0];
  const accountId = currentAccount?.id;

  const foldersQuery = useQuery({
    queryKey: ['email', 'folders', accountId],
    queryFn: () =>
      apiFetch<{ folders: FolderFacet[] }>(`/api/email/folders?account=${accountId}`).then(
        (r) => r.folders,
      ),
    enabled: !!accountId,
  });

  const facetRows = foldersQuery.data ?? [];
  const facetNames = facetRows.map((f) => f.folder);
  const selectedFolder =
    (folderParam && facetNames.includes(folderParam) ? folderParam : null) ??
    facetNames.find((f) => f.toUpperCase() === 'INBOX') ??
    facetNames[0] ??
    null;

  const messagesQuery = useQuery({
    queryKey: ['email', 'messages', { accountId, folder: selectedFolder, tab }],
    queryFn: () => {
      const sp = new URLSearchParams({ account: accountId! });
      if (selectedFolder) sp.set('folder', selectedFolder);
      if (tab === 'unread') sp.set('unread', 'true');
      return apiFetch<{ messages: MessageListItem[] }>(`/api/email/messages?${sp.toString()}`).then(
        (r) => r.messages,
      );
    },
    // Wait for the facets so the folder is resolved before the first fetch
    // (otherwise we'd briefly list every folder, then narrow to INBOX).
    enabled: !!accountId && !foldersQuery.isPending,
    placeholderData: (prev) => prev,
  });

  const messageQuery = useQuery({
    queryKey: ['email', 'message', selectedId],
    queryFn: () => apiFetch<MessageDetail>(`/api/email/messages/${selectedId}`),
    enabled: !!selectedId,
  });

  // Mark-read-on-select — mirrors the SSR page's unconditional setReadStatus on
  // view. Fire once per selection (the read flag moves folder unread counts);
  // a per-id ref keeps a later "mark unread" from being clobbered.
  const markedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!selectedId || markedRef.current === selectedId) return;
    markedRef.current = selectedId;
    apiSend(`/api/email/messages/${selectedId}`, 'PATCH', { read: true })
      .then(() => {
        queryClient.invalidateQueries({ queryKey: ['email', 'message', selectedId] });
        queryClient.invalidateQueries({ queryKey: ['email', 'messages'] });
        queryClient.invalidateQueries({ queryKey: ['email', 'folders'] });
      })
      .catch(() => {});
  }, [selectedId, queryClient]);

  const defaultCollapsed = React.useMemo(() => {
    if (typeof document === 'undefined') return false;
    return document.cookie.split('; ').includes('react-resizable-panels:collapsed=true');
  }, []);

  const navAccounts: MailAccount[] = React.useMemo(
    () => accounts.map((a) => ({ id: a.id, address: a.address, provider: a.provider })),
    [accounts],
  );

  // Gate: still loading accounts.
  if (accountsQuery.isPending) return <CenterSpinner />;
  if (accountsQuery.isError && accounts.length === 0) {
    return <CenterError onRetry={() => accountsQuery.refetch()} />;
  }

  // Gate: no connected accounts → connect prompt.
  if (accounts.length === 0) {
    return (
      <div className="mx-auto max-w-xl space-y-4 px-6 py-16 text-center">
        <Mail className="mx-auto size-8 text-muted-foreground" aria-hidden />
        <h2 className="text-xl font-semibold">
          Your inbox is empty because nothing&apos;s plugged in.
        </h2>
        <p className="text-sm text-muted-foreground">
          Connect your first email account and Mantle will start pulling messages, attachments, and
          metadata into your tree.
        </p>
        <Button asChild>
          <Link href="/settings/accounts">
            <Plug aria-hidden /> Connect an account
          </Link>
        </Button>
      </div>
    );
  }

  // Gate: account connected but the contacts allowlist is empty → nudge.
  // Contacts are the SOLE inbound gate now: mail is ingested only from a
  // contact's address or `@domain` wildcard, so with no contacts nothing lands.
  if (gateQuery.isPending) return <CenterSpinner />;
  if (gateQuery.data === true) {
    return (
      <div className="mx-auto max-w-xl space-y-4 px-6 py-16 text-center">
        <UserCheck className="mx-auto size-8 text-muted-foreground" aria-hidden />
        <h2 className="text-xl font-semibold">
          No contacts yet — so nothing&apos;s being ingested.
        </h2>
        <p className="text-sm text-muted-foreground">
          Mantle only pulls mail from people in your contacts — an address like{' '}
          <code className="rounded bg-muted px-1">you@example.com</code> or a whole domain like{' '}
          <code className="rounded bg-muted px-1">@example.com</code>. Add a contact to start, or
          discover who&apos;s recently emailed you.
        </p>
        <div className="flex justify-center gap-2">
          <Button asChild>
            <Link href="/contacts">Add a contact</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/settings/discover">Discover senders</Link>
          </Button>
        </div>
      </div>
    );
  }

  const folders: FolderLink[] = facetRows.map((f) => ({
    name: f.folder,
    count: f.count,
    unread: f.unread,
    active: f.folder === selectedFolder,
    href: inboxHref({ account: accountId!, folder: f.folder, tab }),
  }));

  const folderTitle = selectedFolder ? folderLabel(selectedFolder) : 'All mail';

  const rows = messagesQuery.data ?? [];
  const listSlot = messagesQuery.isPending ? (
    <CenterSpinner />
  ) : messagesQuery.isError ? (
    <p className="px-4 py-6 text-sm text-destructive">
      Couldn&apos;t load messages.{' '}
      <button type="button" onClick={() => messagesQuery.refetch()} className="underline">
        Retry
      </button>
    </p>
  ) : rows.length === 0 ? (
    <p className="px-4 py-6 text-sm text-muted-foreground">No messages here yet.</p>
  ) : (
    <div className="divide-y divide-border">
      {rows.map((r) => (
        <EmailRow
          key={r.id}
          id={r.id}
          fromAddr={r.fromAddr}
          fromName={r.fromName}
          subject={r.subject}
          snippet={r.snippet}
          internalDate={new Date(r.internalDate)}
          isRead={r.isRead}
          selected={r.id === selectedId}
          href={inboxHref({ account: accountId!, folder: selectedFolder, tab, email: r.id })}
        />
      ))}
    </div>
  );

  const readerSlot = !selectedId ? (
    <ReadingPane email={null} attachments={[]} bodyHtmlSafe={null} />
  ) : messageQuery.isPending ? (
    <CenterSpinner />
  ) : messageQuery.isError || !messageQuery.data ? (
    <p className="px-6 py-6 text-sm text-destructive">
      Couldn&apos;t load this message.{' '}
      <button type="button" onClick={() => messageQuery.refetch()} className="underline">
        Retry
      </button>
    </p>
  ) : (
    <ReadingPane
      email={messageQuery.data.email}
      attachments={messageQuery.data.attachments}
      bodyHtmlSafe={messageQuery.data.bodyHtmlSafe}
    />
  );

  return (
    <MailClient
      accounts={navAccounts}
      currentAccountId={accountId!}
      folders={folders}
      folderTitle={folderTitle}
      tab={tab}
      tabAllHref={inboxHref({
        account: accountId!,
        folder: selectedFolder,
        tab: 'all',
        email: selectedId,
      })}
      tabUnreadHref={inboxHref({
        account: accountId!,
        folder: selectedFolder,
        tab: 'unread',
        email: selectedId,
      })}
      defaultCollapsed={defaultCollapsed}
      listSlot={listSlot}
      readerSlot={readerSlot}
    />
  );
}

function CenterSpinner() {
  return (
    <div className="flex h-full items-center justify-center py-16">
      <Spinner />
    </div>
  );
}

function CenterError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 py-16 text-sm text-muted-foreground">
      <p>Couldn&apos;t load your inbox.</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
