'use client';

import { useState } from 'react';
import { KeyRound, Lock, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SubmitButton } from '@/components/ui/submit-button';
import { useToast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/format-datetime';

type Pw = { id: string; label: string; lastUsedAt: string | null; createdAt: string };

export function PdfPasswordsClient({ initial }: { initial: Pw[] }) {
  const toast = useToast();
  const [rows, setRows] = useState<Pw[]>(initial);
  const [label, setLabel] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return toast.error('Enter a password');
    setPending(true);
    const res = await fetch('/api/pdf-passwords', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: label.trim() || undefined, password }),
    });
    setPending(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return toast.error(j.error ?? `Could not add (${res.status})`);
    }
    const { password: row } = await res.json();
    setRows((p) => [row, ...p]);
    setLabel('');
    setPassword('');
    toast.success('Password added');
  };

  const remove = async (id: string) => {
    const res = await fetch(`/api/pdf-passwords/${id}`, { method: 'DELETE' });
    if (!res.ok) return toast.error('Could not delete');
    setRows((p) => p.filter((r) => r.id !== id));
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Lock className="size-5 text-primary" aria-hidden />
          <h2 className="text-lg font-semibold">PDF passwords</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Passwords for encrypted PDF attachments (bank statements, invoices — often the last
          digits of an ID or an account number). When an email attachment is locked, the extractor
          tries each of these to unlock and read it. Sealed at rest; shown once here, never again.
        </p>
      </div>

      <form onSubmit={add} className="flex flex-col gap-3 rounded-md border border-border p-4 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="pw-label">Label (optional)</Label>
          <Input id="pw-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Nedbank — account no" />
        </div>
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="pw-value">Password</Label>
          <Input id="pw-value" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="e.g. 1136603190" autoComplete="off" />
        </div>
        <SubmitButton pending={pending}>
          <Plus /> Add
        </SubmitButton>
      </form>

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
          No PDF passwords yet. Add one above and locked attachments will start unlocking on the next
          extraction.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
              <KeyRound className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{r.label || 'Untitled'}</div>
                <div className="text-xs text-muted-foreground">
                  {r.lastUsedAt ? `Last unlocked a PDF ${formatDateTime(r.lastUsedAt)}` : 'Not used yet'}
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
