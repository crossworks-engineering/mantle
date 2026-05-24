'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { JSONContent } from '@tiptap/react';
import { ChevronLeft, ChevronRight, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { TagPill } from '@/components/tag-pill';
import { TagInput } from '@/components/tag-input';
import { PageView } from '@/components/page-editor/page-view';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/format-datetime';

type PageRow = {
  id: string;
  title: string;
  icon: string | null;
  tags: string[];
  summary: string | null;
  visibility: 'private' | 'public';
  createdAt: string;
  updatedAt: string;
};

type TagCount = { tag: string; count: number };

export function PagesClient({
  pages,
  total,
  page,
  pageSize,
  tags,
  activeTag,
  query,
}: {
  pages: PageRow[];
  total: number;
  page: number;
  pageSize: number;
  tags: TagCount[];
  activeTag: string | null;
  query: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const [navPending, startNav] = useTransition();

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<{ title: string; tags: string[] }>({ title: '', tags: [] });
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PageRow | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState(query);

  const selected = pages.find((p) => p.id === selectedId) ?? pages[0] ?? null;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const buildHref = (over: { page?: number; tag?: string | null; q?: string | null }) => {
    const nextTag = over.tag !== undefined ? over.tag : activeTag;
    const nextQ = over.q !== undefined ? over.q : query || null;
    const nextPage = over.page !== undefined ? over.page : page;
    const params = new URLSearchParams();
    if (nextTag) params.set('tag', nextTag);
    if (nextQ) params.set('q', nextQ);
    if (nextPage && nextPage > 1) params.set('page', String(nextPage));
    const s = params.toString();
    return s ? `${pathname}?${s}` : pathname;
  };

  const go = (over: Parameters<typeof buildHref>[0]) =>
    startNav(() => router.push(buildHref(over)));

  useEffect(() => {
    const handle = setTimeout(() => {
      if (searchInput.trim() === query) return;
      go({ q: searchInput.trim() || null, page: 1 });
    }, 350);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) {
      toast.error('Title is required');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: form.title.trim(), tags: form.tags }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error(j.error ?? `request failed (${res.status})`);
        return;
      }
      const { page: created } = (await res.json()) as { page: PageRow };
      setForm({ title: '', tags: [] });
      setOpen(false);
      toast.success('Page created');
      // New pages open straight into the editor.
      router.push(`/pages/${created.id}`);
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const res = await fetch(`/api/pages/${deleteTarget.id}`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error('Could not delete page');
      return;
    }
    toast.success('Page deleted');
    if (selectedId === deleteTarget.id) setSelectedId(null);
    startNav(() => router.refresh());
  };

  return (
    <div className="md:grid md:h-full md:grid-cols-[30%_minmax(0,1fr)] md:overflow-hidden">
      {/* ── Left: list ─────────────────────────────────────────────── */}
      <div className="flex flex-col border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r">
        <div className="space-y-3 border-b border-border p-4">
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search pages…"
                className="pl-8"
              />
            </div>
            <Button onClick={() => setOpen(true)}>
              <Plus /> New
            </Button>
          </div>

          {tags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                size="sm"
                variant={activeTag ? 'outline' : 'default'}
                className="h-7 rounded-full px-3"
                onClick={() => go({ tag: null, page: 1 })}
              >
                All
              </Button>
              {tags.map((t) => (
                <Button
                  key={t.tag}
                  size="sm"
                  variant={activeTag === t.tag ? 'default' : 'outline'}
                  className="h-7 rounded-full px-3"
                  onClick={() => go({ tag: activeTag === t.tag ? null : t.tag, page: 1 })}
                >
                  {t.tag}
                  <span className="ml-1 opacity-60">{t.count}</span>
                </Button>
              ))}
            </div>
          )}
        </div>

        <div
          className={cn(
            'space-y-2 p-3 transition-opacity md:flex-1 md:overflow-y-auto md:scrollbar-thin',
            navPending && 'opacity-60',
          )}
        >
          {pages.length === 0 ? (
            <div className="rounded-md border border-dashed border-border bg-muted/30 px-6 py-12 text-center text-sm text-muted-foreground">
              {query || activeTag
                ? 'No pages match your search or filter.'
                : 'No pages yet. Click “New” to start writing.'}
            </div>
          ) : (
            pages.map((p) => (
              <button
                key={p.id}
                onClick={() => setSelectedId(p.id)}
                className={cn(
                  'block w-full rounded-lg border border-l-[3px] border-border border-l-border bg-card p-3 text-left transition-colors hover:bg-accent/40',
                  selected?.id === p.id && 'border-l-primary bg-accent/50',
                )}
              >
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 size-4 shrink-0 text-center text-sm leading-4" aria-hidden>
                    {p.icon ?? '📄'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{p.title}</div>
                    {p.summary && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {p.summary}
                      </p>
                    )}
                    {p.tags.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {p.tags.map((t) => (
                          <TagPill key={t} tag={t} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>

        {total > 0 && (
          <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {total} {total === 1 ? 'page' : 'pages'}
            </span>
            <div className="flex items-center gap-1.5">
              <span className="tabular-nums">
                {page} / {totalPages}
              </span>
              <Button
                size="icon"
                variant="outline"
                className="size-7"
                disabled={page <= 1 || navPending}
                onClick={() => go({ page: page - 1 })}
                aria-label="Previous page"
              >
                <ChevronLeft />
              </Button>
              <Button
                size="icon"
                variant="outline"
                className="size-7"
                disabled={page >= totalPages || navPending}
                onClick={() => go({ page: page + 1 })}
                aria-label="Next page"
              >
                <ChevronRight />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* ── Right: preview ─────────────────────────────────────────── */}
      <div className="md:h-full md:overflow-y-auto md:scrollbar-thin">
        {selected ? (
          <PagePreview key={selected.id} row={selected} onDelete={() => setDeleteTarget(selected)} />
        ) : (
          <div className="flex h-full items-center justify-center p-10 text-center text-sm text-muted-foreground">
            Select a page to preview.
          </div>
        )}
      </div>

      {/* New page dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New page</DialogTitle>
            <DialogDescription>Give it a title — you’ll write the body in the editor.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                autoFocus
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tags">Tags</Label>
              <TagInput
                id="tags"
                value={form.tags}
                onChange={(t) => setForm({ ...form, tags: t })}
                placeholder="Type and press comma or Enter…"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? 'Creating…' : 'Create & edit'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>This can’t be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Right-pane read-only preview. Fetches the full document for the selected
 *  page (the list omits the body to stay lean) and renders it read-only. */
function PagePreview({ row, onDelete }: { row: PageRow; onDelete: () => void }) {
  const [doc, setDoc] = useState<JSONContent | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/pages/${row.id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(({ page }: { page: { doc: JSONContent } }) => {
        if (!cancelled) {
          setDoc(page.doc);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [row.id]);

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-start justify-between gap-3">
        <h2 className="flex min-w-0 flex-1 items-center gap-2 text-xl font-semibold">
          <span aria-hidden>{row.icon ?? '📄'}</span>
          <span className="min-w-0 truncate">{row.title}</span>
        </h2>
        <div className="flex shrink-0 gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={`/pages/${row.id}`}>
              <Pencil /> Edit
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            aria-label="Delete page"
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      {row.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {row.tags.map((t) => (
            <TagPill key={t} tag={t} />
          ))}
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
        </div>
      ) : doc ? (
        <PageView content={doc} />
      ) : (
        <p className="text-sm italic text-muted-foreground">Couldn’t load this page.</p>
      )}

      <div className="border-t border-border pt-3 text-xs text-muted-foreground">
        Updated {formatDateTime(row.updatedAt)} · created {formatDateTime(row.createdAt)}
      </div>
    </div>
  );
}
