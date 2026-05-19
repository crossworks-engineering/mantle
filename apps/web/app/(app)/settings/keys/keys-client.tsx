'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format-datetime';
import { testApiKeyAction, type TestApiKeyResult } from './actions';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type KeyRow = {
  id: string;
  service: string;
  label: string;
  masked: string;
  lastUsed: string | null;
  updatedAt: string;
};

// Providers come from the canonical catalogue in @mantle/voice. The
// `service` column on api_keys is still free text (so a power user
// can register a key for a service we haven't catalogued yet), but
// the dropdown is closed by default — typos here lead to silent
// runtime failures.
import { SUPPORTED_PROVIDERS, isProviderWired } from '@mantle/voice';

/** Whether a provider has at least one dispatch path wired (for any
 *  capability). Determines the "— not yet wired" hint in the dropdown.
 *  A provider is "wired enough" if any of its capabilities resolves to
 *  a registered adapter (or is a built-in chat/embedding path). */
function providerHasAnyAdapter(providerId: string, capabilities: readonly string[]): boolean {
  return capabilities.some((c) =>
    isProviderWired(providerId, c as Parameters<typeof isProviderWired>[1]),
  );
}

export function KeysClient({ initialKeys }: { initialKeys: KeyRow[] }) {
  const router = useRouter();
  const [keys, setKeys] = useState<KeyRow[]>(initialKeys);
  const [pending, startTransition] = useTransition();

  // Sync local state to the prop after a create/rotate refresh.
  // useState's initialValue is only read on first mount.
  useEffect(() => {
    setKeys(initialKeys);
  }, [initialKeys]);

  const [service, setService] = useState('openrouter');
  const [label, setLabel] = useState('default');
  const [plaintext, setPlaintext] = useState('');
  const [error, setError] = useState<string>();

  // After a successful create or rotate, show the plaintext exactly once.
  const [revealed, setRevealed] = useState<{ key: string; service: string; label: string }>();

  // Rotate flow state.
  const [rotating, setRotating] = useState<KeyRow>();
  const [rotateValue, setRotateValue] = useState('');

  // Test-key flow state. Keyed by api_keys.id so the result chip
  // renders next to the row the user actually clicked, even if
  // they hit Test on several rows in a row.
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [testResults, setTestResults] = useState<Record<string, TestApiKeyResult>>({});

  async function onTest(row: KeyRow) {
    setTesting((s) => ({ ...s, [row.id]: true }));
    try {
      const result = await testApiKeyAction(row.id, row.service);
      setTestResults((s) => ({ ...s, [row.id]: result }));
    } catch (err) {
      setTestResults((s) => ({
        ...s,
        [row.id]: {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
          provider: row.service,
          adapter: '',
        },
      }));
    } finally {
      setTesting((s) => ({ ...s, [row.id]: false }));
    }
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    if (!plaintext.trim()) {
      setError('Paste the key value.');
      return;
    }
    const res = await fetch('/api/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service: service.trim(), label: label.trim() || 'default', plaintext }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? 'Failed to save key.');
      return;
    }
    setRevealed({ key: plaintext, service: service.trim(), label: label.trim() || 'default' });
    setPlaintext('');
    setLabel('default');
    startTransition(() => router.refresh());
  }

  async function onRotate(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    if (!rotating || !rotateValue.trim()) return;
    const res = await fetch(`/api/keys/${rotating.id}/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plaintext: rotateValue }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? 'Failed to rotate.');
      return;
    }
    setRevealed({ key: rotateValue, service: rotating.service, label: rotating.label });
    setRotating(undefined);
    setRotateValue('');
    startTransition(() => router.refresh());
  }

  async function onDelete(row: KeyRow) {
    if (!confirm(`Delete the ${row.service}/${row.label} key? This cannot be undone.`)) return;
    const res = await fetch(`/api/keys/${row.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? 'Failed to delete.');
      return;
    }
    setKeys((prev) => prev.filter((k) => k.id !== row.id));
    startTransition(() => router.refresh());
  }

  return (
    <div className="space-y-8">
      {/* Existing keys */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Saved keys
        </h2>
        {keys.length === 0 ? (
          <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
            No keys yet. Add one below.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {keys.map((k) => {
              const testResult = testResults[k.id];
              const isTesting = !!testing[k.id];
              return (
              <li key={k.id} className="flex flex-col gap-1.5 px-3 py-2">
                <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium">{k.service}</span>
                    <span className="text-xs text-muted-foreground">/ {k.label}</span>
                  </div>
                  <div className="flex items-baseline gap-3 text-xs text-muted-foreground">
                    <code className="font-mono">{k.masked}</code>
                    <span>
                      last used{' '}
                      {formatDateTime(k.lastUsed)}
                    </span>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={isTesting}
                  onClick={() => onTest(k)}
                  title="Make a no-cost API call to verify this key is accepted"
                >
                  {isTesting ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  ) : (
                    <ShieldCheck className="size-3.5" aria-hidden />
                  )}{' '}
                  Test
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setRotating(k);
                    setRotateValue('');
                  }}
                >
                  <RefreshCw className="size-3.5" aria-hidden /> Rotate
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onDelete(k)}
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="size-3.5" aria-hidden /> Delete
                </Button>
                </div>
                {testResult && (
                  <div
                    className={`flex items-start gap-1.5 rounded-md px-2 py-1 text-xs ${
                      testResult.ok
                        ? 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100'
                        : 'bg-rose-50 text-rose-900 dark:bg-rose-950/40 dark:text-rose-100'
                    }`}
                  >
                    {testResult.ok ? (
                      <Check className="size-3.5 shrink-0 translate-y-0.5" aria-hidden />
                    ) : (
                      <X className="size-3.5 shrink-0 translate-y-0.5" aria-hidden />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{testResult.message}</div>
                      {testResult.adapter && (
                        <div className="text-[10px] uppercase tracking-wide opacity-70">
                          probed via {testResult.adapter}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Add a new key */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Add a new key
        </h2>
        <form onSubmit={onCreate} className="space-y-3 rounded-md border border-border p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="service">Provider</Label>
              <select
                id="service"
                value={service}
                onChange={(e) => setService(e.target.value)}
                required
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
              >
                {SUPPORTED_PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                    {p.isAggregator ? ' (aggregator)' : ''}
                    {!providerHasAnyAdapter(p.id, p.capabilities)
                      ? ' — not yet wired'
                      : ''}
                  </option>
                ))}
              </select>
              {/* Show the description + signup link for the currently
                  selected provider so the user can hop to the right
                  console without leaving the form. */}
              {(() => {
                const p = SUPPORTED_PROVIDERS.find((x) => x.id === service);
                return p ? (
                  <p className="text-xs text-muted-foreground">
                    {p.description}{' '}
                    <a
                      href={p.signupUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      Get a key →
                    </a>
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">Pick a provider.</p>
                );
              })()}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="label">Label</Label>
              <Input
                id="label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="default"
              />
              <p className="text-xs text-muted-foreground">
                Disambiguates multiple keys for the same service (e.g. <code>personal</code>,{' '}
                <code>agent</code>).
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="plaintext">Key value</Label>
            <Input
              id="plaintext"
              type="password"
              autoComplete="off"
              value={plaintext}
              onChange={(e) => setPlaintext(e.target.value)}
              placeholder="sk-…"
              required
            />
            <p className="text-xs text-muted-foreground">
              Stored as AES-256-GCM ciphertext. The plaintext will be shown once after save,
              then never again.
            </p>
          </div>

          {error && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="flex justify-end">
            <Button type="submit" disabled={pending}>
              Save key
            </Button>
          </div>
        </form>
      </section>

      {/* Reveal-once modal */}
      <Dialog open={!!revealed} onOpenChange={(open) => !open && setRevealed(undefined)}>
        <DialogContent className="!h-auto !max-h-[60vh] !max-w-md">
          <DialogHeader>
            <DialogTitle>Save this key now</DialogTitle>
            <DialogDescription>
              You won&apos;t be able to see <code>{revealed?.service}</code> /{' '}
              <code>{revealed?.label}</code> again after closing this dialog.
            </DialogDescription>
          </DialogHeader>
          <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 text-xs">
            {revealed?.key}
          </pre>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (revealed) navigator.clipboard.writeText(revealed.key);
              }}
            >
              Copy
            </Button>
            <Button type="button" onClick={() => setRevealed(undefined)}>
              I&apos;ve saved it
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Rotate modal */}
      <Dialog open={!!rotating} onOpenChange={(open) => !open && setRotating(undefined)}>
        <DialogContent className="!h-auto !max-h-[60vh] !max-w-md">
          <DialogHeader>
            <DialogTitle>
              Rotate {rotating?.service} / {rotating?.label}
            </DialogTitle>
            <DialogDescription>
              Paste the new key value. The previous ciphertext is overwritten — there&apos;s
              no undo.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={onRotate} className="space-y-3">
            <Input
              type="password"
              autoComplete="off"
              value={rotateValue}
              onChange={(e) => setRotateValue(e.target.value)}
              placeholder="sk-…"
              required
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setRotating(undefined)}>
                Cancel
              </Button>
              <Button type="submit">Rotate</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
