'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, Plus, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react';
import { Button } from '@mantle/web-ui/ui/button';
import { SubmitButton } from '@mantle/web-ui/ui/submit-button';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { formatDateTime } from '@mantle/web-ui/lib/format-datetime';
import { apiFetch, apiSend, ApiError } from '@mantle/web-ui/api-fetch';
import type { TestApiKeyResult } from '@/lib/api-key-test';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@mantle/web-ui/ui/dialog';
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
import { Input } from '@mantle/web-ui/ui/input';
import { Label } from '@mantle/web-ui/ui/label';
import { useToast } from '@mantle/web-ui/ui/toast';
import { cn } from '@mantle/web-ui/lib/utils';
import { SUPPORTED_PROVIDERS, wiredCapabilitiesFor } from '@mantle/voice/client';
import { copyText } from '@mantle/web-ui/lib/secure-context-fallbacks';

type KeyRow = {
  id: string;
  service: string;
  label: string;
  masked: string;
  lastUsed: string | null;
  updatedAt: string;
};

// Note: per-capability wired/unwired status comes from
// `wiredCapabilitiesFor(provider)` (see @mantle/voice/adapters/registry).
// The dropdown surfaces this inline so operators see exactly what their
// key will be usable for — pre-fix, the dropdown only flagged providers
// with zero wired capabilities, so partially-wired providers (Mistral +
// Cohere — chat declared but only embedding wired) looked fully working.

// Sentinel for the "not an LLM/voice provider" path — lets the operator store a
// key for an arbitrary HTTP API (mapbox, locationiq, …) that their API-console
// tools reference via {{secret:service/label}}. The backend already accepts any
// service matching ^[a-z0-9_-]+$; the dropdown just needs an escape hatch.
const CUSTOM_SERVICE = '__custom__';
const SERVICE_RE = /^[a-z0-9_-]+$/;

type Selection = { mode: 'create' } | { mode: 'view'; id: string } | null;

export function KeysClient() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const keysQuery = useQuery({
    queryKey: ['keys'],
    queryFn: () => apiFetch<{ keys: KeyRow[] }>('/api/keys').then((r) => r.keys),
  });
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [pending, startTransition] = useTransition();
  const [sel, setSel] = useState<Selection>(null);
  // Deep link: /settings/keys?selected=<id | service | label> preselects that
  // key on first load (one-shot; selection stays client-state after).
  const searchParams = useSearchParams();
  const deepLinkRef = useRef(searchParams.get('selected'));

  // Seed the optimistic local list from the query (re-seeds on invalidate) and
  // auto-select the deep-linked key (else the first) once loaded.
  useEffect(() => {
    if (!keysQuery.data) return;
    setKeys(keysQuery.data);
    const want = deepLinkRef.current?.trim();
    deepLinkRef.current = null;
    const hit = want
      ? keysQuery.data.find((k) => k.id === want || k.label === want || k.service === want)
      : undefined;
    setSel(
      (prev) =>
        prev ??
        (hit
          ? { mode: 'view', id: hit.id }
          : keysQuery.data[0]
            ? { mode: 'view', id: keysQuery.data[0].id }
            : { mode: 'create' }),
    );
  }, [keysQuery.data]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['keys'] });

  // Create form.
  const [service, setService] = useState('openrouter');
  const [customService, setCustomService] = useState('');
  const [label, setLabel] = useState('default');
  const [plaintext, setPlaintext] = useState('');

  // After a successful create or rotate, show the plaintext exactly once.
  const [revealed, setRevealed] = useState<{ key: string; service: string; label: string }>();

  // Rotate + delete flows.
  const [rotating, setRotating] = useState<KeyRow>();
  const [rotateValue, setRotateValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<KeyRow>();

  // Test-key flow, keyed by id.
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [testResults, setTestResults] = useState<Record<string, TestApiKeyResult>>({});

  const selectedKey = sel?.mode === 'view' ? (keys.find((k) => k.id === sel.id) ?? null) : null;

  async function onTest(row: KeyRow) {
    setTesting((s) => ({ ...s, [row.id]: true }));
    try {
      const result = await apiSend<TestApiKeyResult>('/api/keys/test', 'POST', {
        keyId: row.id,
        service: row.service,
      });
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
    if (!plaintext.trim()) {
      toast.error('Paste the key value.');
      return;
    }
    if (isCustom && !SERVICE_RE.test(effectiveService)) {
      toast.error('Enter a service name (lowercase letters, numbers, dashes).');
      return;
    }
    const finalLabel = label.trim() || 'default';
    try {
      await apiSend('/api/keys', 'POST', {
        service: effectiveService,
        label: finalLabel,
        plaintext,
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      toast.error(e instanceof Error ? e.message : 'Failed to save key.');
      return;
    }
    setRevealed({ key: plaintext, service: effectiveService, label: finalLabel });
    setPlaintext('');
    setLabel('default');
    setCustomService('');
    startTransition(() => {
      refresh();
    });
  }

  async function onRotate(e: React.FormEvent) {
    e.preventDefault();
    if (!rotating || !rotateValue.trim()) return;
    try {
      await apiSend(`/api/keys/${rotating.id}/rotate`, 'POST', { plaintext: rotateValue });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      toast.error(e instanceof Error ? e.message : 'Failed to rotate.');
      return;
    }
    setRevealed({ key: rotateValue, service: rotating.service, label: rotating.label });
    setRotating(undefined);
    setRotateValue('');
    startTransition(() => {
      refresh();
    });
  }

  async function confirmDelete() {
    const row = deleteTarget;
    if (!row) return;
    setDeleteTarget(undefined);
    try {
      await apiSend(`/api/keys/${row.id}`, 'DELETE');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      toast.error(e instanceof Error ? e.message : 'Failed to delete.');
      return;
    }
    toast.success(`Deleted ${row.service}/${row.label}`);
    if (sel?.mode === 'view' && sel.id === row.id) setSel({ mode: 'create' });
    setKeys((prev) => prev.filter((k) => k.id !== row.id));
    startTransition(() => {
      refresh();
    });
  }

  const isCustom = service === CUSTOM_SERVICE;
  const effectiveService = (isCustom ? customService : service).trim().toLowerCase();
  const provider = SUPPORTED_PROVIDERS.find((p) => p.id === service);

  if (keysQuery.isPending) {
    return (
      <div className="flex h-full items-center justify-center py-16">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="md:grid md:h-full md:grid-cols-[340px_1fr] md:overflow-hidden">
      {/* ── Left: key list ───────────────────────────────────────── */}
      <div className="flex flex-col border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between gap-2 border-b border-border p-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            API keys
          </h2>
          <Button type="button" size="sm" onClick={() => setSel({ mode: 'create' })}>
            <Plus /> New
          </Button>
        </div>
        <div className="space-y-2 p-3 md:flex-1 md:overflow-y-auto md:scrollbar-thin">
          {keys.length === 0 ? (
            <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
              No keys yet. Click <strong>New</strong> to add one.
            </p>
          ) : (
            keys.map((k) => {
              const selected = sel?.mode === 'view' && sel.id === k.id;
              return (
                <button
                  key={k.id}
                  type="button"
                  onClick={() => setSel({ mode: 'view', id: k.id })}
                  className={cn(
                    'block w-full rounded-lg border border-l-[3px] border-border border-l-border bg-card p-2.5 text-left transition-colors hover:bg-muted/50',
                    selected && 'border-l-primary',
                  )}
                >
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-sm font-medium">{k.service}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">/ {k.label}</span>
                  </div>
                  <code className="font-mono text-xs text-muted-foreground">{k.masked}</code>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* ── Right: create form OR key detail ─────────────────────── */}
      <div className="md:h-full md:min-h-0 md:overflow-y-auto md:scrollbar-thin">
        {sel?.mode === 'create' ? (
          <div className="space-y-4 p-6">
            <div>
              <h2 className="text-lg font-semibold">Add a new key</h2>
              <p className="text-xs text-muted-foreground">
                Stored as AES-256-GCM ciphertext. The plaintext is shown once after save, then never
                again.
              </p>
            </div>
            <form onSubmit={onCreate} className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="service">Provider</Label>
                  <select
                    id="service"
                    value={service}
                    onChange={(e) => setService(e.target.value)}
                    required
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  >
                    {SUPPORTED_PROVIDERS.map((p) => {
                      const { wired } = wiredCapabilitiesFor(p);
                      // Inline summary of what this provider's key can
                      // actually be used for. Empty wired list → the
                      // provider is catalogued but no adapter is
                      // registered (rare; means a planned integration
                      // hasn't landed). Partial list → operator sees
                      // upfront that this provider's chat/whatever
                      // isn't wired yet, even if the embedding is.
                      const suffix =
                        wired.length === 0 ? ' — not yet wired' : ` · ${wired.join(' · ')}`;
                      return (
                        <option key={p.id} value={p.id}>
                          {p.label}
                          {p.isAggregator ? ' (aggregator)' : ''}
                          {suffix}
                        </option>
                      );
                    })}
                    <option value={CUSTOM_SERVICE}>Custom / other API…</option>
                  </select>
                  {isCustom && (
                    <>
                      <Input
                        id="custom-service"
                        value={customService}
                        onChange={(e) => setCustomService(e.target.value.toLowerCase())}
                        placeholder="e.g. mapbox"
                        autoFocus
                        required
                      />
                      <p className="text-xs text-muted-foreground">
                        Service name for a non-LLM API your API-console tools call (lowercase
                        letters, numbers, dashes). Reference it in a tool as{' '}
                        <code>{`{{secret:${effectiveService || 'service'}/${label.trim() || 'default'}}}`}</code>
                        .
                      </p>
                    </>
                  )}
                  {provider &&
                    (() => {
                      const { wired, unwired } = wiredCapabilitiesFor(provider);
                      return (
                        <>
                          <p className="text-xs text-muted-foreground">
                            {provider.description}{' '}
                            <a
                              href={provider.signupUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="underline"
                            >
                              Get a key →
                            </a>
                          </p>
                          {wired.length > 0 && (
                            <p className="text-xs text-muted-foreground">
                              <span className="font-medium">Use for:</span> {wired.join(', ')}
                              {wired.length > 1 ? ' workers.' : ' workers.'}
                            </p>
                          )}
                          {unwired.length > 0 && (
                            <p className="text-xs text-amber-600 dark:text-amber-400">
                              <span className="font-medium">Also supports</span>{' '}
                              {unwired.join(', ')}, but Mantle doesn&apos;t dispatch through this
                              provider for {unwired.length > 1 ? 'those capabilities' : 'that'} yet
                              — a key still works for the wired capabilities above.
                            </p>
                          )}
                        </>
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
                    Disambiguates multiple keys for one service (e.g. <code>personal</code>,{' '}
                    <code>agent</code>).
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="plaintext">Key value</Label>
                <Input
                  id="plaintext"
                  type="text"
                  autoComplete="off"
                  value={plaintext}
                  onChange={(e) => setPlaintext(e.target.value)}
                  placeholder="sk-…"
                  required
                  autoFocus
                />
              </div>

              <div className="flex justify-end gap-2 border-t border-border pt-3">
                {keys.length > 0 && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setSel({ mode: 'view', id: keys[0]!.id })}
                  >
                    Cancel
                  </Button>
                )}
                <SubmitButton pending={pending}>Save key</SubmitButton>
              </div>
            </form>
          </div>
        ) : selectedKey ? (
          <KeyDetail
            row={selectedKey}
            testing={!!testing[selectedKey.id]}
            testResult={testResults[selectedKey.id]}
            onTest={() => onTest(selectedKey)}
            onRotate={() => {
              setRotating(selectedKey);
              setRotateValue('');
            }}
            onDelete={() => setDeleteTarget(selectedKey)}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-10 text-center text-sm text-muted-foreground">
            Select a key, or add a new one.
          </div>
        )}
      </div>

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
          <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 text-sm">
            {revealed?.key}
          </pre>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (revealed) copyText(revealed.key);
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
              Paste the new key value. The previous ciphertext is overwritten — there&apos;s no
              undo.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={onRotate} className="space-y-3">
            <Input
              type="text"
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

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deleteTarget?.service} / {deleteTarget?.label}?
            </AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
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

function KeyDetail({
  row,
  testing,
  testResult,
  onTest,
  onRotate,
  onDelete,
}: {
  row: KeyRow;
  testing: boolean;
  testResult: TestApiKeyResult | undefined;
  onTest: () => void;
  onRotate: () => void;
  onDelete: () => void;
}) {
  const provider = SUPPORTED_PROVIDERS.find((p) => p.id === row.service);
  return (
    <div className="space-y-4 p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold">
            {row.service} <span className="text-muted-foreground">/ {row.label}</span>
          </h2>
          <p className="text-xs text-muted-foreground">
            last used {formatDateTime(row.lastUsed)} · updated {formatDateTime(row.updatedAt)}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0 text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 /> Delete
        </Button>
      </div>

      <div className="space-y-1.5">
        <Label>Stored key</Label>
        <code className="block rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-sm">
          {row.masked}
        </code>
        <p className="text-xs text-muted-foreground">
          AES-256-GCM ciphertext — the plaintext is never shown again. Rotate to replace it.
        </p>
      </div>

      {provider && (
        <p className="text-sm text-muted-foreground">
          {provider.description}{' '}
          <a href={provider.signupUrl} target="_blank" rel="noreferrer" className="underline">
            Provider console →
          </a>
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={testing}
          onClick={onTest}
          title="Make a no-cost API call to verify this key is accepted"
        >
          {testing ? <Loader2 className="animate-spin" /> : <ShieldCheck />} Test
        </Button>
        <Button type="button" variant="outline" onClick={onRotate}>
          <RefreshCw /> Rotate
        </Button>
      </div>

      {testResult && (
        <div
          className={cn(
            'flex items-start gap-2 rounded-md px-3 py-2 text-sm',
            testResult.ok
              ? 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100'
              : 'bg-rose-50 text-rose-900 dark:bg-rose-950/40 dark:text-rose-100',
          )}
        >
          {testResult.ok ? (
            <Check className="size-4 shrink-0 translate-y-0.5" aria-hidden />
          ) : (
            <X className="size-4 shrink-0 translate-y-0.5" aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            <div className="font-medium">{testResult.message}</div>
            {testResult.adapter && (
              <div className="text-xs uppercase tracking-wide opacity-70">
                probed via {testResult.adapter}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
