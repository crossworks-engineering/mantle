'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FileText, Plus, Search, Trash2 } from 'lucide-react';
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

export function NotesClient({ initialNotes }: { initialNotes: NoteRow[] }) {
  const router = useRouter();
  const toast = useToast();
  const [notes, setNotes] = useState(initialNotes);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: '', content: '', tags: '' });
  const [isPending, startTransition] = useTransition();
  const [deleteTarget, setDeleteTarget] = useState<NoteRow | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter((n) =>
      [n.title, n.content, n.summary ?? '', n.tags.join(' ')]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [notes, query]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) {
      toast.error('Title is required');
      return;
    }
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
    const { note } = await res.json();
    setNotes((prev) => [note, ...prev]);
    setForm({ title: '', content: '', tags: '' });
    setOpen(false);
    toast.success('Note created');
    startTransition(() => router.refresh());
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const res = await fetch(`/api/notes/${deleteTarget.id}`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error('Could not delete note');
      return;
    }
    setNotes((prev) => prev.filter((n) => n.id !== deleteTarget.id));
    toast.success('Note deleted');
    startTransition(() => router.refresh());
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search notes…"
            className="pl-8"
          />
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus /> New note
        </Button>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-muted/30 px-6 py-12 text-center text-sm text-muted-foreground">
          {notes.length === 0
            ? 'No notes yet. Click “New note” or ask your assistant to add one.'
            : 'No notes match your search.'}
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {filtered.map((n) => (
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
              <Button type="submit" disabled={isPending}>
                {isPending ? 'Saving…' : 'Save note'}
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
