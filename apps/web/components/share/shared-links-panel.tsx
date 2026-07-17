'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Check, Copy, ExternalLink, Link2Off, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/components/ui/toast';
import { apiSend, ApiError } from '@/lib/api-fetch';
import { formatDate } from '@/lib/format-datetime';

export type SharedLinkRow = {
  id: string;
  path: string;
  nodeId: string;
  nodeType: string;
  title: string;
  icon: string | null;
  mode: 'public' | 'team';
  cascade: boolean;
  createdAt: string;
  viewCount: number;
  lastViewedAt: string | null;
};

const TYPE_LABEL: Record<string, string> = {
  page: 'Page',
  note: 'Note',
  task: 'Task',
  event: 'Event',
  file: 'File',
  app: 'App',
  table: 'Table',
  branch: 'Folder',
};

/**
 * The owner's exposure registry: every active share link (public and team),
 * newest first, with copy + revoke. Zero-curation sharing needs exactly this
 * counterpart — one glance answers "what can people outside see right now?".
 * Server-loaded rows; revocation updates locally (the next render re-lists).
 */
export function SharedLinksPanel({ initial }: { initial: SharedLinkRow[] }) {
  const toast = useToast();
  const [rows, setRows] = useState(initial);
  const [confirmRevoke, setConfirmRevoke] = useState<SharedLinkRow | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const copy = async (row: SharedLinkRow) => {
    try {
      await navigator.clipboard.writeText(window.location.origin + row.path);
      setCopiedId(row.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      toast.error('Copy failed');
    }
  };

  const revoke = async () => {
    if (!confirmRevoke) return;
    setBusy(true);
    try {
      await apiSend(`/api/shares/${confirmRevoke.id}`, 'DELETE');
      setRows((r) => r.filter((x) => x.id !== confirmRevoke.id));
      toast.success(`Unshared "${confirmRevoke.title}"`);
      setConfirmRevoke(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      toast.error(e instanceof Error ? e.message : 'Could not revoke the link');
    } finally {
      setBusy(false);
    }
  };

  if (rows.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="text-center text-sm text-muted-foreground">
          <p>Nothing is shared right now.</p>
          <p className="mt-1">
            Use the Share button on any page, note, table, app, task, event, file, or folder.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      <ul className="mx-auto w-full max-w-3xl space-y-2 p-4">
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex items-center gap-3 rounded-md border border-border bg-card px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                {row.icon ? <span aria-hidden>{row.icon}</span> : null}
                {row.title}
                {row.mode === 'team' && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
                    <Users className="size-2.5" aria-hidden /> team
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {TYPE_LABEL[row.nodeType] ?? row.nodeType}
                {row.cascade ? ' · sub-pages included' : ''} · shared {formatDate(row.createdAt)} ·{' '}
                {row.viewCount} view{row.viewCount === 1 ? '' : 's'}
                {row.lastViewedAt ? `, last ${formatDate(row.lastViewedAt)}` : ''}
              </p>
            </div>
            <Button
              size="icon"
              variant="ghost"
              className="size-8 shrink-0"
              onClick={() => void copy(row)}
              aria-label="Copy link"
            >
              {copiedId === row.id ? <Check /> : <Copy />}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-8 shrink-0"
              asChild
              aria-label="Open link"
            >
              <Link href={row.path} target="_blank">
                <ExternalLink />
              </Link>
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
              onClick={() => setConfirmRevoke(row)}
              aria-label="Revoke link"
            >
              <Link2Off />
            </Button>
          </li>
        ))}
      </ul>

      <AlertDialog open={!!confirmRevoke} onOpenChange={(o) => !o && setConfirmRevoke(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this link?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmRevoke?.cascade
                ? `"${confirmRevoke?.title}" and its shared sub-pages stop being accessible immediately. The content itself is untouched.`
                : `"${confirmRevoke?.title}" stops being accessible immediately. The content itself is untouched.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep sharing</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                void revoke();
              }}
              disabled={busy}
            >
              Revoke link
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
