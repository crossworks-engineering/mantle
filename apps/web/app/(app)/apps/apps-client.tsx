'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppWindow, Plus, Trash2, Pencil } from 'lucide-react';
import { apiFetch, apiSend } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { SubmitButton } from '@/components/ui/submit-button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
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
import { useListNav } from '@/lib/use-list-nav';
import { ListPager } from '@/components/layout/list-pager';
import { AppSandbox } from '@/components/app-sandbox/app-sandbox';
import { cn } from '@/lib/utils';
import type { AppRow } from '@mantle/content';

type AppsPage = { apps: AppRow[]; total: number; page: number; pageSize: number };

/** Outer query-gate so the page stays data-free. The URL params (driven by
 *  `useListNav` in the list) key the query, so navigating refetches. */
export function AppsClient({
  page,
  query,
  sort,
}: {
  page: number;
  query: string;
  sort: string;
}) {
  const appsQuery = useQuery({
    queryKey: ['apps', { query, sort, page }],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), sort });
      if (query) params.set('q', query);
      return apiFetch<AppsPage>(`/api/apps?${params.toString()}`);
    },
    placeholderData: (prev) => prev,
  });

  if (appsQuery.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (appsQuery.isError && !appsQuery.data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <p>Couldn&apos;t load apps.</p>
        <Button variant="outline" size="sm" onClick={() => appsQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  return <AppsView data={appsQuery.data} query={query} />;
}

function AppsView({ data, query }: { data: AppsPage; query: string }) {
  const { apps, total, page, pageSize } = data;
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { pending, go } = useListNav();

  const [selectedId, setSelectedId] = useState<string | null>(apps[0]?.id ?? null);
  const [q, setQ] = useState(query);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AppRow | null>(null);

  // Keep a valid selection as the list changes (filter/page).
  useEffect(() => {
    if (!apps.some((a) => a.id === selectedId)) setSelectedId(apps[0]?.id ?? null);
  }, [apps, selectedId]);

  const selected = useMemo(() => apps.find((a) => a.id === selectedId) ?? null, [apps, selectedId]);

  async function handleDelete(app: AppRow) {
    try {
      await apiSend(`/api/apps/${app.id}`, 'DELETE');
    } catch {
      toast.error('Could not delete the app.');
      return;
    }
    toast.success(`Deleted "${app.title}".`);
    setDeleteTarget(null);
    void queryClient.invalidateQueries({ queryKey: ['apps'] });
  }

  return (
    <div className="grid h-full min-h-0 grid-rows-[1fr] md:grid-cols-[340px_1fr]">
      {/* Left: list */}
      <div className="flex min-h-0 flex-col border-r border-border">
        <div className="flex items-center gap-2 border-b border-border p-2">
          <form
            className="flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              go({ q: q || null, page: null });
            }}
          >
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search apps…"
              className="h-9"
            />
          </form>
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button size="sm" aria-label="New app">
                <Plus />
              </Button>
            </DialogTrigger>
            <CreateAppDialog
              onCreated={(id) => {
                setCreateOpen(false);
                router.push(`/apps/${id}`);
              }}
            />
          </Dialog>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {apps.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No apps yet. Create one, or ask Saskia to “build me an app”.
            </div>
          ) : (
            <ul className="flex flex-col gap-1">
              {apps.map((app) => (
                <li key={app.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(app.id)}
                    className={cn(
                      'flex w-full flex-col gap-1 rounded-lg border px-3 py-2 text-left transition-colors',
                      app.id === selectedId
                        ? 'border-border bg-accent text-accent-foreground'
                        : 'border-transparent hover:bg-foreground/[0.06]',
                    )}
                  >
                    <span className="flex items-center gap-2 font-medium">
                      <span aria-hidden>{app.icon ?? '🧩'}</span>
                      <span className="truncate">{app.title}</span>
                      {app.hasDraft && (
                        <Badge variant="secondary" className="ml-auto shrink-0">
                          draft
                        </Badge>
                      )}
                    </span>
                    {app.description && (
                      <span className="line-clamp-1 text-xs text-muted-foreground">
                        {app.description}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <ListPager page={page} total={total} pageSize={pageSize} pending={pending} onGo={(p) => go({ page: p })} />
      </div>

      {/* Right: preview */}
      <div className="flex min-h-0 flex-col overflow-y-auto">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center p-10 text-center text-sm text-muted-foreground">
            <div className="flex flex-col items-center gap-2">
              <AppWindow className="size-8 opacity-50" />
              Select an app to preview it.
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="flex items-center gap-2 text-lg font-semibold">
                  <span aria-hidden>{selected.icon ?? '🧩'}</span>
                  {selected.title}
                </h2>
                {selected.description && (
                  <p className="text-sm text-muted-foreground">{selected.description}</p>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  {selected.toolCount} tool{selected.toolCount === 1 ? '' : 's'} ·{' '}
                  {selected.hasBuild ? 'published build' : 'no published build'}
                  {selected.hasDraft ? ' · unpublished draft' : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button asChild size="sm" variant="outline">
                  <Link href={`/apps/${selected.id}`}>
                    <Pencil />
                    Open editor
                  </Link>
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-9 text-muted-foreground hover:text-destructive"
                  onClick={() => setDeleteTarget(selected)}
                  aria-label="Delete app"
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
            <AppSandbox appId={selected.id} />
          </div>
        )}
      </div>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the app, its builds, and its database. This can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && handleDelete(deleteTarget)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function CreateAppDialog({ onCreated }: { onCreated: (id: string) => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      const { app } = await apiSend<{ app: { id: string } }>('/api/apps', 'POST', {
        name: name.trim(),
        description: description.trim() || undefined,
      });
      onCreated(app.id);
    } catch {
      toast.error('Could not create the app.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>New app</DialogTitle>
      </DialogHeader>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="app-name">Name</Label>
          <Input id="app-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Weather" autoFocus />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="app-desc">Description</Label>
          <Input
            id="app-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Today’s weather for a city"
          />
        </div>
        <div className="flex justify-end">
          <SubmitButton pending={saving}>Create app</SubmitButton>
        </div>
      </form>
    </DialogContent>
  );
}
