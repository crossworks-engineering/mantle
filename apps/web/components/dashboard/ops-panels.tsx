import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { AlertTriangle, Mail, MessageCircle, HeartPulse } from 'lucide-react';
import type { EmailStats, HeartbeatStats, TelegramStats } from '@/lib/dashboard';
import type { RecentFailure, TopError } from '@/lib/metrics';
import { formatCount } from '@mantle/web-ui/lib/format-bytes';
import { Badge } from '@mantle/web-ui/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@mantle/web-ui/ui/card';
import { cn } from '@mantle/web-ui/lib/utils';

function rel(iso: string | null): string {
  if (!iso) return 'never';
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return '—';
  }
}

function syncTone(status: string): string {
  if (status === 'ok') return 'text-emerald-600 dark:text-emerald-400';
  if (status === 'error') return 'text-destructive';
  if (status === 'running') return 'text-blue-600 dark:text-blue-400';
  return 'text-muted-foreground';
}

export function OpsPanels({
  email,
  telegram,
  heartbeats,
  topErrors,
  recentFailures,
}: {
  email: EmailStats;
  telegram: TelegramStats;
  heartbeats: HeartbeatStats;
  topErrors: TopError[];
  recentFailures: RecentFailure[];
}) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* Email sync */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="flex items-center gap-1.5 text-base">
            <Mail className="size-4 text-muted-foreground" aria-hidden /> Email sync
          </CardTitle>
          <Link
            href="/settings/accounts"
            className="text-xs text-primary underline-offset-2 hover:underline"
          >
            Accounts
          </Link>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              <b className="text-foreground">{formatCount(email.total)}</b> emails
            </span>
            <span>
              <b className="text-foreground">{formatCount(email.unread)}</b> unread
            </span>
            <span>
              <b className="text-foreground">{formatCount(email.withAttachments)}</b> with
              attachments
            </span>
          </div>
          {email.latestSync.length === 0 ? (
            <Empty>No syncs yet.</Empty>
          ) : (
            <ul className="divide-y divide-border text-xs">
              {email.latestSync.map((s) => (
                <li key={s.accountId} className="flex items-center justify-between gap-2 py-1.5">
                  <span className="truncate">{s.address}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="text-muted-foreground">{rel(s.finishedAt)}</span>
                    <span className={cn('font-medium', syncTone(s.status))}>{s.status}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Telegram */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5 text-base">
            <MessageCircle className="size-4 text-muted-foreground" aria-hidden /> Telegram
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              <b className="text-foreground">{formatCount(telegram.messagesTotal)}</b> messages
            </span>
            <span>
              <b className="text-foreground">{formatCount(telegram.unprocessed)}</b> unprocessed
            </span>
          </div>
          {telegram.chatsByStatus.length === 0 ? (
            <Empty>No chats paired.</Empty>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {telegram.chatsByStatus.map((c) => (
                <Badge key={c.key} variant="secondary">
                  {c.key}: {c.count}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Heartbeats */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="flex items-center gap-1.5 text-base">
            <HeartPulse className="size-4 text-muted-foreground" aria-hidden /> Heartbeats
          </CardTitle>
          <Link
            href="/settings/heartbeats"
            className="text-xs text-primary underline-offset-2 hover:underline"
          >
            Manage
          </Link>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {heartbeats.byStatus.length === 0 ? (
            <Empty>No heartbeats configured.</Empty>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {heartbeats.byStatus.map((s) => (
                <Badge key={s.key} variant="secondary">
                  {s.key}: {s.count}
                </Badge>
              ))}
            </div>
          )}
          {heartbeats.recentFiresByDisposition.length > 0 && (
            <div className="space-y-1 border-t pt-2 text-xs text-muted-foreground">
              <div className="font-medium text-foreground/70">Fires (7d)</div>
              <div className="flex flex-wrap gap-1.5">
                {heartbeats.recentFiresByDisposition.map((d) => (
                  <span key={d.key}>
                    {d.key}: <b className="text-foreground">{d.count}</b>
                  </span>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Errors */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="flex items-center gap-1.5 text-base">
            <AlertTriangle className="size-4 text-muted-foreground" aria-hidden /> Recent failures
          </CardTitle>
          <Link href="/debug" className="text-xs text-primary underline-offset-2 hover:underline">
            Debug
          </Link>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {topErrors.length === 0 ? (
            <Empty>No errors in the last 7 days. 🎉</Empty>
          ) : (
            <ul className="space-y-1 text-xs">
              {topErrors.map((e) => (
                <li key={e.lastTraceId} className="flex items-start justify-between gap-2">
                  <Link
                    href={`/traces/${e.lastTraceId}`}
                    className="truncate text-foreground hover:underline"
                    title={e.message}
                  >
                    {e.message}
                  </Link>
                  <Badge variant="outline" className="shrink-0 text-destructive">
                    ×{e.count}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          {recentFailures.length > 0 && (
            <p className="border-t pt-2 text-xs text-muted-foreground">
              Latest: {recentFailures[0]!.kind} {rel(recentFailures[0]!.startedAt)}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
      {children}
    </p>
  );
}
