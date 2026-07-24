'use client';

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@mantle/web-ui/ui/button';
import { SubmitButton } from '@mantle/web-ui/ui/submit-button';
import { Input } from '@mantle/web-ui/ui/input';
import { Label } from '@mantle/web-ui/ui/label';
import { TagInput } from '@/components/tag-input';

export const KINDS = ['password', 'token', 'server', 'card', 'note', 'other'] as const;
export type Kind = (typeof KINDS)[number];
export type Field = { label: string; value: string };

/** Editable form state (tags as string[] for <TagInput>). */
export type SecretFormValues = {
  title: string;
  description: string;
  kind: Kind;
  tags: string[];
  note: string;
  fields: Field[];
};

/** Cleaned payload sent to the API (create + edit share this shape). */
export type SecretBody = {
  title: string;
  description: string;
  kind: Kind;
  tags: string[];
  note: string;
  fields: Field[];
};

export const emptySecretForm = (): SecretFormValues => ({
  title: '',
  description: '',
  kind: 'password',
  tags: [],
  note: '',
  fields: [{ label: '', value: '' }],
});

/**
 * Shared secret editor body — used by the master-detail "create" pane and the
 * SecretDetail "edit" mode. Owns its own field state + title validation; the
 * parent does the actual fetch in `onSubmit` and switches view on success.
 */
export function SecretForm({
  initial,
  submitLabel,
  submitting,
  onSubmit,
  onCancel,
}: {
  initial: SecretFormValues;
  submitLabel: string;
  submitting?: boolean;
  onSubmit: (body: SecretBody) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<SecretFormValues>(initial);
  const [error, setError] = useState<string | null>(null);

  const setField = (i: number, patch: Partial<Field>) => {
    const next = [...form.fields];
    next[i] = { ...next[i]!, ...patch };
    setForm({ ...form, fields: next });
  };
  const removeField = (i: number) => {
    const next = form.fields.filter((_, j) => j !== i);
    setForm({ ...form, fields: next.length === 0 ? [{ label: '', value: '' }] : next });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const title = form.title.trim();
    if (!title) {
      setError('Title is required');
      return;
    }
    await onSubmit({
      title,
      description: form.description.trim(),
      kind: form.kind,
      tags: form.tags.map((t) => t.trim().toLowerCase()).filter(Boolean),
      note: form.note,
      fields: form.fields.filter((f) => f.label.trim() || f.value.length > 0),
    });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="secret-title">Title</Label>
        <Input
          id="secret-title"
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          placeholder="e.g. Contabo VPS — production"
          autoFocus
          required
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="secret-kind">Kind</Label>
          <select
            id="secret-kind"
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value as Kind })}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label>Tags</Label>
          <TagInput
            value={form.tags}
            onChange={(tags) => setForm({ ...form, tags })}
            placeholder="Add tags…"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="secret-description">Description</Label>
        <textarea
          id="secret-description"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="Short, safe-to-index description so you (and the assistant) can find this."
          rows={2}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        <p className="text-xs text-muted-foreground">
          Title, description, and tags are indexed by the extractor. The fields + note below are
          sealed (AES-256-GCM) and only shown on reveal.
        </p>
      </div>

      <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
        <div className="flex items-center justify-between">
          <Label>Fields (encrypted)</Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setForm({ ...form, fields: [...form.fields, { label: '', value: '' }] })}
          >
            <Plus /> Add field
          </Button>
        </div>
        {form.fields.map((f, i) => (
          <div key={i} className="flex gap-2">
            <Input
              placeholder="Label (e.g. username)"
              value={f.label}
              onChange={(e) => setField(i, { label: e.target.value })}
              className="w-1/3"
            />
            <Input
              placeholder="Value"
              value={f.value}
              onChange={(e) => setField(i, { value: e.target.value })}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-9 shrink-0"
              onClick={() => removeField(i)}
              aria-label="Remove field"
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="secret-note">Note (encrypted)</Label>
        <textarea
          id="secret-note"
          value={form.note}
          onChange={(e) => setForm({ ...form, note: e.target.value })}
          placeholder="Free-form notes. Sealed alongside the fields."
          rows={6}
          className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <SubmitButton pending={submitting}>{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}
