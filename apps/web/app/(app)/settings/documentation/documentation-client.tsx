'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { BookText } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import {
  setAllDocCollectionsAction,
  toggleDocCollectionAction,
  type DocCollectionView,
} from './actions';
import { NewCollectionDialog } from './new-collection-dialog';

/** A pending disable that needs confirmation (single collection or "all"). */
type DisableTarget = { kind: 'one'; id: string; label: string } | { kind: 'all' };

export function DocumentationClient({
  initial,
  formattedReconciled,
}: {
  initial: DocCollectionView[];
  /** Server-formatted "last synced" strings keyed by collection id (tz/locale
   *  stable — avoids the toLocaleString hydration mismatch). */
  formattedReconciled: Record<string, string | null>;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [confirm, setConfirm] = useState<DisableTarget | null>(null);

  const anyEnabled = initial.some((c) => c.enabled);
  const allEnabled = initial.length > 0 && initial.every((c) => c.enabled);

  function run(fn: () => Promise<{ ok: boolean; message: string }>) {
    startTransition(async () => {
      const res = await fn();
      if (res.ok) toast.success(res.message);
      else toast.error(res.message);
      router.refresh();
    });
  }

  function onToggle(c: DocCollectionView, next: boolean) {
    if (!next) {
      // Disabling purges indexed nodes — confirm first.
      setConfirm({ kind: 'one', id: c.id, label: c.label });
      return;
    }
    run(() => toggleDocCollectionAction(c.id, true));
  }

  function confirmDisable() {
    const target = confirm;
    setConfirm(null);
    if (!target) return;
    if (target.kind === 'all') run(() => setAllDocCollectionsAction(false));
    else run(() => toggleDocCollectionAction(target.id, false));
  }

  return (
    <div className="mx-auto max-w-3xl p-4 md:p-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          Index markdown documentation into the brain so the assistant can answer questions about
          how the system works. Indexing is opt-in per collection — enabling one reconciles it now
          and keeps tracking edits; disabling removes its indexed docs.
        </p>
        <div className="flex shrink-0 gap-2">
          <NewCollectionDialog />
          <Button
            variant="outline"
            size="sm"
            disabled={pending || allEnabled || initial.length === 0}
            onClick={() => run(() => setAllDocCollectionsAction(true))}
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
      </div>

      <div className="space-y-2">
        {initial.map((c) => (
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
            <Switch
              checked={c.enabled}
              disabled={pending}
              onCheckedChange={(next) => onToggle(c, next)}
              aria-label={`Toggle ${c.label}`}
            />
          </div>
        ))}
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
