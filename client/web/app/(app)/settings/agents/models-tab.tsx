'use client';

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, Pencil, X } from 'lucide-react';
import { Button } from '@mantle/web-ui/ui/button';
import { Label } from '@mantle/web-ui/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@mantle/web-ui/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@mantle/web-ui/ui/table';
import { SubmitButton } from '@mantle/web-ui/ui/submit-button';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { useToast } from '@mantle/web-ui/ui/toast';
import { cn } from '@mantle/web-ui/lib/utils';
import { apiFetch, apiSend } from '@mantle/web-ui/api-fetch';
import { ModelSelect } from '@/components/ui/model-select';
import { BoringAvatar } from '@/components/boring-avatar';
import { agentAccent, agentInitials } from '@/lib/agent-color';
import { getProvider, isProviderWired, providersForCapability } from '@mantle/voice/client';
import type { ExplorerModel } from '@server/lib/model-explorer';
import type { AgentDTO } from '@mantle/client-types';

/** The primary chat route — the ONLY thing this tab reads or writes. Backup
 *  routes, params, prompts, grants and TTS pins stay the agent form's job. */
type Triple = { provider: string; model: string; apiKeyId: string | null };

type StagedChange = { prev: Triple; next: Triple };

type ApiKeyOption = { id: string; service: string; label: string; masked: string };

function tripleOf(a: AgentDTO): Triple {
  return { provider: a.provider, model: a.model, apiKeyId: a.apiKeyId ?? null };
}

function sameTriple(a: Triple, b: Triple): boolean {
  return a.provider === b.provider && a.model === b.model && a.apiKeyId === b.apiKeyId;
}

/**
 * Models tab — the model matrix of every agent, with STAGED bulk switching.
 *
 * Picking a provider/model/key set stages the change in memory (nothing
 * saved); staged rows render before → after with a per-row unstage. "Apply
 * all" PATCHes each agent SEQUENTIALLY so a failure attributes to its row
 * (kept staged, API error inline) instead of vanishing into a Promise.all.
 * The staged map is deliberately memory-only — leaving the tab discards it,
 * and the footer says so instead of a beforeunload nag.
 */
export function ModelsTab({ agents, apiKeys }: { agents: AgentDTO[]; apiKeys: ApiKeyOption[] }) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const [staged, setStaged] = useState<Map<string, StagedChange>>(new Map());
  /** Most recent picker choice — powers the one-click "→ model" quick-apply
   *  on every other row (single most-recent, not a history). */
  const [lastSelected, setLastSelected] = useState<Triple | null>(null);
  const [pickerFor, setPickerFor] = useState<AgentDTO | null>(null);
  const [applying, setApplying] = useState(false);
  /** Row currently being PATCHed (apply is sequential, so one at a time). */
  const [savingId, setSavingId] = useState<string | null>(null);
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());

  const keysById = useMemo(() => new Map(apiKeys.map((k) => [k.id, k])), [apiKeys]);

  const stage = (agent: AgentDTO, next: Triple) => {
    const prev = tripleOf(agent);
    setErrors((m) => {
      if (!m.has(agent.id)) return m;
      const copy = new Map(m);
      copy.delete(agent.id);
      return copy;
    });
    setApplied((s) => {
      if (!s.has(agent.id)) return s;
      const copy = new Set(s);
      copy.delete(agent.id);
      return copy;
    });
    setStaged((m) => {
      const copy = new Map(m);
      if (sameTriple(prev, next)) copy.delete(agent.id);
      else copy.set(agent.id, { prev, next });
      return copy;
    });
    setLastSelected(next);
  };

  const unstage = (agentId: string) => {
    setStaged((m) => {
      const copy = new Map(m);
      copy.delete(agentId);
      return copy;
    });
    setErrors((m) => {
      const copy = new Map(m);
      copy.delete(agentId);
      return copy;
    });
  };

  const discardAll = () => {
    setStaged(new Map());
    setErrors(new Map());
  };

  const applyAll = async () => {
    setApplying(true);
    setApplied(new Set());
    let ok = 0;
    let failed = 0;
    // Sequential on purpose: per-row errors attribute cleanly and we don't
    // hammer the API with N concurrent PATCHes.
    for (const [id, change] of [...staged.entries()]) {
      setSavingId(id);
      try {
        await apiSend(`/api/agents/${id}`, 'PATCH', {
          provider: change.next.provider,
          model: change.next.model,
          apiKeyId: change.next.apiKeyId,
        });
        ok++;
        setStaged((m) => {
          const copy = new Map(m);
          copy.delete(id);
          return copy;
        });
        setErrors((m) => {
          const copy = new Map(m);
          copy.delete(id);
          return copy;
        });
        setApplied((s) => new Set(s).add(id));
      } catch (err) {
        failed++;
        // Keep the staged entry so the operator can retry or fix and re-apply.
        setErrors((m) => new Map(m).set(id, err instanceof Error ? err.message : 'Save failed.'));
      }
    }
    setSavingId(null);
    setApplying(false);
    if (failed === 0) toast.success(`Applied ${ok} model change${ok === 1 ? '' : 's'}`);
    else toast.error(`${ok} applied, ${failed} failed — failed rows stay staged`);
    // Both tabs read the same query; refetch so the matrix and the editor agree.
    await queryClient.invalidateQueries({ queryKey: ['agents'] });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>API key</TableHead>
              <TableHead className="w-0 text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {agents.map((agent) => {
              const change = staged.get(agent.id) ?? null;
              const current = tripleOf(agent);
              const error = errors.get(agent.id);
              const showQuickApply =
                lastSelected !== null &&
                !applying &&
                !sameTriple(current, lastSelected) &&
                (!change || !sameTriple(change.next, lastSelected));
              return (
                <TableRow key={agent.id} className={cn(!agent.enabled && 'opacity-60')}>
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      {agent.avatar ? (
                        <BoringAvatar
                          variant={agent.avatar.style}
                          seed={agent.avatar.seed}
                          size={28}
                        />
                      ) : (
                        <span
                          className="flex size-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
                          style={{ backgroundColor: agentAccent(agent.slug).solid }}
                          aria-hidden
                        >
                          {agentInitials(agent.name)}
                        </span>
                      )}
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-medium">{agent.name}</span>
                          {!agent.enabled && (
                            <span className="shrink-0 rounded-sm bg-muted px-1 text-[9px] uppercase tracking-wider text-muted-foreground">
                              off
                            </span>
                          )}
                        </div>
                        <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                          {agent.role}
                        </span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <BeforeAfter
                      before={getProvider(current.provider)?.label ?? current.provider}
                      after={
                        change && change.next.provider !== current.provider
                          ? (getProvider(change.next.provider)?.label ?? change.next.provider)
                          : null
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <BeforeAfter
                      mono
                      before={current.model}
                      after={
                        change && change.next.model !== current.model ? change.next.model : null
                      }
                    />
                    {error && <p className="mt-1 text-xs text-destructive-ink">{error}</p>}
                  </TableCell>
                  <TableCell>
                    <BeforeAfter
                      before={keyLabel(keysById, current.apiKeyId)}
                      after={
                        change && change.next.apiKeyId !== current.apiKeyId
                          ? keyLabel(keysById, change.next.apiKeyId)
                          : null
                      }
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      {savingId === agent.id ? (
                        <Spinner size={16} />
                      ) : applied.has(agent.id) ? (
                        <Check className="size-4 text-success-ink" aria-label="Applied" />
                      ) : null}
                      {showQuickApply && lastSelected && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="max-w-56 text-muted-foreground"
                          title={`Stage ${lastSelected.provider} / ${lastSelected.model}`}
                          onClick={() => stage(agent, lastSelected)}
                        >
                          <ArrowRight />
                          <span className="truncate font-mono text-xs">{lastSelected.model}</span>
                        </Button>
                      )}
                      {change && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={applying}
                          title="Un-stage this change"
                          onClick={() => unstage(agent.id)}
                        >
                          <X />
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={applying}
                        onClick={() => setPickerFor(agent)}
                      >
                        <Pencil /> Change
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Sticky apply bar — the staged diff above IS the confirmation surface,
          so no AlertDialog on Apply. */}
      {staged.size > 0 && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border bg-background px-4 py-3">
          <div className="text-sm">
            <span className="font-medium">
              {staged.size} change{staged.size === 1 ? '' : 's'} staged
            </span>
            <span className="ml-2 text-xs text-muted-foreground">
              Staged changes are not saved until you Apply.
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={applying}
              onClick={discardAll}
            >
              Discard all
            </Button>
            <SubmitButton pending={applying} onClick={applyAll} type="button">
              Apply all
            </SubmitButton>
          </div>
        </div>
      )}

      {pickerFor && (
        <ModelSetPicker
          agent={pickerFor}
          initial={staged.get(pickerFor.id)?.next ?? tripleOf(pickerFor)}
          apiKeys={apiKeys}
          onStage={(next) => {
            stage(pickerFor, next);
            setPickerFor(null);
          }}
          onClose={() => setPickerFor(null)}
        />
      )}
    </div>
  );
}

function keyLabel(keysById: Map<string, ApiKeyOption>, id: string | null): string {
  if (!id) return '—';
  const k = keysById.get(id);
  return k ? `${k.label} (${k.masked})` : 'unknown key';
}

/** Old value struck through beside the highlighted new one; plain value when
 *  nothing is staged for this cell. */
function BeforeAfter({
  before,
  after,
  mono = false,
}: {
  before: string;
  after: string | null;
  mono?: boolean;
}) {
  const base = cn('text-sm', mono && 'font-mono text-xs');
  if (after === null) return <span className={base}>{before}</span>;
  return (
    <span className="flex flex-wrap items-center gap-x-1.5">
      <span className={cn(base, 'text-muted-foreground line-through')}>{before}</span>
      <ArrowRight className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      <span className={cn(base, 'font-medium')}>{after}</span>
    </span>
  );
}

/**
 * Compact provider → model → key picker — the same catalog + coherence rules
 * as the agent form: models come from `/api/models?provider=…`, keys filter to
 * the selected provider's service, unwired providers warn.
 */
function ModelSetPicker({
  agent,
  initial,
  apiKeys,
  onStage,
  onClose,
}: {
  agent: AgentDTO;
  initial: Triple;
  apiKeys: ApiKeyOption[];
  onStage: (next: Triple) => void;
  onClose: () => void;
}) {
  const [provider, setProvider] = useState(initial.provider || 'openrouter');
  const [model, setModel] = useState(initial.model);
  const [apiKeyId, setApiKeyId] = useState(initial.apiKeyId ?? '');

  const chatProviders = providersForCapability('chat');
  const eligibleKeys = apiKeys.filter((k) => k.service === provider);

  const catalogQuery = useQuery({
    queryKey: ['models', provider],
    queryFn: () =>
      apiFetch<{ models?: ExplorerModel[]; error?: string }>(
        `/api/models?provider=${encodeURIComponent(provider)}`,
      ),
    staleTime: 5 * 60_000,
  });
  const catalog = catalogQuery.data?.models ?? [];

  const onProviderChange = (next: string) => {
    setProvider(next);
    // A key belongs to ONE provider — drop a now-incoherent selection so the
    // required select forces a valid pick (same rule the agent form enforces
    // via its filtered dropdown).
    setApiKeyId((id) => {
      const k = apiKeys.find((x) => x.id === id);
      return k && k.service === next ? id : '';
    });
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!model.trim()) return;
    onStage({
      provider: provider.trim() || 'openrouter',
      model: model.trim(),
      apiKeyId: apiKeyId || null,
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Change model — {agent.name}</DialogTitle>
          <DialogDescription>
            Stages the primary chat route (provider, model, API key). Nothing is saved until you
            Apply all.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="picker-provider">Provider</Label>
            <select
              id="picker-provider"
              value={provider}
              onChange={(e) => onProviderChange(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              required
            >
              {chatProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {isProviderWired(p.id, 'chat') ? '' : ' · not yet wired'}
                </option>
              ))}
            </select>
            {!isProviderWired(provider, 'chat') && (
              <p className="text-xs text-warning-ink">
                No chat adapter registered for <code>{provider}</code> — the agent will fail at
                first turn until one ships.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="picker-model">Model</Label>
            <ModelSelect
              id="picker-model"
              value={model}
              onValueChange={setModel}
              models={catalog}
              loading={catalogQuery.isPending}
              error={
                catalogQuery.isError
                  ? catalogQuery.error instanceof Error
                    ? catalogQuery.error.message
                    : 'Catalog fetch failed'
                  : (catalogQuery.data?.error ?? null)
              }
              placeholder="— pick a model —"
              emptyMessage="No matching models in the catalog."
              required
            />
            {!catalogQuery.isPending && model.trim() && !catalog.some((m) => m.id === model) && (
              <p className="text-xs text-warning-ink">
                <code>{model}</code> isn&apos;t in <code>{provider}</code>&apos;s catalog — direct
                providers use bare ids (<code>claude-haiku-4-5</code>) where OpenRouter uses
                prefixed slugs (<code>anthropic/claude-haiku-4.5</code>).
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="picker-key">API key</Label>
            <select
              id="picker-key"
              value={apiKeyId}
              onChange={(e) => setApiKeyId(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              required
            >
              <option value="">— select a key —</option>
              {eligibleKeys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.service} / {k.label} ({k.masked})
                </option>
              ))}
            </select>
            {apiKeys.length > 0 && eligibleKeys.length === 0 && (
              <p className="text-xs text-warning-ink">
                None of your saved keys are for <code>{provider}</code>. Add one at{' '}
                <a href="/settings/keys" className="underline">
                  /settings/keys
                </a>{' '}
                or pick a different provider.
              </p>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <SubmitButton>Stage change</SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
