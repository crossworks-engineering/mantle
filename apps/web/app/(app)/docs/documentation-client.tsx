'use client';

import { useState, useTransition } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { ArrowRight, BookText, Info } from 'lucide-react';
import { apiFetch, apiSend } from '@mantle/web-ui/api-fetch';
import { Switch } from '@mantle/web-ui/ui/switch';
import { Button } from '@mantle/web-ui/ui/button';
import { Badge } from '@mantle/web-ui/ui/badge';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@mantle/web-ui/ui/alert-dialog';
import { useToast } from '@mantle/web-ui/ui/toast';
import { NewCollectionDialog } from './new-collection-dialog';

export type DocCollectionView = {
  id: string;
  key: string;
  label: string;
  origin: string;
  brainDepth: string;
  enabled: boolean;
  lastReconciledAt: string | null;
};

type DocsData = {
  collections: DocCollectionView[];
  formattedReconciled: Record<string, string | null>;
  firstDocHref: Record<string, string | null>;
};

type Result = { ok: boolean; message: string };

/** A pending disable that needs confirmation (single collection or "all"). */
type DisableTarget = { kind: 'one'; id: string; label: string } | { kind: 'all' };

/** Outer query-gate so the page stays data-free. */
export function DocumentationClient() {
  const docsQuery = useQuery({
    queryKey: ['docs', 'collections'],
    queryFn: () => apiFetch<DocsData>('/api/docs/collections'),
  });
  if (docsQuery.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }
  if (docsQuery.isError && !docsQuery.data) {
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-sm text-muted-foreground">
        <p>Couldn&apos;t load documentation collections.</p>
        <Button variant="outline" size="sm" onClick={() => docsQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  return <DocumentationView data={docsQuery.data} />;
}

function DocumentationView({ data }: { data: DocsData }) {
  const { collections, formattedReconciled, firstDocHref } = data;
  const queryClient = useQueryClient();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [confirm, setConfirm] = useState<DisableTarget | null>(null);

  const anyEnabled = collections.some((c) => c.enabled);
  const allEnabled = collections.length > 0 && collections.every((c) => c.enabled);

  function run(fn: () => Promise<Result>) {
    startTransition(async () => {
      try {
        const res = await fn();
        if (res.ok) toast.success(res.message);
        else toast.error(res.message);
        queryClient.invalidateQueries({ queryKey: ['docs', 'collections'] });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Request failed');
      }
    });
  }

  const toggle = (id: string, enabled: boolean) =>
    run(() => apiSend<Result>(`/api/docs/collections/${id}`, 'PATCH', { enabled }));
  const setAll = (enabled: boolean) =>
    run(() => apiSend<Result>('/api/docs/collections/all', 'POST', { enabled }));

  function onToggle(c: DocCollectionView, next: boolean) {
    if (!next) {
      // Disabling purges indexed nodes — confirm first.
      setConfirm({ kind: 'one', id: c.id, label: c.label });
      return;
    }
    toggle(c.id, true);
  }

  function confirmDisable() {
    const target = confirm;
    setConfirm(null);
    if (!target) return;
    if (target.kind === 'all') setAll(false);
    else toggle(target.id, false);
  }

  return (
    <div className="space-y-4">
      {/* Actions — left-aligned, above the enable/disable switch blocks. */}
      <div className="flex flex-wrap gap-2">
        <NewCollectionDialog />
        <Button
          variant="outline"
          size="sm"
          disabled={pending || allEnabled || collections.length === 0}
          onClick={() => setAll(true)}
        >
          Enable all
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={pending || !anyEnabled}
          onClick={() => setConfirm({ kind: 'all' })}
        >
          Disable all
        </Button>
      </div>

      <div className="space-y-2">
        {collections.map((c) => (
          <div
            key={c.id}
            className="flex items-center justify-between gap-4 rounded-lg border bg-card p-3"
          >
            <div className="flex min-w-0 items-start gap-3">
              <BookText className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{c.label}</span>
                  <Badge variant="secondary" className="text-[11px]">
                    {c.origin}
                  </Badge>
                  <Badge variant="outline" className="text-[11px]">
                    {c.brainDepth === 'retrieval' ? 'retrieval-only' : 'full extraction'}
                  </Badge>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {c.enabled
                    ? formattedReconciled[c.id]
                      ? `Indexed · last synced ${formattedReconciled[c.id]}`
                      : 'Enabled'
                    : 'Not indexed'}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {firstDocHref?.[c.key] ? (
                <Link
                  href={firstDocHref[c.key]!}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  Open <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              ) : null}
              <Switch
                checked={c.enabled}
                disabled={pending}
                onCheckedChange={(next) => onToggle(c, next)}
                aria-label={`Toggle ${c.label}`}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Info box — what indexing does. */}
      <div className="flex gap-2.5 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>
          Index markdown documentation into the brain so the assistant can answer questions about
          how the system works. Indexing is opt-in per collection — enabling one reconciles it now
          and keeps tracking edits; disabling removes its indexed docs.
        </p>
      </div>

      <AlertDialog open={confirm != null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === 'all'
                ? 'Disable all documentation collections?'
                : `Disable “${confirm?.kind === 'one' ? confirm.label : ''}”?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes the indexed documentation from the brain (the markdown files on disk are
              untouched). You can re-enable to re-index at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDisable}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Disable
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
