'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Lock, Plus, Trash2 } from 'lucide-react';
import { apiFetch, apiSend, ApiError } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SubmitButton } from '@/components/ui/submit-button';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/format-datetime';

type Pw = { id: string; label: string; lastUsedAt: string | null; createdAt: string };

export function PdfPasswordsClient() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const pwQuery = useQuery({
    queryKey: ['pdf-passwords'],
    queryFn: () => apiFetch<{ passwords: Pw[] }>('/api/pdf-passwords'),
  });
  const [label, setLabel] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['pdf-passwords'] });

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return toast.error('Enter a password');
    setPending(true);
    try {
      await apiSend('/api/pdf-passwords', 'POST', {
        label: label.trim() || undefined,
        password,
      });
      await invalidate();
      setLabel('');
      setPassword('');
      toast.success('Password added');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not add');
    } finally {
      setPending(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await apiSend(`/api/pdf-passwords/${id}`, 'DELETE');
      await invalidate();
    } catch {
      toast.error('Could not delete');
    }
  };

  if (pwQuery.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }
  if (pwQuery.isError && !pwQuery.data) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-center gap-3 py-12 text-sm text-muted-foreground">
        <p>Couldn&apos;t load PDF passwords.</p>
        <Button variant="outline" size="sm" onClick={() => pwQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const rows = pwQuery.data.passwords;

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Lock className="size-5 text-primary" aria-hidden />
          <h2 className="text-lg font-semibold">PDF passwords</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Passwords for encrypted PDF attachments (bank statements, invoices — often the last digits
          of an ID or an account number). When an email attachment is locked, the extractor tries
          each of these to unlock and read it. Sealed at rest; shown once here, never again.
        </p>
      </div>

      <form
        onSubmit={add}
        className="flex flex-col gap-3 rounded-md border border-border p-4 sm:flex-row sm:items-end"
      >
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="pw-label">Label (optional)</Label>
          <Input
            id="pw-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Nedbank — account no"
          />
        </div>
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="pw-value">Password</Label>
          <Input
            id="pw-value"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="e.g. 1136603190"
            autoComplete="off"
          />
        </div>
        <SubmitButton pending={pending}>
          <Plus /> Add
        </SubmitButton>
      </form>

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
          No PDF passwords yet. Add one above and locked attachments will start unlocking on the
          next extraction.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
              <KeyRound className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{r.label || 'Untitled'}</div>
                <div className="text-xs text-muted-foreground">
                  {r.lastUsedAt
                    ? `Last unlocked a PDF ${formatDateTime(r.lastUsedAt)}`
                    : 'Not used yet'}
                </div>
              </div>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">•••••</span>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-7 text-muted-foreground hover:text-destructive"
                onClick={() => remove(r.id)}
                aria-label="Delete"
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
