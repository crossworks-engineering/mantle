'use client';

/**
 * Discover unknown senders — a live IMAP scan (nothing persisted) of who's
 * recently emailed you but isn't yet a contact, so their mail isn't being
 * ingested. One click promotes a sender to a contact (and backfills 90 days).
 */
import { useEffect, useState, useTransition } from 'react';
import { Loader2, RefreshCw, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/format-datetime';
import {
  addContactFromSender,
  recentUnknownSenders,
  type UnknownSender,
} from './actions';

export function DiscoverClient() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [senders, setSenders] = useState<UnknownSender[]>([]);
  const [adding, startAdd] = useTransition();
  const [addingAddr, setAddingAddr] = useState<string | null>(null);

  const scan = () => {
    setLoading(true);
    setError(null);
    recentUnknownSenders()
      .then((res) => {
        if (res.ok) setSenders(res.senders);
        else setError(res.error);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  // Auto-scan on mount.
  useEffect(scan, []);

  const onAdd = (s: UnknownSender) => {
    setAddingAddr(s.fromAddr);
    startAdd(async () => {
      const res = await addContactFromSender(s.fromAddr, s.fromName);
      if (res.ok) {
        toast.success(`Added ${s.fromName || s.fromAddr} — backfilling their mail`);
        setSenders((prev) => prev.filter((x) => x.fromAddr !== s.fromAddr));
      } else {
        toast.error(res.error);
      }
      setAddingAddr(null);
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Recent senders (last 30 days) who aren&apos;t in your contacts — so their mail isn&apos;t
          being ingested. Add the ones worth keeping.
        </p>
        <Button variant="outline" size="sm" onClick={scan} disabled={loading}>
          {loading ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
          Rescan
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Scanning your mailbox…
        </div>
      ) : error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : senders.length === 0 ? (
        <div className="py-16 text-center text-sm text-muted-foreground">
          No unknown senders in the last 30 days — everyone who&apos;s written is already a contact.
        </div>
      ) : (
        <ul className="space-y-2">
          {senders.map((s) => (
            <li
              key={s.fromAddr}
              className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 text-sm"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{s.fromName || s.fromAddr}</div>
                <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                  {s.fromName && <span className="truncate">{s.fromAddr}</span>}
                  <span className="whitespace-nowrap">
                    {s.count} msg{s.count === 1 ? '' : 's'}
                  </span>
                  <span className="whitespace-nowrap">last {formatDateTime(s.lastDate)}</span>
                </div>
                {s.subject && (
                  <div className="mt-0.5 truncate text-xs text-muted-foreground/80">
                    “{s.subject}”
                  </div>
                )}
              </div>
              <Button
                size="sm"
                onClick={() => onAdd(s)}
                disabled={adding && addingAddr === s.fromAddr}
              >
                {adding && addingAddr === s.fromAddr ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <UserPlus aria-hidden />
                )}
                Add as contact
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
