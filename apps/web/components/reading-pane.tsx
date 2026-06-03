import { Inbox, Mail, MailOpen, Paperclip, Star } from 'lucide-react';
import { sanitizeEmailHtml } from '@mantle/email';
import type { Email, EmailAttachment } from '@mantle/db';
import { setEmailReadStatus, setEmailStarred } from '@/app/(app)/email-actions';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/format-datetime';

/**
 * Right-hand pane that renders the selected email. Server-component so
 * the body sanitisation happens before the HTML ever touches the browser;
 * the iframe is a second defense layer.
 *
 * Empty selection renders a placeholder so the column isn't blank when
 * you land on the dashboard without `?email=` set.
 */

export function ReadingPane({
  email,
  attachments,
}: {
  email: Email | null;
  attachments: EmailAttachment[];
}) {
  if (!email) return <EmptyPane />;

  const bodyHtmlSafe = email.bodyHtml ? sanitizeEmailHtml(email.bodyHtml) : undefined;

  return (
    <article className="flex h-full flex-col">
      <header className="space-y-1 border-b border-border px-6 py-4">
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-lg font-semibold leading-snug">{email.subject || '(no subject)'}</h1>
          <div className="flex shrink-0 items-center gap-1">
            <form action={setEmailStarred}>
              <input type="hidden" name="emailId" value={email.id} />
              <input type="hidden" name="starred" value={email.isStarred ? '0' : '1'} />
              <button
                type="submit"
                title={email.isStarred ? 'Unstar' : 'Star'}
                aria-label={email.isStarred ? 'Unstar' : 'Star'}
                className="inline-flex items-center rounded-md border border-input bg-background p-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                <Star
                  className={cn('size-3.5', email.isStarred && 'fill-amber-400 text-amber-400')}
                  aria-hidden
                />
              </button>
            </form>
            <form action={setEmailReadStatus}>
              <input type="hidden" name="emailId" value={email.id} />
              <input type="hidden" name="read" value={email.isRead ? '0' : '1'} />
              <button
                type="submit"
                title={email.isRead ? 'Mark unread' : 'Mark read'}
                aria-label={email.isRead ? 'Mark unread' : 'Mark read'}
                className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                {email.isRead ? (
                  <>
                    <Mail className="size-3.5" aria-hidden /> Mark unread
                  </>
                ) : (
                  <>
                    <MailOpen className="size-3.5" aria-hidden /> Mark read
                  </>
                )}
              </button>
            </form>
          </div>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <dt>From</dt>
          <dd className="truncate">
            {email.fromName ? (
              <>
                <span className="text-foreground">{email.fromName}</span>{' '}
                <span>&lt;{email.fromAddr}&gt;</span>
              </>
            ) : (
              <span className="text-foreground">{email.fromAddr}</span>
            )}
          </dd>
          <dt>To</dt>
          <dd className="truncate">{email.toAddrs.join(', ') || '(none)'}</dd>
          {email.ccAddrs.length > 0 && (
            <>
              <dt>Cc</dt>
              <dd className="truncate">{email.ccAddrs.join(', ')}</dd>
            </>
          )}
          <dt>Date</dt>
          <dd>
            <time dateTime={email.internalDate.toISOString()}>
              {formatDateTime(email.internalDate)}
            </time>
          </dd>
          {email.folder && (
            <>
              <dt>Folder</dt>
              <dd className="truncate">{email.folder}</dd>
            </>
          )}
        </dl>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        <Body bodyText={email.bodyText} bodyHtmlSafe={bodyHtmlSafe} />
      </div>

      {attachments.length > 0 && (
        <footer className="border-t border-border px-6 py-3 text-xs">
          <p className="mb-1 flex items-center gap-1 font-medium text-muted-foreground">
            <Paperclip className="size-3" aria-hidden />
            {attachments.length} attachment{attachments.length === 1 ? '' : 's'}
          </p>
          <ul className="space-y-0.5">
            {attachments.map((a) => (
              <li key={a.id}>
                <a
                  href={`/api/attachments/${a.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline-offset-2 hover:underline"
                >
                  {a.filename}
                </a>
                <span className="ml-2 text-muted-foreground">
                  {a.mimeType ?? 'unknown'}
                  {a.sizeBytes ? ` · ${formatBytes(a.sizeBytes)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </footer>
      )}
    </article>
  );
}

function Body({ bodyText, bodyHtmlSafe }: { bodyText: string | null; bodyHtmlSafe?: string }) {
  if (bodyHtmlSafe) {
    const srcDoc =
      '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
      '<base target="_blank">' +
      `<style>
        html,body{margin:0;padding:16px;background:white;color:#111;font-family:-apple-system,system-ui,sans-serif;font-size:14px;line-height:1.5;word-wrap:break-word;}
        a{color:#1d4ed8;}
        table{border-collapse:collapse;max-width:100%;}
        img{max-width:100%;height:auto;}
        pre{white-space:pre-wrap;}
      </style>` +
      '</head><body>' +
      bodyHtmlSafe +
      '</body></html>';
    return (
      <iframe
        title="Email body"
        srcDoc={srcDoc}
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        className="h-full w-full"
      />
    );
  }

  if (bodyText) {
    return (
      <div className="h-full overflow-auto px-6 py-4">
        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
          {bodyText}
        </pre>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      (no body)
    </div>
  );
}

function EmptyPane() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
      <Inbox className="size-8 opacity-40" aria-hidden />
      <p>Select an email to read.</p>
    </div>
  );
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
