import { Users } from 'lucide-react';

/**
 * The contacts-gate explainer shown wherever a mailbox is connected for
 * ingestion. The gate itself lives in the sync pipeline (`loadContactGate`,
 * docs/email-ingest.md §3a) — this is the operator-facing statement of it, so
 * nobody connects an account expecting the whole mailbox to be imported.
 */
export function ContactsGateNotice() {
  return (
    <div className="space-y-2 rounded-md border border-info/30 bg-info/10 p-3 text-sm">
      <p className="flex items-center gap-2 font-medium text-info-ink">
        <Users className="size-4 shrink-0" aria-hidden />
        Only mail from your contacts is brought in
      </p>
      <p className="text-xs text-muted-foreground">
        Connecting this account does <strong>not</strong> import the whole mailbox. Each sync scans
        message headers only — a message&apos;s content is fetched and stored just when its sender
        is on your{' '}
        <a href="/contacts" className="underline underline-offset-2">
          contacts
        </a>{' '}
        list.
      </p>
      <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
        <li>
          A contact entry can be an exact address (<code>jane@example.com</code>) or a whole domain
          (<code>@example.com</code> — everyone at that organisation).
        </li>
        <li>
          Mail from your own connected addresses (Sent items, notes-to-self) is always included.
        </li>
        <li>
          Everything else is skipped entirely — never downloaded, nothing stored — and stays
          untouched on the mail server.
        </li>
        <li>
          No contacts yet means nothing comes in. Add people first, or later — adding a contact
          automatically backfills their recent mail (about the last 90 days).
        </li>
      </ul>
    </div>
  );
}
