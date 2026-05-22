'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, Eye, Pencil, Save, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SetPageTitle } from '@/components/layout/page-title';
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

export function NoteDetailClient({ initial }: { initial: NoteRow }) {
  const router = useRouter();
  const [note, setNote] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    title: note.title,
    content: note.content,
    tags: note.tags.join(', '),
  });
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const res = await fetch(`/api/notes/${note.id}`, {
      method: 'PATCH',
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
      setError(j.error ?? 'save failed');
      return;
    }
    const { note: updated } = await res.json();
    setNote(updated);
    setEditing(false);
    startTransition(() => router.refresh());
  };

  const handleDelete = async () => {
    if (!confirm('Delete this note?')) return;
    const res = await fetch(`/api/notes/${note.id}`, { method: 'DELETE' });
    if (!res.ok) return;
    router.push('/notes');
  };

  return (
    <div className="space-y-4">
      <SetPageTitle title={note.title} />
      <Link
        href="/notes"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3" /> All notes
      </Link>

      {!editing ? (
        <>
          <header className="space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0 space-y-1">
                {note.summary && (
                  <p className="text-xs italic text-muted-foreground">
                    Indexed: {note.summary}
                  </p>
                )}
                {note.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {note.tags.map((t) => (
                      <span
                        key={t}
                        className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                  <Pencil className="size-3" /> Edit
                </Button>
                <Button variant="ghost" size="sm" onClick={handleDelete} aria-label="Delete note">
                  <Trash2 />
                </Button>
              </div>
            </div>
          </header>

          <article className="prose prose-sm dark:prose-invert max-w-none rounded-md border border-border bg-card p-4">
            {note.content ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{note.content}</ReactMarkdown>
            ) : (
              <p className="text-sm italic text-muted-foreground">No content yet.</p>
            )}
          </article>

          <div className="border-t border-border pt-3 text-xs text-muted-foreground">
            Updated {formatDateTime(note.updatedAt)} · created{' '}
            {formatDateTime(note.createdAt)}
          </div>
        </>
      ) : (
        <form onSubmit={save} className="space-y-3">
          <header className="flex items-center justify-between">
            <h1 className="text-xl font-semibold">Edit note</h1>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setEditing(false);
                  setForm({
                    title: note.title,
                    content: note.content,
                    tags: note.tags.join(', '),
                  });
                }}
              >
                <X className="size-3" /> Cancel
              </Button>
              <Button type="submit" disabled={isPending}>
                <Save className="size-3" />
                {isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </header>
          <div className="space-y-1">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="content">Content (markdown)</Label>
            <textarea
              id="content"
              value={form.content}
              onChange={(e) => setForm({ ...form, content: e.target.value })}
              rows={20}
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
        </form>
      )}
    </div>
  );
}
