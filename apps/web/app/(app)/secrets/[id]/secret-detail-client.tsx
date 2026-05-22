'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { formatDateTime } from '@/lib/format-datetime';
import {
  ArrowLeft,
  Check,
  Copy,
  Eye,
  EyeOff,
  Pencil,
  Plus,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { SetPageTitle } from '@/components/layout/page-title';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';

const KINDS = ['password', 'token', 'server', 'card', 'note', 'other'] as const;
type Kind = (typeof KINDS)[number];

type SecretRow = {
  id: string;
  title: string;
  description: string;
  kind: Kind;
  tags: string[];
  hasNote: boolean;
  fieldCount: number;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
};

type Field = { label: string; value: string };

type Payload = { note: string; fields: Field[] };

export function SecretDetailClient({ initial }: { initial: SecretRow }) {
  const router = useRouter();
  const toast = useToast();
  const [meta, setMeta] = useState(initial);
  const [revealed, setRevealed] = useState<Payload | null>(null);
  const [revealedFieldIdx, setRevealedFieldIdx] = useState<Set<number>>(new Set());
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<{
    title: string;
    description: string;
    kind: Kind;
    tags: string;
    note: string;
    fields: Field[];
  } | null>(null);
  const [isPending, startTransition] = useTransition();

  const reveal = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/secrets/${meta.id}/reveal`, { method: 'POST' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? `reveal failed (${res.status})`);
        return;
      }
      const data = await res.json();
      setRevealed(data.payload);
      // Reveal every field by default — user already proved intent with one click.
      setRevealedFieldIdx(new Set(data.payload.fields.map((_: Field, i: number) => i)));
    } finally {
      setLoading(false);
    }
  };

  const hide = () => {
    setRevealed(null);
    setRevealedFieldIdx(new Set());
    setCopiedIdx(null);
  };

  const toggleField = (idx: number) => {
    setRevealedFieldIdx((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const copyField = async (idx: number, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx((c) => (c === idx ? null : c)), 1500);
  };

  const startEdit = async () => {
    // We need the sealed payload to seed the edit form. Reveal if not already.
    let payload = revealed;
    if (!payload) {
      setLoading(true);
      try {
        const res = await fetch(`/api/secrets/${meta.id}/reveal`, { method: 'POST' });
        if (!res.ok) {
          setError('reveal failed');
          return;
        }
        payload = (await res.json()).payload as Payload;
      } finally {
        setLoading(false);
      }
    }
    setEditForm({
      title: meta.title,
      description: meta.description,
      kind: meta.kind,
      tags: meta.tags.join(', '),
      note: payload.note,
      fields:
        payload.fields.length > 0 ? payload.fields : [{ label: '', value: '' }],
    });
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setEditForm(null);
    setError(null);
  };

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editForm) return;
    setError(null);
    const tags = editForm.tags
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const cleanFields = editForm.fields.filter(
      (f) => f.label.trim() || f.value.length > 0,
    );
    const body = {
      title: editForm.title.trim(),
      description: editForm.description,
      kind: editForm.kind,
      tags,
      note: editForm.note,
      fields: cleanFields,
    };
    if (!body.title) {
      setError('Title is required');
      return;
    }
    const res = await fetch(`/api/secrets/${meta.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? `save failed (${res.status})`);
      return;
    }
    const { secret } = await res.json();
    setMeta(secret);
    setRevealed({ note: editForm.note, fields: cleanFields });
    setRevealedFieldIdx(new Set(cleanFields.map((_, i) => i)));
    setEditing(false);
    setEditForm(null);
    startTransition(() => router.refresh());
  };

  const handleDelete = async () => {
    if (!confirm('Delete this secret? The encrypted value will be wiped.')) return;
    const res = await fetch(`/api/secrets/${meta.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast.error(j.error ?? `Could not delete secret (${res.status})`);
      return;
    }
    router.push('/secrets');
  };

  return (
    <div className="space-y-6">
      <SetPageTitle title={meta.title} />
      <div>
        <Link
          href="/secrets"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3" /> All secrets
        </Link>
      </div>

      {!editing ? (
        <>
          <header className="space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                    {meta.kind}
                  </span>
                </div>
                {meta.description && (
                  <p className="text-sm text-muted-foreground">{meta.description}</p>
                )}
                {meta.summary && (
                  <p className="text-xs italic text-muted-foreground">
                    Indexed: {meta.summary}
                  </p>
                )}
                {meta.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {meta.tags.map((t) => (
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
                <Button variant="outline" size="sm" onClick={startEdit}>
                  <Pencil className="mr-1 size-3" /> Edit
                </Button>
                <Button variant="ghost" size="sm" onClick={handleDelete} aria-label="Delete secret">
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          </header>

          {error && (
            <div className="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {/* Reveal panel */}
          {!revealed ? (
            <div className="rounded-md border border-border bg-muted/20 p-6 text-center">
              <p className="mb-3 text-sm text-muted-foreground">
                {meta.fieldCount} field{meta.fieldCount === 1 ? '' : 's'}
                {meta.hasNote ? ' + note' : ''} · sealed
              </p>
              <Button onClick={reveal} disabled={loading}>
                <Eye className="mr-1 size-4" />
                {loading ? 'Decrypting…' : 'Reveal'}
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={hide}>
                  <EyeOff className="mr-1 size-3" /> Hide
                </Button>
              </div>

              {revealed.fields.length > 0 && (
                <div className="space-y-2 rounded-md border border-border">
                  {revealed.fields.map((f, i) => {
                    const visible = revealedFieldIdx.has(i);
                    return (
                      <div
                        key={i}
                        className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0"
                      >
                        <div className="w-32 shrink-0 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                          {f.label || '(unlabeled)'}
                        </div>
                        <code className="flex-1 truncate font-mono text-sm">
                          {visible ? f.value : '•'.repeat(Math.min(f.value.length, 24))}
                        </code>
                        <button
                          onClick={() => toggleField(i)}
                          className="text-muted-foreground hover:text-foreground"
                          aria-label={visible ? 'Hide field' : 'Show field'}
                        >
                          {visible ? (
                            <EyeOff className="size-4" />
                          ) : (
                            <Eye className="size-4" />
                          )}
                        </button>
                        <button
                          onClick={() => copyField(i, f.value)}
                          className="text-muted-foreground hover:text-foreground"
                          aria-label="Copy"
                        >
                          {copiedIdx === i ? (
                            <Check className="size-4 text-emerald-600" />
                          ) : (
                            <Copy className="size-4" />
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {revealed.note && (
                <div className="space-y-1">
                  <Label>Note</Label>
                  <pre className="whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 font-mono text-sm">
                    {revealed.note}
                  </pre>
                </div>
              )}

              {revealed.fields.length === 0 && !revealed.note && (
                <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                  No fields or note. Click Edit to add some.
                </p>
              )}
            </div>
          )}

          <div className="border-t border-border pt-3 text-xs text-muted-foreground">
            Updated {formatDateTime(meta.updatedAt)} · created{' '}
            {formatDateTime(meta.createdAt)}
          </div>
        </>
      ) : (
        editForm && (
          <form onSubmit={saveEdit} className="space-y-3">
            <header className="flex items-center justify-between">
              <h1 className="text-xl font-semibold">Edit secret</h1>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={cancelEdit}>
                  <X className="mr-1 size-3" /> Cancel
                </Button>
                <Button type="submit" disabled={isPending}>
                  <Save className="mr-1 size-3" /> {isPending ? 'Saving…' : 'Save'}
                </Button>
              </div>
            </header>

            <div className="space-y-1">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                value={editForm.title}
                onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="kind">Kind</Label>
                <select
                  id="kind"
                  value={editForm.kind}
                  onChange={(e) =>
                    setEditForm({ ...editForm, kind: e.target.value as Kind })
                  }
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="tags">Tags (comma-separated)</Label>
                <Input
                  id="tags"
                  value={editForm.tags}
                  onChange={(e) => setEditForm({ ...editForm, tags: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="description">Description</Label>
              <textarea
                id="description"
                value={editForm.description}
                onChange={(e) =>
                  setEditForm({ ...editForm, description: e.target.value })
                }
                rows={2}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>

            <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
              <div className="flex items-center justify-between">
                <Label>Fields (encrypted)</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setEditForm({
                      ...editForm,
                      fields: [...editForm.fields, { label: '', value: '' }],
                    })
                  }
                >
                  <Plus className="mr-1 size-3" /> Add field
                </Button>
              </div>
              {editForm.fields.map((f, i) => (
                <div key={i} className="flex gap-2">
                  <Input
                    placeholder="Label"
                    value={f.label}
                    onChange={(e) => {
                      const next = [...editForm.fields];
                      next[i] = { ...next[i]!, label: e.target.value };
                      setEditForm({ ...editForm, fields: next });
                    }}
                    className="w-1/3"
                  />
                  <Input
                    placeholder="Value"
                    value={f.value}
                    onChange={(e) => {
                      const next = [...editForm.fields];
                      next[i] = { ...next[i]!, value: e.target.value };
                      setEditForm({ ...editForm, fields: next });
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const next = editForm.fields.filter((_, j) => j !== i);
                      setEditForm({
                        ...editForm,
                        fields:
                          next.length === 0 ? [{ label: '', value: '' }] : next,
                      });
                    }}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              ))}
            </div>

            <div className="space-y-1">
              <Label htmlFor="note">Note</Label>
              <textarea
                id="note"
                value={editForm.note}
                onChange={(e) => setEditForm({ ...editForm, note: e.target.value })}
                rows={8}
                className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </form>
        )
      )}
    </div>
  );
}
