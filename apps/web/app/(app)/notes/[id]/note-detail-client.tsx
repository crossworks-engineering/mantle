'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Pencil, Sparkles, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SubmitButton } from '@/components/ui/submit-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MarkdownEditor } from '@/components/markdown-editor';
import { TagPill } from '@/components/tag-pill';
import { TagInput } from '@/components/tag-input';
import { BackLink } from '@/components/layout/back-link';
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
  const toast = useToast();
  const [note, setNote] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<{ title: string; content: string; tags: string[] }>({
    title: note.title,
    content: note.content,
    tags: note.tags,
  });
  const [isPending, startTransition] = useTransition();
  const [deleteOpen, setDeleteOpen] = useState(false);

  const resetForm = () =>
    setForm({ title: note.title, content: note.content, tags: note.tags });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch(`/api/notes/${note.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: form.title.trim(),
        content: form.content,
        tags: form.tags,
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast.error(j.error ?? 'Save failed');
      return;
    }
    const { note: updated } = await res.json();
    setNote(updated);
    setEditing(false);
    toast.success('Saved');
    startTransition(() => router.refresh());
  };

  const confirmDelete = async () => {
    const res = await fetch(`/api/notes/${note.id}`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error('Could not delete note');
      return;
    }
    toast.success('Note deleted');
    router.push('/notes');
  };

  return (
    <div className="space-y-4">
      <SetPageTitle title={note.title} />
      <BackLink href="/notes">All notes</BackLink>

      {!editing ? (
        <>
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-1 flex-wrap gap-1">
              {note.tags.map((t) => (
                <TagPill key={t} tag={t} />
              ))}
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => setDeleteOpen(true)}
                aria-label="Delete note"
              >
                <Trash2 />
              </Button>
            </div>
          </div>

          <article className="prose prose-sm dark:prose-invert max-w-none rounded-md border border-border bg-card p-5">
            {note.content ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{note.content}</ReactMarkdown>
            ) : (
              <p className="text-sm italic text-muted-foreground">No content yet.</p>
            )}
          </article>

          {note.summary && (
            <aside className="rounded-md border border-border bg-muted/40 p-3">
              <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Sparkles className="size-3.5" aria-hidden /> Indexed summary
              </div>
              <p className="text-sm text-muted-foreground">{note.summary}</p>
            </aside>
          )}

          <div className="border-t border-border pt-3 text-xs text-muted-foreground">
            Updated {formatDateTime(note.updatedAt)} · created {formatDateTime(note.createdAt)}
          </div>
        </>
      ) : (
        <form onSubmit={save} className="space-y-4">
          <header className="flex items-center justify-between">
            <h2 className="text-base font-semibold">Edit note</h2>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setEditing(false);
                  resetForm();
                }}
              >
                <X /> Cancel
              </Button>
              <SubmitButton pending={isPending} size="sm">
                Save note
              </SubmitButton>
            </div>
          </header>
          <div className="space-y-1.5">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label>
              Content <span className="font-normal text-muted-foreground">(markdown)</span>
            </Label>
            <MarkdownEditor
              value={form.content}
              onChange={(content) => setForm({ ...form, content })}
              placeholder="Write in markdown…"
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
        </form>
      )}

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{note.title}”?</AlertDialogTitle>
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
