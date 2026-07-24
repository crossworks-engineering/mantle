'use client';

import { useState, useTransition } from 'react';
import { Check, Copy, Eye, EyeOff, Loader2, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@mantle/web-ui/ui/button';
import { Label } from '@mantle/web-ui/ui/label';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@mantle/web-ui/ui/alert-dialog';
import { useToast } from '@mantle/web-ui/ui/toast';
import { apiSend, ApiError } from '@mantle/web-ui/api-fetch';
import { formatDateTime } from '@mantle/web-ui/lib/format-datetime';
import {
  SecretForm,
  type Field,
  type Kind,
  type SecretBody,
  type SecretFormValues,
} from './secret-form';
import { copyText } from '@mantle/web-ui/lib/secure-context-fallbacks';

export type SecretRow = {
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

type Payload = { note: string; fields: Field[] };

/**
 * Chrome-free secret detail: reveal (decrypt on demand), edit, delete. Used both
 * in the master-detail right pane and on the /secrets/[id] deep-link page (which
 * wraps it with SetPageTitle + BackLink). Callbacks let the host keep its list /
 * route in sync. Mount with `key={secret.id}` so selecting another secret resets
 * the revealed/edit state.
 */
export function SecretDetail({
  secret,
  onUpdated,
  onDeleted,
}: {
  secret: SecretRow;
  onUpdated?: (s: SecretRow) => void;
  onDeleted?: () => void;
}) {
  const toast = useToast();
  const [meta, setMeta] = useState(secret);
  const [revealed, setRevealed] = useState<Payload | null>(null);
  const [visibleIdx, setVisibleIdx] = useState<Set<number>>(new Set());
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editInitial, setEditInitial] = useState<SecretFormValues | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const fetchPayload = async (): Promise<Payload | null> => {
    try {
      const { payload } = await apiSend<{ payload: Payload }>(
        `/api/secrets/${meta.id}/reveal`,
        'POST',
      );
      return payload;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Reveal failed');
      return null;
    }
  };

  const reveal = async () => {
    setLoading(true);
    try {
      const payload = await fetchPayload();
      if (!payload) return;
      setRevealed(payload);
      setVisibleIdx(new Set(payload.fields.map((_, i) => i))); // one click = show all
    } finally {
      setLoading(false);
    }
  };

  const hide = () => {
    setRevealed(null);
    setVisibleIdx(new Set());
    setCopiedIdx(null);
  };

  const toggleField = (i: number) =>
    setVisibleIdx((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });

  const copyField = async (i: number, value: string) => {
    await copyText(value);
    setCopiedIdx(i);
    setTimeout(() => setCopiedIdx((c) => (c === i ? null : c)), 1500);
  };

  const startEdit = async () => {
    setLoading(true);
    try {
      const payload = revealed ?? (await fetchPayload());
      if (!payload) return;
      setRevealed(payload);
      setEditInitial({
        title: meta.title,
        description: meta.description,
        kind: meta.kind,
        tags: meta.tags,
        note: payload.note,
        fields: payload.fields.length > 0 ? payload.fields : [{ label: '', value: '' }],
      });
      setEditing(true);
    } finally {
      setLoading(false);
    }
  };

  const saveEdit = async (body: SecretBody) => {
    let updated: SecretRow;
    try {
      ({ secret: updated } = await apiSend<{ secret: SecretRow }>(
        `/api/secrets/${meta.id}`,
        'PATCH',
        body,
      ));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Save failed');
      return;
    }
    setMeta(updated);
    setRevealed({ note: body.note, fields: body.fields });
    setVisibleIdx(new Set(body.fields.map((_, i) => i)));
    setEditing(false);
    onUpdated?.(updated);
  };

  const confirmDelete = async () => {
    setDeleteOpen(false);
    try {
      await apiSend(`/api/secrets/${meta.id}`, 'DELETE');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not delete secret');
      return;
    }
    toast.success(`Deleted “${meta.title}”`);
    startTransition(() => onDeleted?.());
  };

  if (editing && editInitial) {
    return (
      <div className="space-y-4 p-6">
        <h2 className="text-lg font-semibold">Edit secret</h2>
        <SecretForm
          initial={editInitial}
          submitLabel="Save secret"
          submitting={pending}
          onSubmit={saveEdit}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold">{meta.title}</h2>
            <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              {meta.kind}
            </span>
          </div>
          {meta.description && <p className="text-sm text-muted-foreground">{meta.description}</p>}
          {meta.summary && !meta.description && (
            <p className="text-xs italic text-muted-foreground">Indexed: {meta.summary}</p>
          )}
          {meta.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-0.5">
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
          <Button variant="outline" size="sm" onClick={startEdit} disabled={loading}>
            <Pencil /> Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 /> Delete
          </Button>
        </div>
      </div>

      {/* Reveal panel */}
      {!revealed ? (
        <div className="rounded-md border border-border bg-muted/20 p-6 text-center">
          <p className="mb-3 text-sm text-muted-foreground">
            {meta.fieldCount} field{meta.fieldCount === 1 ? '' : 's'}
            {meta.hasNote ? ' + note' : ''} · sealed
          </p>
          <Button onClick={reveal} disabled={loading}>
            {loading ? <Loader2 className="animate-spin" /> : <Eye />}
            {loading ? 'Decrypting…' : 'Reveal'}
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={hide}>
              <EyeOff /> Hide
            </Button>
          </div>

          {revealed.fields.length > 0 && (
            <div className="rounded-md border border-border">
              {revealed.fields.map((f, i) => {
                const visible = visibleIdx.has(i);
                return (
                  <div
                    key={i}
                    className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0"
                  >
                    <div className="w-32 shrink-0 truncate text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      {f.label || '(unlabeled)'}
                    </div>
                    <code className="flex-1 truncate font-mono text-sm">
                      {visible ? f.value : '•'.repeat(Math.min(f.value.length, 24))}
                    </code>
                    <button
                      type="button"
                      onClick={() => toggleField(i)}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label={visible ? 'Hide field' : 'Show field'}
                    >
                      {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                    <button
                      type="button"
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
            <div className="space-y-1.5">
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
        Updated {formatDateTime(meta.updatedAt)} · created {formatDateTime(meta.createdAt)}
      </div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{meta.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The encrypted value will be wiped. This cannot be undone.
            </AlertDialogDescription>
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
