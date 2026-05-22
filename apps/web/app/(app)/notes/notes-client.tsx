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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

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
  const [notes, setNotes] = useState(initialNotes);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: '', content: '', tags: '' });
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

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
    setError(null);
    if (!form.title.trim()) {
      setError('Title is required');
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
      setError(j.error ?? `request failed (${res.status})`);
      return;
    }
    const { note } = await res.json();
    setNotes((prev) => [note, ...prev]);
    setForm({ title: '', content: '', tags: '' });
    setOpen(false);
    startTransition(() => router.refresh());
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this note?')) return;
    const res = await fetch(`/api/notes/${id}`, { method: 'DELETE' });
    if (!res.ok) return;
    setNotes((prev) => prev.filter((n) => n.id !== id));
    startTransition(() => router.refresh());
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
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
              <Link href={`/notes/${n.id}`} className="flex-1 min-w-0">
                <div className="truncate font-medium">{n.title}</div>
                {(n.summary || n.content) && (
                  <p className="line-clamp-1 text-xs text-muted-foreground">
                    {n.summary ?? n.content.slice(0, 200)}
                  </p>
                )}
                {n.tags.length > 0 && (
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {n.tags.map((t) => (
                      <span
                        key={t}
                        className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </Link>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleDelete(n.id)}
                className="opacity-0 transition-opacity group-hover:opacity-100"
                aria-label={`Delete ${n.title}`}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>New note</DialogTitle>
            <DialogDescription>
              Markdown. Extracted + embedded on save.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                autoFocus
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="content">Content</Label>
              <textarea
                id="content"
                value={form.content}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
                rows={10}
                className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="tags">Tags (comma-separated)</Label>
              <Input
                id="tags"
                value={form.tags}
                onChange={(e) => setForm({ ...form, tags: e.target.value })}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
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
    </div>
  );
}
