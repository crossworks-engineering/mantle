'use client';

import { useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { Button } from '@mantle/web-ui/ui/button';
import { Switch } from '@mantle/web-ui/ui/switch';
import { Input } from '@mantle/web-ui/ui/input';
import { Label } from '@mantle/web-ui/ui/label';
import { FieldHint, hintId } from '@mantle/web-ui/ui/field-hint';
import { ModelSelect } from '@/components/ui/model-select';
import { cn } from '@mantle/web-ui/lib/utils';
import { isProviderWired, providersForCapability } from '@mantle/voice-client';
import type { ExplorerModel } from '@mantle/client-types';
import type { FormState } from './agents-client';

/** Built-in node types the extractor can be allow-listed against. Matches
 *  the `node_type` enum in packages/db/src/schema/nodes.ts minus `branch`
 *  (folders, never extracted). `secret` is included but uses metadata-only
 *  extraction — see `apps/agent/src/extractor.ts:readNodeBodyRaw`. */
const KNOWN_NODE_TYPES = [
  'note',
  'file',
  'email',
  'email_thread',
  'secret',
  'task',
  'event',
  'telegram_message',
] as const;
// `sermon`, `contact`, `printer_project` remain in the Postgres
// `node_type` enum but have no writer code. Hidden from the chip picker
// so the UI doesn't suggest types that produce no nodes. Re-add here
// (and a matching `case` in extractor.ts:readNodeBodyRaw) if a surface
// for one of them is ever built.

export const SELECT_CLASS =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
export const TEXTAREA_CLASS =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

type ApiKeyOption = { id: string; service: string; label: string; masked: string };

type SetFormState = React.Dispatch<React.SetStateAction<FormState>>;

/** The Memory tab's tuning fieldset — replay window, recall limits, and the
 *  role-specific extractor / summarizer knobs. */
export function MemorySection({ form, setForm }: { form: FormState; setForm: SetFormState }) {
  return (
    <fieldset className="space-y-3 rounded-md border border-border p-3">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Memory
      </legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="historyLimit">Turns to replay</Label>
          <Input
            id="historyLimit"
            type="number"
            value={form.historyLimit}
            onChange={(e) => setForm((f) => ({ ...f, historyLimit: e.target.value }))}
            min={0}
            step={1}
            aria-describedby={hintId('historyLimit')}
          />
          {form.role === 'summarizer' ? (
            <FieldHint id="historyLimit">Unused for summarizers — leave at 0.</FieldHint>
          ) : (
            <FieldHint id="historyLimit" warn="Every replayed turn is re-billed on each request.">
              How much of the recent conversation is re-sent with each new message. 20 is plenty.
            </FieldHint>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="historyWindowHours">Time window (hours)</Label>
          <Input
            id="historyWindowHours"
            type="number"
            value={form.historyWindowHours}
            onChange={(e) => setForm((f) => ({ ...f, historyWindowHours: e.target.value }))}
            placeholder="(none — count only)"
            min={0}
            step={0.5}
            aria-describedby={hintId('historyWindowHours')}
          />
          <FieldHint id="historyWindowHours">
            Also drop replayed turns older than this, so an idle chat starts fresh. Blank = go by
            count alone.
          </FieldHint>
        </div>
      </div>

      {(form.role === 'responder' || form.role === 'assistant') && (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="digestLimit">Digests</Label>
            <Input
              id="digestLimit"
              type="number"
              value={form.digestLimit}
              onChange={(e) => setForm((f) => ({ ...f, digestLimit: e.target.value }))}
              min={0}
              step={1}
              aria-describedby={hintId('digestLimit')}
            />
            <FieldHint id="digestLimit">
              Rollups of older conversation pulled in for background. Default 3.
            </FieldHint>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="factLimit">Facts</Label>
            <Input
              id="factLimit"
              type="number"
              value={form.factLimit}
              onChange={(e) => setForm((f) => ({ ...f, factLimit: e.target.value }))}
              min={0}
              step={1}
              aria-describedby={hintId('factLimit')}
            />
            <FieldHint id="factLimit" warn="Too many and the relevant ones get lost in the noise.">
              Extracted facts matched against the incoming message. Default 10.
            </FieldHint>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="contentHitLimit">Content hits</Label>
            <Input
              id="contentHitLimit"
              type="number"
              value={form.contentHitLimit}
              onChange={(e) => setForm((f) => ({ ...f, contentHitLimit: e.target.value }))}
              min={0}
              step={1}
              aria-describedby={hintId('contentHitLimit')}
            />
            <FieldHint id="contentHitLimit" warn="Each hit is a full passage — these add up fast.">
              Passages from your notes and files pulled in for the question. Default 3.
            </FieldHint>
          </div>
        </div>
      )}

      {form.role === 'extractor' && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Node types to process</Label>
            <NodeTypePicker
              value={form.extractTypes}
              onChange={(v) => setForm((f) => ({ ...f, extractTypes: v }))}
            />
            <FieldHint warn="Every extra type means another LLM pass on every matching node at ingest.">
              Click a chip to toggle. <strong>all types</strong> is a wildcard — matches every node
              type the extractor sees, so the specific chips become redundant when it&apos;s on. Add
              a custom type if you&apos;ve introduced a new node kind. <code>branch</code> and{' '}
              <code>secret</code> are HARD-SKIPPED regardless of this setting.
            </FieldHint>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.extractFacts}
              onChange={(e) => setForm((f) => ({ ...f, extractFacts: e.target.checked }))}
            />
            Extract facts (uncheck for content_index population only)
          </label>
          <div className="space-y-1.5">
            <Label htmlFor="extractCostCapCents">Cost cap per run (¢)</Label>
            <Input
              id="extractCostCapCents"
              type="number"
              step={0.1}
              min={0}
              value={form.extractCostCapCents}
              onChange={(e) => setForm((f) => ({ ...f, extractCostCapCents: e.target.value }))}
              placeholder="(none — unlimited)"
              aria-describedby={hintId('extractCostCapCents')}
            />
            <FieldHint
              id="extractCostCapCents"
              warn="Left blank there is no ceiling — a big import can run up a real bill."
            >
              Once trace cost crosses this, the fact-processing loop bails gracefully. Summary +
              entity reconciliation still run.
            </FieldHint>
          </div>
        </div>
      )}

      {form.role === 'summarizer' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="summarizeThreshold">Trigger threshold</Label>
            <Input
              id="summarizeThreshold"
              type="number"
              value={form.summarizeThreshold}
              onChange={(e) => setForm((f) => ({ ...f, summarizeThreshold: e.target.value }))}
              min={1}
              step={1}
              aria-describedby={hintId('summarizeThreshold')}
            />
            <FieldHint
              id="summarizeThreshold"
              warn="Set it low and the summarizer fires constantly."
            >
              Undigested turns per chat before summarization fires. Default 30.
            </FieldHint>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="summarizeBatch">Batch size</Label>
            <Input
              id="summarizeBatch"
              type="number"
              value={form.summarizeBatch}
              onChange={(e) => setForm((f) => ({ ...f, summarizeBatch: e.target.value }))}
              min={1}
              step={1}
              aria-describedby={hintId('summarizeBatch')}
            />
            <FieldHint
              id="summarizeBatch"
              warn="Fold in too many at once and the digest turns vague."
            >
              How many of the oldest turns to fold into one digest. Default 20.
            </FieldHint>
          </div>
        </div>
      )}
    </fieldset>
  );
}

/** ── Backup chat route (failover) ──────────────────────────────
 *  Unlike embeddings, a chat backup may be a DIFFERENT provider +
 *  model — there's no vector-space lock. When failover is on and
 *  the primary is unreachable (route-down / 429 / 5xx), the
 *  responder/assistant/heartbeat loop answers here (sticky for the
 *  rest of that turn). See docs/chat-failover.md. */
export function BackupRouteSection({
  form,
  setForm,
  apiKeys,
  tailnetPeers,
  catalog,
  catalogState,
}: {
  form: FormState;
  setForm: SetFormState;
  apiKeys: ApiKeyOption[];
  /** Online tailnet peer MagicDNS names — passed through to RouteHostFields. */
  tailnetPeers: string[];
  /** Backup-route model catalog (keyed on form.backupProvider; fetched by the parent). */
  catalog: ExplorerModel[];
  catalogState: { loading: boolean; error: string | null };
}) {
  // "Make backup primary" — exchange the primary↔backup form values. The
  // runtime always treats the primary columns as the active route, so this
  // pure value-swap is the whole switch (mirrors the embedding page + the
  // documented chat-failover design). Only meaningful when a backup exists.
  const swapPrimaryBackup = () =>
    setForm((f) => ({
      ...f,
      provider: f.backupProvider || 'openrouter',
      model: f.backupModel,
      apiKeyId: f.backupApiKeyId,
      baseUrl: f.backupBaseUrl,
      viaTailnet: f.backupViaTailnet,
      backupProvider: f.provider,
      backupModel: f.model,
      backupApiKeyId: f.apiKeyId,
      backupBaseUrl: f.baseUrl,
      backupViaTailnet: f.viaTailnet,
    }));

  return (
    <fieldset className="space-y-3 rounded-md border border-border p-3">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Backup route
      </legend>
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label htmlFor="backupEnabled" className="cursor-pointer">
            Enable failover
          </Label>
          <FieldHint id="backupEnabled">
            On a route-down / 429 / 5xx from the primary, fall over to a backup route. May be a
            different provider + model — that&apos;s what enables a local primary with a cloud
            safety net (or the reverse).
          </FieldHint>
        </div>
        <Switch
          id="backupEnabled"
          checked={form.backupEnabled}
          onCheckedChange={(v) => setForm((f) => ({ ...f, backupEnabled: v }))}
        />
      </div>

      {form.backupEnabled && (
        <>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              The <strong>primary</strong> above is always the active route. Swap to promote this
              backup.
            </p>
            <Button type="button" variant="outline" size="sm" onClick={swapPrimaryBackup}>
              <ArrowLeftRight />
              Make backup primary
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="backupProvider">Provider</Label>
              {(() => {
                const chatProviders = providersForCapability('chat');
                return (
                  <>
                    <select
                      id="backupProvider"
                      value={form.backupProvider}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          backupProvider: e.target.value,
                        }))
                      }
                      className={SELECT_CLASS}
                    >
                      {chatProviders.map((p) => {
                        const wired = isProviderWired(p.id, 'chat');
                        return (
                          <option key={p.id} value={p.id}>
                            {p.label}
                            {wired ? '' : ' · not yet wired'}
                          </option>
                        );
                      })}
                    </select>
                    <FieldHint id="backupProvider">
                      Who answers when the primary route is down.
                    </FieldHint>
                    {!isProviderWired(form.backupProvider, 'chat') && (
                      <p className="text-xs text-amber-600 dark:text-amber-400">
                        No chat adapter registered for <code>{form.backupProvider}</code> — failover
                        to it will fail until one ships.
                      </p>
                    )}
                  </>
                );
              })()}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="backupApiKey">API key</Label>
              {(() => {
                const eligibleBackupKeys = apiKeys.filter((k) => k.service === form.backupProvider);
                return (
                  <>
                    <select
                      id="backupApiKey"
                      value={form.backupApiKeyId}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          backupApiKeyId: e.target.value,
                        }))
                      }
                      className={SELECT_CLASS}
                    >
                      <option value="">
                        {form.backupProvider === 'local'
                          ? 'None (keyless / local)'
                          : '— select a key —'}
                      </option>
                      {eligibleBackupKeys.map((k) => (
                        <option key={k.id} value={k.id}>
                          {k.service} / {k.label} ({k.masked})
                        </option>
                      ))}
                    </select>
                    {apiKeys.length > 0 &&
                      eligibleBackupKeys.length === 0 &&
                      form.backupProvider !== 'local' && (
                        <p className="text-xs text-amber-600 dark:text-amber-400">
                          None of your saved keys are for <code>{form.backupProvider}</code>.
                        </p>
                      )}
                  </>
                );
              })()}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="backupModel">Model</Label>
            <ModelSelect
              id="backupModel"
              value={form.backupModel}
              onValueChange={(next) => setForm((f) => ({ ...f, backupModel: next }))}
              models={catalog}
              loading={catalogState.loading}
              error={catalogState.error}
              placeholder="— pick a model —"
              emptyMessage="No matching models in the catalog."
            />
            <FieldHint id="backupModel">
              Needn&apos;t match the primary — a cheaper or smaller model is fine here, since it
              only runs when the primary is down.
            </FieldHint>
          </div>
          {(form.backupProvider === 'local' || form.backupProvider === 'custom') && (
            <RouteHostFields
              idPrefix="backup"
              provider={form.backupProvider}
              baseUrl={form.backupBaseUrl}
              viaTailnet={form.backupViaTailnet}
              peers={tailnetPeers}
              onBaseUrl={(v) => setForm((f) => ({ ...f, backupBaseUrl: v }))}
              onViaTailnet={(v) => setForm((f) => ({ ...f, backupViaTailnet: v }))}
            />
          )}
        </>
      )}
    </fieldset>
  );
}

/** Per-route host controls for a `local` or `custom` chat route (migration
 *  0063). For `local`, `baseUrl` overrides the localhost default (point it at a
 *  LAN/tailnet box) and `viaTailnet` routes through the bundled Tailscale proxy.
 *  For `custom` (a cloud OpenAI-compatible endpoint) the Base URL is REQUIRED and
 *  there is no localhost default or tailnet routing — so the peer autocomplete
 *  and the Tailscale toggle are hidden. Rendered only for those two providers;
 *  every other provider has a fixed endpoint. */
export function RouteHostFields({
  idPrefix,
  provider,
  baseUrl,
  viaTailnet,
  peers = [],
  onBaseUrl,
  onViaTailnet,
}: {
  idPrefix: string;
  provider: 'local' | 'custom';
  baseUrl: string;
  viaTailnet: boolean;
  /** Online tailnet peer MagicDNS names — surfaced as base-URL autocomplete. */
  peers?: string[];
  onBaseUrl: (v: string) => void;
  onViaTailnet: (v: boolean) => void;
}) {
  const isCustom = provider === 'custom';
  const listId = `${idPrefix}-tailnet-peers`;
  return (
    <div className="space-y-3 rounded-md border border-dashed border-border p-3">
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}BaseUrl`}>
          Base URL{isCustom && <span className="text-muted-foreground"> (required)</span>}
        </Label>
        <Input
          id={`${idPrefix}BaseUrl`}
          value={baseUrl}
          onChange={(e) => onBaseUrl(e.target.value)}
          placeholder={
            isCustom
              ? 'https://api.your-provider.com/v1'
              : 'blank = http://localhost:11434/v1 (Ollama default)'
          }
          list={!isCustom && peers.length > 0 ? listId : undefined}
        />
        {!isCustom && peers.length > 0 && (
          // Suggest tailnet peers as `http://<name>:PORT/v1`. Free-text still
          // works; this is just autocomplete when a tailnet is up.
          <datalist id={listId}>
            {peers.map((p) => (
              <option key={p} value={`http://${p}:1234/v1`} />
            ))}
          </datalist>
        )}
        {isCustom ? (
          <p className="text-xs text-muted-foreground">
            The provider&apos;s OpenAI-compatible root — e.g.{' '}
            <code>https://api.z.ai/api/paas/v4</code> (Z.ai/GLM) or{' '}
            <code>https://api.deepinfra.com/v1/openai</code>. We append{' '}
            <code>/chat/completions</code>, so include any version segment.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Where this <code>local</code> route&apos;s server lives — e.g.{' '}
            <code>http://gemma-box:11434/v1</code> (Ollama) or{' '}
            <code>http://192.168.0.50:1234/v1</code> (LM Studio). Blank uses the{' '}
            <code>MANTLE_LOCAL_CHAT_URL</code> env / localhost default.
            {peers.length > 0 && ' Tailnet devices are suggested as you type.'}
          </p>
        )}
      </div>
      {!isCustom && (
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-0.5">
            <Label htmlFor={`${idPrefix}ViaTailnet`} className="cursor-pointer">
              Reach via Tailscale
            </Label>
            <p className="text-xs text-muted-foreground">
              Route this request through the bundled Tailscale proxy so the Base URL (a MagicDNS
              name) reaches a box behind NAT. Inert unless the <code>tailnet</code> compose profile
              is up.
            </p>
          </div>
          <Switch
            id={`${idPrefix}ViaTailnet`}
            checked={viaTailnet}
            onCheckedChange={onViaTailnet}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Chip multi-select for node types. The form state is still a
 * comma-separated string so the save path stays unchanged; this is
 * just a friendlier surface over it.
 */
function NodeTypePicker({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const selected = new Set(
    value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const [customDraft, setCustomDraft] = useState('');

  // Render known types first (in their fixed order), then any custom
  // values not already in the known set.
  const known = KNOWN_NODE_TYPES;
  const customs = Array.from(selected).filter(
    (t) => t !== '*' && !known.includes(t as (typeof KNOWN_NODE_TYPES)[number]),
  );

  const commit = (next: Set<string>) => {
    onChange(Array.from(next).join(','));
  };

  const toggle = (t: string) => {
    const next = new Set(selected);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    commit(next);
  };

  const addCustom = () => {
    const t = customDraft
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_');
    if (!t) return;
    const next = new Set(selected);
    next.add(t);
    commit(next);
    setCustomDraft('');
  };

  const wildcardOn = selected.has('*');

  // Chip styling: selection is marked by an ACCENT (primary border + a faint
  // accent tint), never a solid background fill. A saturated fill (the old
  // bg-primary / bg-emerald / bg-amber) drowns the chip label and any muted
  // text in many of the ~40 themes — the readability bug we're fixing. All
  // token-based (no hardcoded emerald/amber) so it tracks the active theme.
  const chipBase = 'rounded-full border px-2.5 py-0.5 text-xs transition';
  const chipOff =
    'border-input bg-background text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground';
  // On = a primary BORDER, no background fill — a saturated bg drowns the label
  // in many themes (content text is foreground, not accent-foreground).
  const chipOn = 'border-primary bg-background text-foreground';
  // Implicitly on because the wildcard covers it — same accent family, but
  // de-emphasized (dashed border, muted label) so an explicit pick still reads
  // distinctly from "covered by all types".
  const chipCovered = 'border-dashed border-primary/50 bg-background text-muted-foreground';

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {/* Wildcard chip: matches any non-HARD_SKIP type. When on, the
            specific chips below stay clickable (additive — clicking one
            just turns off the wildcard for clarity). */}
        <button
          type="button"
          onClick={() => toggle('*')}
          className={cn(chipBase, 'font-medium', wildcardOn ? chipOn : chipOff)}
          title="Wildcard — match every non-secret, non-branch node type"
        >
          all types
        </button>
        {known.map((t) => {
          const on = selected.has(t) || wildcardOn;
          return (
            <button
              key={t}
              type="button"
              onClick={() => toggle(t)}
              className={cn(
                chipBase,
                'font-mono',
                wildcardOn ? chipCovered : on ? chipOn : chipOff,
              )}
              title={wildcardOn ? 'covered by "all types"' : undefined}
            >
              {t}
            </button>
          );
        })}
        {customs
          .filter((t) => t !== '*')
          .map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => toggle(t)}
              className={cn(chipBase, 'font-mono', chipOn)}
              title="Custom type — click to remove"
            >
              {t} ✕
            </button>
          ))}
      </div>
      <div className="flex gap-1.5">
        <Input
          value={customDraft}
          onChange={(e) => setCustomDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addCustom();
            }
          }}
          placeholder="add custom type"
          className="h-7 text-xs"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addCustom}
          disabled={!customDraft.trim()}
        >
          Add
        </Button>
      </div>
    </div>
  );
}
