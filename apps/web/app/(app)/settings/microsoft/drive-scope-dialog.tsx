'use client';

import { useState } from 'react';
import { ChevronRight, File, Folder, FolderOpen } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MsDriveChildDTO, MsDriveDTO, MsDriveScopeDTO } from '@mantle/client-types';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { SubmitButton } from '@/components/ui/submit-button';
import { useToast } from '@/components/ui/toast';
import { apiFetch, apiSend } from '@/lib/api-fetch';

/** Breadcrumb frame: null itemId = the drive root. */
type Crumb = { itemId: string | null; name: string };

function formatSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Is this item already inside a SELECTED ancestor folder? (Checked+locked in
 *  the picker — deselect the ancestor to exclude it.) */
function coveredBy(scopes: MsDriveScopeDTO[], child: MsDriveChildDTO): MsDriveScopeDTO | null {
  if (child.path === null) return null;
  return (
    scopes.find(
      (s) =>
        s.isFolder &&
        s.itemId !== child.itemId &&
        (child.path === s.path || child.path!.startsWith(`${s.path}/`)),
    ) ?? null
  );
}

/**
 * "Choose what to sync" picker for one drive. Navigate folders via breadcrumbs,
 * tick folders (whole subtree) or single files. Selections are local until
 * "Save selection"; saving resets the drive's sync cursor so the next sync
 * re-walks against the new scope. No selections = the whole drive syncs.
 */
export function DriveScopeDialog({
  accountId,
  drive,
  onClose,
}: {
  accountId: string;
  drive: MsDriveDTO;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ itemId: null, name: drive.name }]);
  // Unsaved edits; null = untouched, showing the saved set. The component
  // unmounts on close, so edits never leak across opens.
  const [edits, setEdits] = useState<MsDriveScopeDTO[] | null>(null);
  const cwd = crumbs[crumbs.length - 1]!;

  const savedQuery = useQuery({
    queryKey: ['microsoft', 'scopes', drive.id],
    queryFn: () =>
      apiFetch<{ scopes: MsDriveScopeDTO[] }>(`/api/microsoft/drives/${drive.id}/scopes`).then(
        (r) => r.scopes,
      ),
  });
  const scopes: MsDriveScopeDTO[] | null = edits ?? savedQuery.data ?? null;

  const childrenQuery = useQuery({
    queryKey: ['microsoft', 'browse', drive.id, cwd.itemId ?? 'root'],
    queryFn: () =>
      apiFetch<{ items: MsDriveChildDTO[] }>(
        `/api/microsoft/drives/${drive.id}/browse${cwd.itemId ? `?item=${encodeURIComponent(cwd.itemId)}` : ''}`,
      ).then((r) => r.items),
  });

  const save = useMutation({
    mutationFn: (next: MsDriveScopeDTO[]) =>
      apiSend<{ scopes: MsDriveScopeDTO[] }>(`/api/microsoft/drives/${drive.id}/scopes`, 'PUT', {
        scopes: next,
      }),
    onSuccess: (_res, next) => {
      queryClient.invalidateQueries({ queryKey: ['microsoft', 'drives', accountId] });
      queryClient.invalidateQueries({ queryKey: ['microsoft', 'scopes', drive.id] });
      toast.success(
        next.length > 0
          ? `Selection saved — only ${next.length} selection${next.length === 1 ? '' : 's'} will sync.`
          : 'Selection cleared — the whole drive will sync.',
      );
      onClose();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
  });

  const toggleScope = (child: MsDriveChildDTO, checked: boolean) => {
    if (child.path === null) return;
    setEdits((prev) => {
      const cur = prev ?? savedQuery.data ?? [];
      if (!checked) return cur.filter((s) => s.itemId !== child.itemId);
      // Selecting a folder subsumes any existing selections inside it — drop
      // them so the saved set stays minimal (and "covered" locks read right).
      const kept = child.isFolder
        ? cur.filter((s) => !(s.path === child.path || s.path.startsWith(`${child.path}/`)))
        : cur.filter((s) => s.itemId !== child.itemId);
      return [
        ...kept,
        { itemId: child.itemId, path: child.path!, isFolder: child.isFolder, name: child.name },
      ];
    });
  };

  const items = childrenQuery.data ?? [];
  const count = scopes?.length ?? 0;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[80dvh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Choose what to sync</DialogTitle>
          <DialogDescription>
            {drive.siteName ? `${drive.siteName} · ${drive.name}` : drive.name} — tick folders
            (includes everything inside) or single files. Nothing ticked = the whole drive syncs.
            {!drive.enabled &&
              ' This drive is off — nothing syncs until you switch it on, so you can choose first.'}
          </DialogDescription>
        </DialogHeader>

        {/* Breadcrumbs */}
        <div className="flex flex-wrap items-center gap-1 text-sm">
          {crumbs.map((c, i) => (
            <span key={c.itemId ?? 'root'} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="size-3 text-muted-foreground" aria-hidden />}
              {i < crumbs.length - 1 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2"
                  onClick={() => setCrumbs((prev) => prev.slice(0, i + 1))}
                >
                  {c.name}
                </Button>
              ) : (
                <span className="px-2 font-medium">{c.name}</span>
              )}
            </span>
          ))}
        </div>

        {/* Children */}
        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border">
          {childrenQuery.isPending || scopes === null ? (
            <div className="flex items-center justify-center py-10">
              <Spinner />
            </div>
          ) : childrenQuery.isError ? (
            <p className="p-4 text-sm text-destructive">
              {childrenQuery.error instanceof Error
                ? childrenQuery.error.message
                : 'Failed to list the folder.'}
            </p>
          ) : items.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">This folder is empty.</p>
          ) : (
            <ul className="divide-y divide-border">
              {items.map((child) => {
                const selected = scopes.some((s) => s.itemId === child.itemId);
                const cover = coveredBy(scopes, child);
                const Icon = child.isFolder ? (selected || cover ? FolderOpen : Folder) : File;
                return (
                  <li key={child.itemId} className="flex items-center gap-3 px-3 py-2">
                    <Checkbox
                      checked={selected || !!cover}
                      disabled={!!cover || child.path === null}
                      onCheckedChange={(v) => toggleScope(child, v === true)}
                      aria-label={`Sync ${child.name}`}
                    />
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    {child.isFolder ? (
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left text-sm font-medium hover:underline"
                        onClick={() =>
                          setCrumbs((prev) => [...prev, { itemId: child.itemId, name: child.name }])
                        }
                      >
                        {child.name}
                      </button>
                    ) : (
                      <span className="min-w-0 flex-1 truncate text-sm">{child.name}</span>
                    )}
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {cover
                        ? `via ${cover.name ?? cover.path}`
                        : child.isFolder
                          ? `${child.childCount ?? 0} items`
                          : formatSize(child.size)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {count === 0
                ? 'No selections — the whole drive syncs.'
                : `${count} selection${count === 1 ? '' : 's'} — only these sync.`}
            </span>
            {count > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setEdits([])}>
                Clear all
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <SubmitButton
              pending={save.isPending}
              disabled={scopes === null}
              onClick={() => scopes !== null && save.mutate(scopes)}
            >
              Save selection
            </SubmitButton>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
