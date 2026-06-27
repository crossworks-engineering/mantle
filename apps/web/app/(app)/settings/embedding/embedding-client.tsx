'use client';

import { useState, useTransition } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, apiSend } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import { SubmitButton } from '@/components/ui/submit-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';

const SELECT_CLASS =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

/** Providers that can serve an embedding model. `local` is the privacy default
 *  (Ollama / LM Studio); the rest are cloud. A backup route is typically the
 *  SAME model on a second `local` host, or a cloud host serving the same model. */
const PROVIDERS = ['local', 'openrouter', 'openai', 'google', 'mistral', 'cohere'] as const;

type KeyOpt = { id: string; service: string; label: string; masked: string };

type ConfigDTO = {
  model: string;
  dimensions: number;
  primaryProvider: string;
  primaryBaseUrl: string | null;
  primaryApiKeyId: string | null;
  primaryLabel: string | null;
  backupEnabled: boolean;
  backupProvider: string | null;
  backupBaseUrl: string | null;
  backupApiKeyId: string | null;
  backupLabel: string | null;
  lastFailoverAt: string | null;
  extractionConcurrency: number | null;
  extractionTimeBudgetMinutes: number | null;
  localEmbedBatchSize: number | null;
  localEmbedRequestTimeoutMs: number | null;
};

/** Hardware-profile presets for the Performance section. Blank ('') = "use the
 *  default" (null in the DB → env → code default). */
const PERF_PRESETS: Record<
  'balanced' | 'small-cpu' | 'gpu',
  { concurrency: string; budget: string; batch: string; timeout: string }
> = {
  balanced: { concurrency: '', budget: '', batch: '', timeout: '' },
  'small-cpu': { concurrency: '1', budget: '', batch: '8', timeout: '' },
  gpu: { concurrency: '4', budget: '30', batch: '100', timeout: '60000' },
};

type ProbeResult = { dim: number } | { error: string };

type RouteState = {
  provider: string;
  baseUrl: string;
  apiKeyId: string;
  label: string;
};

type EmbeddingData = { config: ConfigDTO | null; columnDims: number; keys: KeyOpt[] };

/** Outer query-gate so the page stays data-free. The inner form mounts only
 *  once loaded, so its useState initializers seed from the saved config. */
export function EmbeddingClient() {
  const embeddingQuery = useQuery({
    queryKey: ['embedding'],
    queryFn: () => apiFetch<EmbeddingData>('/api/embedding'),
  });
  if (embeddingQuery.isPending) {
    return (
      <div className="flex h-full items-center justify-center py-16">
        <Spinner />
      </div>
    );
  }
  if (embeddingQuery.isError && !embeddingQuery.data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 py-16 text-sm text-muted-foreground">
        <p>Couldn&apos;t load the embedding config.</p>
        <Button variant="outline" size="sm" onClick={() => embeddingQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  const d = embeddingQuery.data;
  return <EmbeddingForm config={d.config} columnDims={d.columnDims} keys={d.keys} />;
}

function EmbeddingForm({
  config,
  columnDims,
  keys,
}: {
  config: ConfigDTO | null;
  columnDims: number;
  keys: KeyOpt[];
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [model, setModel] = useState(config?.model ?? 'embeddinggemma:latest');
  const [primary, setPrimary] = useState<RouteState>({
    provider: config?.primaryProvider ?? 'local',
    baseUrl: config?.primaryBaseUrl ?? '',
    apiKeyId: config?.primaryApiKeyId ?? '',
    label: config?.primaryLabel ?? 'Primary',
  });
  const [backupEnabled, setBackupEnabled] = useState(config?.backupEnabled ?? false);
  const [backup, setBackup] = useState<RouteState>({
    provider: config?.backupProvider ?? 'local',
    baseUrl: config?.backupBaseUrl ?? '',
    apiKeyId: config?.backupApiKeyId ?? '',
    label: config?.backupLabel ?? 'Backup',
  });

  const [probe, setProbe] = useState<{ primary?: ProbeResult; backup?: ProbeResult }>({});
  const [testing, setTesting] = useState<'primary' | 'backup' | null>(null);
  const [pending, startTransition] = useTransition();
  const [rebuilding, setRebuilding] = useState(false);

  // ── Performance & throughput (blank = use the default) ──
  const num = (n: number | null | undefined) => (n != null ? String(n) : '');
  const [perfConcurrency, setPerfConcurrency] = useState(num(config?.extractionConcurrency));
  const [perfBudget, setPerfBudget] = useState(num(config?.extractionTimeBudgetMinutes));
  const [perfBatch, setPerfBatch] = useState(num(config?.localEmbedBatchSize));
  const [perfTimeout, setPerfTimeout] = useState(num(config?.localEmbedRequestTimeoutMs));
  const currentPreset =
    (Object.keys(PERF_PRESETS) as (keyof typeof PERF_PRESETS)[]).find((name) => {
      const p = PERF_PRESETS[name];
      return (
        p.concurrency === perfConcurrency &&
        p.budget === perfBudget &&
        p.batch === perfBatch &&
        p.timeout === perfTimeout
      );
    }) ?? 'custom';
  function applyPreset(name: string) {
    const p = PERF_PRESETS[name as keyof typeof PERF_PRESETS];
    if (!p) return; // 'custom' → leave the fields as-is
    setPerfConcurrency(p.concurrency);
    setPerfBudget(p.budget);
    setPerfBatch(p.batch);
    setPerfTimeout(p.timeout);
  }

  async function testRoute(which: 'primary' | 'backup') {
    const r = which === 'primary' ? primary : backup;
    setTesting(which);
    try {
      const res = await apiSend<
        { ok: true; dimensions: number } | { ok: false; error: string }
      >('/api/embedding/test', 'POST', {
        provider: r.provider,
        model: model.trim(),
        baseUrl: r.baseUrl.trim() || null,
        apiKeyId: r.apiKeyId || null,
      });
      setProbe((p) => ({
        ...p,
        [which]: res.ok ? { dim: res.dimensions } : { error: res.error },
      }));
    } catch (err) {
      setProbe((p) => ({
        ...p,
        [which]: { error: err instanceof Error ? err.message : 'Probe failed' },
      }));
    } finally {
      setTesting(null);
    }
  }

  function runRebuild(repopulate: boolean) {
    setRebuilding(true);
    startTransition(async () => {
      try {
        const res = await apiSend<
          { ok: true; model: string } | { ok: false; error: string }
        >('/api/embedding/rebuild', 'POST', { repopulate });
        if (res.ok) toast.success(`Re-embed complete — model ${res.model}`);
        else toast.error(`Re-embed failed: ${res.error}`);
      } catch (err) {
        toast.error(`Re-embed failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setRebuilding(false);
      }
    });
  }

  function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.currentTarget));
    startTransition(async () => {
      try {
        const res = await apiSend<
          { ok: true; model: string } | { ok: false; error: string }
        >('/api/embedding', 'POST', body);
        if (res.ok) {
          toast.success(`Embedding config saved — ${res.model}`);
          queryClient.invalidateQueries({ queryKey: ['embedding'] });
        } else {
          toast.error(`Save failed: ${res.error}`);
        }
      } catch (err) {
        toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  const dimWarn = (r?: ProbeResult) =>
    r && 'dim' in r && r.dim !== columnDims
      ? `Returns ${r.dim} dims — does NOT fit the vector(${columnDims}) column. Pick a model/route that emits ${columnDims}, or migrate the schema.`
      : null;

  const failoverDate = config?.lastFailoverAt ? new Date(config.lastFailoverAt) : null;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-1">
      <header className="space-y-1">
        <p className="text-sm text-muted-foreground">
          The <strong>one</strong> place the brain&apos;s embedder is configured. Every
          embed — ingest, retrieval, recall, MCP search — resolves from here; agents
          and workers can&apos;t override it. The brain is{' '}
          <strong>vector-space-locked</strong>: there is a single model at{' '}
          <code className="font-mono">{columnDims}</code> dims, and the backup is the{' '}
          <strong>same model on a different route</strong> (for availability), never a
          different model.
        </p>
      </header>

      <form onSubmit={handleSave} className="space-y-6">
        {/* ── Model identity ─────────────────────────────────────────── */}
        <fieldset className="space-y-3 rounded-md border border-border p-4">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Model
          </legend>
          <div className="space-y-1.5">
            <Label htmlFor="model">Embedding model</Label>
            <Input
              id="model"
              name="model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="embeddinggemma:latest"
            />
            <p className="text-xs text-muted-foreground">
              The served model id (Ollama: <code>embeddinggemma:latest</code>). Both
              routes must serve <em>this</em> model. Column dimension:{' '}
              <code className="font-mono">vector({columnDims})</code> — changing to a
              model with a different native dim needs a schema migration + full
              re-embed (not a button).
            </p>
          </div>
          {failoverDate && (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              ⚠ Last failed over to the backup route on {failoverDate.toLocaleString()}.
            </p>
          )}
        </fieldset>

        {/* ── Primary route ──────────────────────────────────────────── */}
        <RouteFields
          title="Primary route"
          prefix="primary"
          state={primary}
          setState={setPrimary}
          keys={keys}
          columnDims={columnDims}
          probe={probe.primary}
          dimWarn={dimWarn(probe.primary)}
          testing={testing === 'primary'}
          onTest={() => testRoute('primary')}
        />

        {/* ── Backup route ───────────────────────────────────────────── */}
        <fieldset className="space-y-3 rounded-md border border-border p-4">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Backup route (same model)
          </legend>
          <div className="flex items-center justify-between">
            <Label htmlFor="backup_enabled" className="cursor-pointer">
              Enable failover
            </Label>
            <Switch
              id="backup_enabled"
              checked={backupEnabled}
              onCheckedChange={setBackupEnabled}
            />
          </div>
          <input type="hidden" name="backup_enabled" value={backupEnabled ? 'on' : 'off'} />
          <p className="text-xs text-muted-foreground">
            When the primary route is unreachable (connection refused / timeout / 5xx),
            embeds fail over here. Must serve the same model{' '}
            <code className="font-mono">{model || 'embeddinggemma:latest'}</code> — a
            different model lands vectors in a different space and silently breaks
            retrieval.
          </p>
          {backupEnabled && (
            <RouteFields
              title=""
              prefix="backup"
              state={backup}
              setState={setBackup}
              keys={keys}
              columnDims={columnDims}
              probe={probe.backup}
              dimWarn={dimWarn(probe.backup)}
              testing={testing === 'backup'}
              onTest={() => testRoute('backup')}
              bare
            />
          )}
        </fieldset>

        {/* ── Performance & throughput ──────────────────────────────── */}
        <fieldset className="space-y-3 rounded-md border border-border p-4">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Performance &amp; throughput
          </legend>
          <div className="space-y-1.5">
            <Label htmlFor="perf_preset">Hardware profile</Label>
            <select
              id="perf_preset"
              value={currentPreset}
              onChange={(e) => applyPreset(e.target.value)}
              className={SELECT_CLASS}
            >
              <option value="balanced">Balanced (default)</option>
              <option value="small-cpu">Small CPU VPS — no GPU</option>
              <option value="gpu">GPU / fast remote</option>
              <option value="custom" disabled={currentPreset !== 'custom'}>
                Custom
              </option>
            </select>
            <p className="text-xs text-muted-foreground">
              A one-click starting point — it just fills the fields below; tweak any of
              them and Save. A blank field uses the built-in default. On a small CPU-only
              VPS, pick <strong>Small CPU VPS</strong>.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="extraction_concurrency">Extraction concurrency</Label>
              <Input
                id="extraction_concurrency"
                name="extraction_concurrency"
                type="number"
                min="1"
                max="8"
                value={perfConcurrency}
                onChange={(e) => setPerfConcurrency(e.target.value)}
                placeholder="default 2"
              />
              <p className="text-xs text-muted-foreground">
                How many files index at once. Drop to <code>1</code> on a CPU-only box so
                jobs don&apos;t fight for the same cores.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="extraction_time_budget_minutes">Time budget (min)</Label>
              <Input
                id="extraction_time_budget_minutes"
                name="extraction_time_budget_minutes"
                type="number"
                min="1"
                max="720"
                value={perfBudget}
                onChange={(e) => setPerfBudget(e.target.value)}
                placeholder="default 60"
              />
              <p className="text-xs text-muted-foreground">
                How long one file may index before it&apos;s retried. Big documents on a
                slow embedder need the room.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="local_embed_batch_size">Local embed batch size</Label>
              <Input
                id="local_embed_batch_size"
                name="local_embed_batch_size"
                type="number"
                min="1"
                max="512"
                value={perfBatch}
                onChange={(e) => setPerfBatch(e.target.value)}
                placeholder="default 16"
              />
              <p className="text-xs text-muted-foreground">
                Texts per request to the local embedder. Smaller (<code>8</code>) clears
                the timeout on a slow vCPU; larger suits a GPU. Only affects the{' '}
                <code>local</code> provider.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="local_embed_request_timeout_ms">Local embed timeout (ms)</Label>
              <Input
                id="local_embed_request_timeout_ms"
                name="local_embed_request_timeout_ms"
                type="number"
                min="1000"
                max="600000"
                step="1000"
                value={perfTimeout}
                onChange={(e) => setPerfTimeout(e.target.value)}
                placeholder="default 120000"
              />
              <p className="text-xs text-muted-foreground">
                How long one local embed request may run before it&apos;s aborted. Raise on
                very slow hardware.
              </p>
            </div>
          </div>

          <p className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            ℹ Batch size and timeout apply immediately. Concurrency and the time budget are
            read when the extractor starts, so they take effect after the agent restarts.
          </p>
        </fieldset>

        <SubmitButton pending={pending}>Save embedding config</SubmitButton>
      </form>

      {/* ── Reindex tools ────────────────────────────────────────────── */}
      <fieldset className="space-y-3 rounded-md border border-border p-4">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Reindex
        </legend>
        <p className="text-xs text-muted-foreground">
          Re-embed the corpus against the saved model. Run after changing the model.
          While a re-embed is in flight, semantic search is degraded (mixed spaces) —
          do it in a quiet window. Idempotent under the embedding cache.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={rebuilding}
            onClick={() => runRebuild(false)}
          >
            {rebuilding ? 'Re-embedding…' : 'Rebuild index'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={rebuilding}
            onClick={() => runRebuild(true)}
          >
            Repopulate (include empty)
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          <strong>Repopulate</strong> also embeds rows whose vector is currently null —
          use it after a dimension migration that nulled the column. <strong>Rebuild</strong>{' '}
          refreshes already-embedded rows.
        </p>
      </fieldset>
    </div>
  );
}

function RouteFields({
  title,
  prefix,
  state,
  setState,
  keys,
  columnDims,
  probe,
  dimWarn,
  testing,
  onTest,
  bare,
}: {
  title: string;
  prefix: 'primary' | 'backup';
  state: RouteState;
  setState: (updater: (s: RouteState) => RouteState) => void;
  keys: KeyOpt[];
  columnDims: number;
  probe?: ProbeResult;
  dimWarn: string | null;
  testing: boolean;
  onTest: () => void;
  bare?: boolean;
}) {
  const body = (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${prefix}_provider`}>Provider</Label>
          <select
            id={`${prefix}_provider`}
            name={`${prefix}_provider`}
            value={state.provider}
            onChange={(e) => setState((s) => ({ ...s, provider: e.target.value }))}
            className={SELECT_CLASS}
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
                {p === 'local' ? ' (self-hosted · keyless)' : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${prefix}_label`}>Label</Label>
          <Input
            id={`${prefix}_label`}
            name={`${prefix}_label`}
            value={state.label}
            onChange={(e) => setState((s) => ({ ...s, label: e.target.value }))}
            placeholder={prefix === 'primary' ? 'Mac Ollama' : 'LAN box'}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${prefix}_base_url`}>Base URL</Label>
        <Input
          id={`${prefix}_base_url`}
          name={`${prefix}_base_url`}
          value={state.baseUrl}
          onChange={(e) => setState((s) => ({ ...s, baseUrl: e.target.value }))}
          placeholder="blank = provider default (local → http://localhost:11434/v1)"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${prefix}_api_key_id`}>API key</Label>
        <select
          id={`${prefix}_api_key_id`}
          name={`${prefix}_api_key_id`}
          value={state.apiKeyId}
          onChange={(e) => setState((s) => ({ ...s, apiKeyId: e.target.value }))}
          className={SELECT_CLASS}
        >
          <option value="">None (keyless / local)</option>
          {keys.map((k) => (
            <option key={k.id} value={k.id}>
              {k.service} · {k.label} ({k.masked})
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" disabled={testing} onClick={onTest}>
          {testing ? 'Testing…' : 'Test dimensions'}
        </Button>
        {probe && 'dim' in probe && !dimWarn && (
          <span className="text-sm text-emerald-600 dark:text-emerald-500">
            ✓ {probe.dim} dims — fits vector({columnDims})
          </span>
        )}
        {probe && 'error' in probe && (
          <span className="text-sm text-destructive">✗ {probe.error}</span>
        )}
      </div>
      {dimWarn && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {dimWarn}
        </p>
      )}
    </>
  );

  if (bare) return <div className="space-y-3 border-t border-border pt-3">{body}</div>;
  return (
    <fieldset className="space-y-3 rounded-md border border-border p-4">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </legend>
      {body}
    </fieldset>
  );
}
