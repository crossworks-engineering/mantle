'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronLeft, ChevronRight, FileText, Pencil, Plus, Search, Trash2 } from 'lucide-react';
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
import { ShareControl } from '@/components/share/share-control';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { TagPill } from '@/components/tag-pill';
import { TagInput } from '@/components/tag-input';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/format-datetime';

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
  const [form, setForm] = useState<{ title: string; content: string; tags: string[] }>({
    title: '',
    content: '',
    tags: [],
  });
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<NoteRow | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Local search box; debounced into the URL (server filters + paginates).
  const [searchInput, setSearchInput] = useState(query);

  // The previewed note: explicit selection, falling back to the first row so
  // the right pane is never blank when notes exist.
  const selected = notes.find((n) => n.id === selectedId) ?? notes[0] ?? null;

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
        body: JSON.stringify({ title: form.title.trim(), content: form.content, tags: form.tags }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error(j.error ?? `request failed (${res.status})`);
        return;
      }
      const { note } = (await res.json()) as { note: NoteRow };
      setForm({ title: '', content: '', tags: [] });
      setOpen(false);
      setSelectedId(note.id);
      toast.success('Note created');
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
    if (selectedId === deleteTarget.id) setSelectedId(null);
    startNav(() => router.refresh());
  };

  return (
    <div className="md:grid md:h-full md:grid-cols-2 md:overflow-hidden">
      {/* ── Left: list ─────────────────────────────────────────────── */}
      <div className="flex flex-col border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r">
        <div className="space-y-3 border-b border-border p-4">
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search notes…"
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

        {/* Cards */}
        <div
          className={cn(
            'space-y-2 p-3 transition-opacity md:flex-1 md:overflow-y-auto md:scrollbar-thin',
            navPending && 'opacity-60',
          )}
        >
          {notes.length === 0 ? (
            <div className="rounded-md border border-dashed border-border bg-muted/30 px-6 py-12 text-center text-sm text-muted-foreground">
              {query || activeTag
                ? 'No notes match your search or filter.'
                : 'No notes yet. Click “New” or ask your assistant to add one.'}
            </div>
          ) : (
            notes.map((n) => (
              <button
                key={n.id}
                onClick={() => setSelectedId(n.id)}
                className={cn(
                  'block w-full rounded-lg border border-l-[3px] border-border border-l-border bg-card p-3 text-left transition-colors hover:bg-accent/40',
                  selected?.id === n.id && 'border-l-primary bg-accent/50',
                )}
              >
                <div className="flex items-start gap-2">
                  <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{n.title}</div>
                    {(n.summary || n.content) && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {n.summary ?? n.content.slice(0, 200)}
                      </p>
                    )}
                    {n.tags.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {n.tags.map((t) => (
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

        {/* Pagination */}
        {total > 0 && (
          <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {total} {total === 1 ? 'note' : 'notes'}
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
          <NotePreview note={selected} onDelete={() => setDeleteTarget(selected)} />
        ) : (
          <div className="flex h-full items-center justify-center p-10 text-center text-sm text-muted-foreground">
            Select a note to preview.
          </div>
        )}
      </div>

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
              <Label htmlFor="tags">Tags</Label>
              <TagInput
                id="tags"
                value={form.tags}
                onChange={(tags) => setForm({ ...form, tags })}
                placeholder="Type and press comma or Enter…"
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

/** Right-pane read-only preview of the selected note. */
function NotePreview({ note, onDelete }: { note: NoteRow; onDelete: () => void }) {
  return (
    <div className="space-y-4 p-6">
      <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 flex-1 text-xl font-semibold">{note.title}</h2>
        <div className="flex shrink-0 gap-2">
          <ShareControl nodeId={note.id} />
          <Button asChild variant="outline" size="sm">
            <Link href={`/notes/${note.id}`}>
              <Pencil /> Edit
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            aria-label="Delete note"
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      {note.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {note.tags.map((t) => (
            <TagPill key={t} tag={t} />
          ))}
        </div>
      )}

      <article className="prose prose-sm dark:prose-invert max-w-none">
        {note.content ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{note.content}</ReactMarkdown>
        ) : (
          <p className="text-sm italic text-muted-foreground">No content yet.</p>
        )}
      </article>

      <div className="border-t border-border pt-3 text-xs text-muted-foreground">
        Updated {formatDateTime(note.updatedAt)} · created {formatDateTime(note.createdAt)}
      </div>
    </div>
  );
}
