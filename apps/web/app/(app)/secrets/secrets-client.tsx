'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { KeyRound, Plus, Search, Tag, Trash2 } from 'lucide-react';
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

type FormState = {
  title: string;
  description: string;
  kind: Kind;
  tags: string;
  note: string;
  fields: Field[];
};

const emptyForm = (): FormState => ({
  title: '',
  description: '',
  kind: 'password',
  tags: '',
  note: '',
  fields: [{ label: '', value: '' }],
});

export function SecretsClient({
  initialSecrets,
  availableTags,
}: {
  initialSecrets: SecretRow[];
  availableTags: string[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [secrets, setSecrets] = useState(initialSecrets);
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<Kind | 'all'>('all');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return secrets.filter((s) => {
      if (kindFilter !== 'all' && s.kind !== kindFilter) return false;
      if (tagFilter && !s.tags.includes(tagFilter)) return false;
      if (q.length > 0) {
        const hay = [s.title, s.description, s.summary ?? '', s.tags.join(' ')]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [secrets, query, kindFilter, tagFilter]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const cleanFields = form.fields.filter((f) => f.label.trim() || f.value.length > 0);
    const tags = form.tags
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const body = {
      title: form.title.trim(),
      description: form.description.trim(),
      kind: form.kind,
      tags,
      note: form.note,
      fields: cleanFields,
    };
    if (!body.title) {
      setError('Title is required');
      return;
    }
    const res = await fetch('/api/secrets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? `request failed (${res.status})`);
      return;
    }
    const { secret } = await res.json();
    setSecrets((prev) => [secret, ...prev]);
    setForm(emptyForm());
    setOpen(false);
    startTransition(() => router.refresh());
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this secret? The encrypted value will be wiped.')) return;
    const res = await fetch(`/api/secrets/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast.error(j.error ?? `Could not delete secret (${res.status})`);
      return;
    }
    setSecrets((prev) => prev.filter((s) => s.id !== id));
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
            placeholder="Search by title, description, tags…"
            className="pl-8"
          />
        </div>
        <select
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value as Kind | 'all')}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="all">All kinds</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <Button onClick={() => setOpen(true)}>
          <Plus /> New secret
        </Button>
      </div>

      {availableTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Tags:</span>
          <button
            onClick={() => setTagFilter(null)}
            className={`rounded-full px-2 py-0.5 text-xs ${
              tagFilter === null
                ? 'bg-foreground text-background'
                : 'bg-muted text-muted-foreground hover:bg-muted-foreground/20'
            }`}
          >
            all
          </button>
          {availableTags.map((t) => (
            <button
              key={t}
              onClick={() => setTagFilter(t === tagFilter ? null : t)}
              className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                tagFilter === t
                  ? 'bg-foreground text-background'
                  : 'bg-muted text-muted-foreground hover:bg-muted-foreground/20'
              }`}
            >
              <Tag className="size-3" /> {t}
            </button>
          ))}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-muted/30 px-6 py-12 text-center text-sm text-muted-foreground">
          {secrets.length === 0
            ? 'No secrets yet. Click “New secret” to add your first one.'
            : 'No secrets match your filters.'}
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {filtered.map((s) => (
            <li key={s.id} className="group flex items-start gap-3 px-3 py-2.5">
              <KeyRound className="mt-1 size-4 text-muted-foreground" />
              <Link href={`/secrets/${s.id}`} className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="truncate font-medium">{s.title}</span>
                  <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                    {s.kind}
                  </span>
                </div>
                {s.description && (
                  <p className="line-clamp-1 text-xs text-muted-foreground">
                    {s.description}
                  </p>
                )}
                {s.summary && !s.description && (
                  <p className="line-clamp-1 text-xs italic text-muted-foreground">
                    {s.summary}
                  </p>
                )}
                <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                  {s.fieldCount > 0 && (
                    <span>
                      {s.fieldCount} field{s.fieldCount === 1 ? '' : 's'}
                    </span>
                  )}
                  {s.hasNote && <span>· note</span>}
                  {s.tags.map((t) => (
                    <span
                      key={t}
                      className="rounded-full bg-muted px-1.5 py-0.5 text-[10px]"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </Link>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleDelete(s.id)}
                className="opacity-0 transition-opacity group-hover:opacity-100"
                aria-label={`Delete ${s.title}`}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>New secret</DialogTitle>
            <DialogDescription>
              Title, description, and tags are indexed by the extractor so the
              assistant can find this without decrypting it. The note + fields
              are sealed and only shown on click.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="e.g. Linode VPS — production"
                autoFocus
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="kind">Kind</Label>
                <select
                  id="kind"
                  value={form.kind}
                  onChange={(e) => setForm({ ...form, kind: e.target.value as Kind })}
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
                  value={form.tags}
                  onChange={(e) => setForm({ ...form, tags: e.target.value })}
                  placeholder="hosting, prod, infra"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="description">Description</Label>
              <textarea
                id="description"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Short description so you (and the assistant) can find this. SAFE TO INDEX."
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
                    setForm({
                      ...form,
                      fields: [...form.fields, { label: '', value: '' }],
                    })
                  }
                >
                  <Plus className="size-3" /> Add field
                </Button>
              </div>
              {form.fields.map((f, i) => (
                <div key={i} className="flex gap-2">
                  <Input
                    placeholder="Label (e.g. username)"
                    value={f.label}
                    onChange={(e) => {
                      const next = [...form.fields];
                      next[i] = { ...next[i]!, label: e.target.value };
                      setForm({ ...form, fields: next });
                    }}
                    className="w-1/3"
                  />
                  <Input
                    placeholder="Value"
                    value={f.value}
                    onChange={(e) => {
                      const next = [...form.fields];
                      next[i] = { ...next[i]!, value: e.target.value };
                      setForm({ ...form, fields: next });
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const next = form.fields.filter((_, j) => j !== i);
                      setForm({
                        ...form,
                        fields: next.length === 0 ? [{ label: '', value: '' }] : next,
                      });
                    }}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              ))}
            </div>

            <div className="space-y-1">
              <Label htmlFor="note">Note (encrypted, markdown)</Label>
              <textarea
                id="note"
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
                placeholder="Free-form notes. Sealed alongside the fields."
                rows={6}
                className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setOpen(false);
                  setForm(emptyForm());
                  setError(null);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? 'Saving…' : 'Save secret'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
