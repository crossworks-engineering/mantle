'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight, FileText, Plus, Search, Trash2 } from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';

type NoteRow = {
  id: string;
  title: string;
  content: string;
  tags: string[];
  summary: string | null;
  createdAt: string;
  updatedAt: string;
};

type TagCount = { tag: string; count: number };

export function NotesClient({
  notes,
  total,
  page,
  pageSize,
  tags,
  activeTag,
  query,
}: {
  notes: NoteRow[];
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
  const [form, setForm] = useState({ title: '', content: '', tags: '' });
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<NoteRow | null>(null);

  // Local search box; debounced into the URL (server filters + paginates).
  const [searchInput, setSearchInput] = useState(query);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  /** Build a /notes URL from the current filters with overrides applied. */
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

  // Debounce the search box → URL (resets to page 1, preserves tag).
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
      const res = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title.trim(),
          content: form.content,
          tags: form.tags
            .split(',')
            .map((t) => t.trim().toLowerCase())
            .filter(Boolean),
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error(j.error ?? `request failed (${res.status})`);
        return;
      }
      setForm({ title: '', content: '', tags: '' });
      setOpen(false);
      toast.success('Note created');
      // Land on the unfiltered first page so the new note is visible at top.
      setSearchInput('');
      startNav(() => {
        router.push('/notes');
        router.refresh();
      });
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const res = await fetch(`/api/notes/${deleteTarget.id}`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error('Could not delete note');
      return;
    }
    toast.success('Note deleted');
    startNav(() => router.refresh());
  };

  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = (page - 1) * pageSize + notes.length;
  const hasFilters = Boolean(query || activeTag);

  return (
    <div className="space-y-4">
      {/* Search + new */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search notes…"
            className="pl-8"
          />
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus /> New note
        </Button>
      </div>

      {/* Tag filter */}
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

      {/* List */}
      {notes.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-muted/30 px-6 py-12 text-center text-sm text-muted-foreground">
          {hasFilters
            ? 'No notes match your search or filter.'
            : 'No notes yet. Click “New note” or ask your assistant to add one.'}
        </div>
      ) : (
        <ul
          className={
            'divide-y divide-border rounded-md border border-border transition-opacity ' +
            (navPending ? 'opacity-60' : '')
          }
        >
          {notes.map((n) => (
            <li key={n.id} className="group flex items-start gap-3 px-3 py-2.5">
              <FileText className="mt-1 size-4 text-muted-foreground" />
              <Link href={`/notes/${n.id}`} className="min-w-0 flex-1">
                <div className="truncate font-medium">{n.title}</div>
                {(n.summary || n.content) && (
                  <p className="line-clamp-1 text-xs text-muted-foreground">
                    {n.summary ?? n.content.slice(0, 200)}
                  </p>
                )}
                {n.tags.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {n.tags.map((t) => (
                      <Badge
                        key={t}
                        variant="secondary"
                        className="px-1.5 py-0 text-[10px] font-medium"
                      >
                        {t}
                      </Badge>
                    ))}
                  </div>
                )}
              </Link>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDeleteTarget(n)}
                className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                aria-label={`Delete ${n.title}`}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* Pagination */}
      {total > 0 && (
        <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
          <span>
            {start}–{end} of {total} {total === 1 ? 'note' : 'notes'}
          </span>
          <div className="flex items-center gap-2">
            <span className="tabular-nums">
              Page {page} of {totalPages}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1 || navPending}
              onClick={() => go({ page: page - 1 })}
            >
              <ChevronLeft /> Prev
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= totalPages || navPending}
              onClick={() => go({ page: page + 1 })}
            >
              Next <ChevronRight />
            </Button>
          </div>
        </div>
      )}

      {/* New note dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>New note</DialogTitle>
            <DialogDescription>Markdown. Extracted + embedded on save.</DialogDescription>
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
              <Label htmlFor="content">Content</Label>
              <Textarea
                id="content"
                value={form.content}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
                rows={10}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tags">
                Tags <span className="font-normal text-muted-foreground">(comma-separated)</span>
              </Label>
              <Input
                id="tags"
                value={form.tags}
                onChange={(e) => setForm({ ...form, tags: e.target.value })}
                placeholder="idea, draft, follow-up"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? 'Saving…' : 'Save note'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
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
