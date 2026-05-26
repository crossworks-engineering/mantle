'use client';

/**
 * Shared form for creating and editing ai_workers. Renders the right
 * field set based on `kind`. The submit handler delegates to the
 * passed-in action — the wrapper page provides either create or update.
 *
 * Why a single component for both create/edit: the field set is the
 * same; the only difference is whether `id` exists. Splitting into two
 * components would mean two parallel field renderers to maintain.
 */

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import type { AiWorker, AiWorkerKind } from '@mantle/db';
import {
  ANTHROPIC_CHAT_MODELS,
  ANTHROPIC_VISION_MODELS,
  ASSEMBLYAI_STT_MODELS,
  CAPABILITY_FOR_KIND,
  DEEPGRAM_STT_MODELS,
  ELEVENLABS_STT_MODELS,
  GOOGLE_CHAT_MODELS,
  GOOGLE_IMAGE_MODELS,
  GOOGLE_STT_MODELS,
  GOOGLE_VISION_MODELS,
  HUGGINGFACE_CHAT_MODELS,
  HUGGINGFACE_IMAGE_MODELS,
  HUGGINGFACE_ROUTING_POLICIES,
  OPENAI_IMAGE_MODELS,
  OPENAI_STT_MODELS,
  OPENAI_TTS_MODELS,
  OPENAI_VISION_MODELS,
  VOICE_DESCRIPTIONS,
  XAI_CHAT_MODELS,
  XAI_IMAGE_MODELS,
  XAI_STT_MODELS,
  XAI_VISION_MODELS,
  audioTagsForElevenLabsModel,
  audioTagsForGoogleTtsModel,
  audioTagsForXaiTtsModel,
  wrappingTagsForXaiTtsModel,
  isProviderWired,
  providersForCapability,
  voicesForModel,
  type AudioTag,
  type WrappingTag,
  type ChatModelInfo,
  type ImageGenModelInfo,
  type OpenAiVoice,
  type ProviderCapability,
  type SttModelInfo,
  type TtsModelInfo,
  type VisionModelInfo,
} from '@mantle/voice';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ModelSelect } from '@/components/ui/model-select';
import { useToast } from '@/components/ui/toast';
import type { ExplorerModel } from '@/lib/model-explorer';
import { discoverModelsAction, listVoicesAction } from './actions';
import { TtsTestButton } from './tts-test-button';
import { SttTestButton } from './stt-test-button';
import { ChatTestButton } from './chat-test-button';
import { VisionTestButton } from './vision-test-button';
import { ImageGenTestButton } from './image-gen-test-button';

type KeyOption = { id: string; service: string; label: string; masked: string };

type Props = {
  mode: 'create' | 'edit';
  kind: AiWorkerKind;
  worker?: AiWorker;
  keys: KeyOption[];
  action: (formData: FormData) => Promise<void>;
  /** Controlled by the parent (rendered as header switches). Injected into
   *  the submitted FormData so the server actions stay unchanged. */
  enabled: boolean;
  isDefault: boolean;
};

/** Default provider per kind. The dropdown is populated from the
 *  canonical SUPPORTED_PROVIDERS catalog filtered to providers that
 *  declare the capability needed by the worker kind. */
const PROVIDER_FOR_KIND: Record<AiWorkerKind, string> = {
  reflector: 'openrouter',
  extractor: 'openrouter',
  summarizer: 'openrouter',
  tts: 'openai',
  stt: 'openai',
  vision: 'openrouter',
  image_gen: 'openai',
  // Embeddings always route through OpenRouter today — see
  // `@mantle/embeddings`. Provider stays locked to it on the form.
  embedding: 'openrouter',
};

/** Suggested model per kind, used as the placeholder. */
/** Map workers' provider id to the OpenRouter slug prefix for pricing
 *  lookup. Two provider ids in SUPPORTED_PROVIDERS don't match OpenRouter's
 *  prefix verbatim:
 *    - `xai` → `x-ai` (the operator-facing label vs OR's published prefix)
 *    - `mistral` → `mistralai` (OR uses the full company name as prefix)
 *  Everything else matches directly. `openrouter` is its own prefix (the
 *  model id already includes the upstream like `anthropic/claude-…`).
 *  Providers OpenRouter doesn't carry at all (Deepgram, AssemblyAI,
 *  ElevenLabs) silently miss the fallback — fine, those are audio anyway
 *  and OR doesn't have pricing for them either way. */
function openrouterPrefixFor(provider: string): string {
  if (provider === 'xai') return 'x-ai';
  if (provider === 'mistral') return 'mistralai';
  return provider;
}

/** Build the OpenRouter-style lookup key for a worker's (provider, model).
 *  For OpenRouter the id already carries the prefix; for direct providers
 *  we prepend the slug-mapped prefix. Lower-cased so it matches the cache
 *  key shape. */
function openrouterSlugFor(provider: string, modelId: string): string {
  if (provider === 'openrouter') return modelId.toLowerCase();
  return `${openrouterPrefixFor(provider)}/${modelId}`.toLowerCase();
}

/** Convert the discovery result (a union of TtsModelInfo / SttModelInfo /
 *  ChatModelInfo / VisionModelInfo / ImageGenModelInfo) into the
 *  ExplorerModel shape ModelSelect renders. Pricing comes from the
 *  adapter's own fields when present (ChatModelInfo / VisionModelInfo);
 *  otherwise we fall back to OpenRouter's cached pricing via the
 *  slug-mapped lookup — that's how direct providers (Anthropic, OpenAI,
 *  xAI) whose `/v1/models` returns bare ids get pricing badges anyway. */
function toExplorerModels(
  available: ReadonlyArray<
    TtsModelInfo | SttModelInfo | ChatModelInfo | VisionModelInfo | ImageGenModelInfo
  >,
  provider: string,
  orPricing: Record<string, { inputPricePerM?: number; outputPricePerM?: number }>,
): ExplorerModel[] {
  return available.map((m) => {
    const wider = m as {
      inputPricePer1M?: number;
      outputPricePer1M?: number;
      contextTokens?: number;
      // ChatModelInfo carries this — 'vision' / 'reasoning' / 'function_calling'
      // / 'json_mode'. We fold it into the modality string so cmdk's
      // fuzzy search picks up a query like "vision" against direct-provider
      // chat models (which otherwise have no modality field).
      capabilities?: readonly string[];
    };
    const orKey = openrouterSlugFor(provider, m.id);
    const orHit = orPricing[orKey];
    const modality = wider.capabilities?.length
      ? wider.capabilities.join(' · ')
      : undefined;
    return {
      id: m.id,
      name: m.label,
      description: m.description,
      contextTokens: wider.contextTokens,
      inputPricePerM: wider.inputPricePer1M ?? orHit?.inputPricePerM,
      outputPricePerM: wider.outputPricePer1M ?? orHit?.outputPricePerM,
      modality,
      raw: m,
    };
  });
}

const MODEL_HINT_FOR_KIND: Record<AiWorkerKind, string> = {
  reflector: 'anthropic/claude-haiku-4.5',
  extractor: 'anthropic/claude-haiku-4.5',
  summarizer: 'anthropic/claude-haiku-4.5',
  // gpt-4o-mini-tts (May 2026) is the recommended default — 13 voices,
  // supports style instructions. The legacy tts-1 / tts-1-hd are still
  // available for cheaper or higher-fidelity fallback.
  tts: 'gpt-4o-mini-tts',
  stt: 'whisper-1',
  vision: 'openai/gpt-4o',
  image_gen: 'dall-e-3',
  // 1536-dim, cheap, the brain's existing column shape. Anything else
  // either matches dims (Gemini-embedding-2-preview, Nemotron) or
  // requires a re-embed pass — the form's dim guard will warn.
  embedding: 'openai/text-embedding-3-small',
};

export function WorkerForm({ mode, kind, worker, keys, action, enabled, isDefault }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const params = (worker?.params ?? {}) as Record<string, unknown>;

  // Identity state — lifted out of uncontrolled defaults so the
  // model dropdown can react to api-key changes and so the voice
  // dropdown can react to model changes. Without controlled inputs
  // for these, switching keys wouldn't trigger re-discovery.
  const [apiKeyId, setApiKeyId] = useState<string>(worker?.apiKeyId ?? '');
  const [model, setModel] = useState<string>(worker?.model ?? '');
  const [provider, setProvider] = useState<string>(
    worker?.provider ?? PROVIDER_FOR_KIND[kind],
  );

  // Filtered provider list — only providers that support this worker's
  // kind appear in the dropdown. Adding a new provider is a one-line
  // change to SUPPORTED_PROVIDERS in @mantle/voice; the UI picks it
  // up automatically. The `!` is safe: every AiWorkerKind has an
  // entry in CAPABILITY_FOR_KIND (proven by providers.test.ts).
  const capability = CAPABILITY_FOR_KIND[kind]!;
  const eligibleProviders = providersForCapability(capability);
  const selectedProvider = eligibleProviders.find((p) => p.id === provider);

  // Reactive model catalogue. For tts/stt/chat-shaped kinds we hit
  // the adapter's discoverModels when the api_key is selected; for
  // anything else we fall back to free-text input.
  //
  // "Chat-shaped" = reflector/extractor/summarizer (they make chat
  // completion calls). For those, we offer discovery only when the
  // worker's provider is one we have a chat adapter for — currently
  // xAI and Hugging Face. OpenRouter chat doesn't go through this
  // registry; the user types model ids by hand for OpenRouter.
  const chatShaped = kind === 'reflector' || kind === 'extractor' || kind === 'summarizer';
  // Which chat providers have an adapter today. Keep this list as
  // the single source of truth for "show a model dropdown" — any
  // provider not listed here gets a free-text model input instead.
  const wiredChatProviders = new Set(['xai', 'huggingface', 'anthropic', 'google']);
  // Which vision providers have an adapter today. Mirrors the chat
  // wiredChatProviders set — keeps "show a model dropdown" honest.
  const wiredVisionProviders = new Set(['openai', 'anthropic', 'google', 'xai']);
  // Image-gen wiring as of this commit. HF is a real adapter but
  // surfaces a "type any repo id" free-text path too.
  const wiredImageGenProviders = new Set(['openai', 'xai', 'google', 'huggingface']);
  const supportsDiscovery =
    kind === 'tts' ||
    kind === 'stt' ||
    (kind === 'vision' && wiredVisionProviders.has(provider)) ||
    (kind === 'image_gen' && wiredImageGenProviders.has(provider)) ||
    (chatShaped && wiredChatProviders.has(provider)) ||
    // Embedding routes through OpenRouter's keyless
    // `/api/v1/embeddings/models` catalog. No adapter dispatcher needed
    // (yet — single backing service); the action handles the fetch.
    kind === 'embedding';

  // The initial model list rendered before live discovery returns
  // depends on which provider+kind we're configuring. Picking the
  // right static fallback per (kind, provider) means the dropdown
  // is never empty in create mode.
  // Static-catalog fallback per (kind, provider). Used to seed the
  // dropdown at mount AND whenever the user changes provider before
  // picking an API key (so the model list stays plausible). Once an
  // api key is selected we replace this with live discovery.
  const staticCatalogFor = (
    forKind: AiWorkerKind,
    forProvider: string,
  ): Array<
    TtsModelInfo | SttModelInfo | ChatModelInfo | VisionModelInfo | ImageGenModelInfo
  > => {
    if (forKind === 'tts') return [...OPENAI_TTS_MODELS];
    if (forKind === 'stt') {
      // Each STT provider ships its own model list. Falls back to
      // OpenAI's list for providers without a wired adapter (Hugging
      // Face today — model id is free-text on the Hub).
      if (forProvider === 'xai') return [...XAI_STT_MODELS];
      if (forProvider === 'elevenlabs') return [...ELEVENLABS_STT_MODELS];
      if (forProvider === 'deepgram') return [...DEEPGRAM_STT_MODELS];
      if (forProvider === 'assemblyai') return [...ASSEMBLYAI_STT_MODELS];
      if (forProvider === 'google') return [...GOOGLE_STT_MODELS];
      return [...OPENAI_STT_MODELS];
    }
    if (forKind === 'vision') {
      // 4 wired vision providers; everyone else gets the OpenAI list
      // as a placeholder (the form's "not yet wired" hint will steer
      // them anyway).
      if (forProvider === 'anthropic') return [...ANTHROPIC_VISION_MODELS];
      if (forProvider === 'google') return [...GOOGLE_VISION_MODELS];
      if (forProvider === 'xai') return [...XAI_VISION_MODELS];
      return [...OPENAI_VISION_MODELS];
    }
    if (forKind === 'image_gen') {
      if (forProvider === 'xai') return [...XAI_IMAGE_MODELS];
      if (forProvider === 'google') return [...GOOGLE_IMAGE_MODELS];
      if (forProvider === 'huggingface') return [...HUGGINGFACE_IMAGE_MODELS];
      return [...OPENAI_IMAGE_MODELS];
    }
    if (forKind === 'reflector' || forKind === 'extractor' || forKind === 'summarizer') {
      if (forProvider === 'xai') return [...XAI_CHAT_MODELS];
      if (forProvider === 'huggingface') return [...HUGGINGFACE_CHAT_MODELS];
      if (forProvider === 'anthropic') return [...ANTHROPIC_CHAT_MODELS];
      if (forProvider === 'google') return [...GOOGLE_CHAT_MODELS];
    }
    return [];
  };
  const initialCatalog = staticCatalogFor(kind, provider);
  const [discovery, setDiscovery] = useState<{
    available: Array<
      TtsModelInfo | SttModelInfo | ChatModelInfo | VisionModelInfo | ImageGenModelInfo
    >;
    filtered: boolean;
    error: string | null;
    loading: boolean;
  }>(() => ({
    available: initialCatalog,
    filtered: false,
    error: null,
    loading: false,
  }));

  // OpenRouter pricing map — fetched once, used as a fallback for direct
  // providers (Anthropic / OpenAI / xAI / Google) whose own list endpoints
  // don't return pricing. We look up `${prefix}/${model.id}` in the cache
  // and fold the pricing into the ExplorerModel passed to ModelSelect.
  // Misses are silent: pricing badge just doesn't render for that row.
  const [orPricing, setOrPricing] = useState<
    Record<string, { inputPricePerM?: number; outputPricePerM?: number }>
  >({});
  const explorerModels: ExplorerModel[] = useMemo(
    () => toExplorerModels(discovery.available, provider, orPricing),
    [discovery.available, provider, orPricing],
  );
  useEffect(() => {
    let cancelled = false;
    fetch('/api/model-context')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        if (d?.pricing) setOrPricing(d.pricing as typeof orPricing);
      })
      .catch(() => {
        /* pricing badge is decorative — ignore fetch failures */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshDiscovery = async (keyId: string, providerOverride?: string) => {
    // Decide which dispatch kind to hand to the action: 'chat' for
    // reflector/extractor/summarizer (they make chat calls), 'embedding'
    // routes to OR's keyless catalog (no api key needed), or the
    // worker kind directly for tts/stt/vision/image_gen. We bail out
    // cleanly if the worker kind isn't supported by discovery yet.
    const discoveryKind =
      kind === 'tts' || kind === 'stt' || kind === 'vision' || kind === 'image_gen'
        ? kind
        : kind === 'embedding'
        ? 'embedding'
        : chatShaped
        ? 'chat'
        : null;
    if (!discoveryKind) return;
    // Embedding discovery is keyless (OR's public catalog) — every other
    // kind needs the key to know which models the user can actually use.
    if (!keyId && discoveryKind !== 'embedding') return;
    setDiscovery((d) => ({ ...d, loading: true }));
    try {
      const r = await discoverModelsAction(
        keyId,
        discoveryKind,
        providerOverride ?? provider,
      );
      setDiscovery({
        available: r.available,
        filtered: r.filtered,
        error: r.error,
        loading: false,
      });
    } catch (err) {
      setDiscovery((d) => ({
        ...d,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
        filtered: false,
      }));
    }
  };

  // On first mount, fire discovery if we have a key (edit mode) OR if
  // the kind is `embedding` — that path is keyless against OR's public
  // embeddings catalog, so we can populate the picker before any key
  // selection happens.
  useEffect(() => {
    if (apiKeyId || kind === 'embedding') void refreshDiscovery(apiKeyId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-discover when the provider changes — different providers have
  // different model-listing surfaces. If no api key is selected yet
  // we still want the dropdown to reflect the new provider, so swap
  // to that provider's static catalog as a stopgap until the user
  // picks a key and live discovery runs. Embedding's keyless path
  // means we DON'T need to wait for the key here.
  useEffect(() => {
    if (apiKeyId || kind === 'embedding') {
      void refreshDiscovery(apiKeyId, provider);
    } else {
      setDiscovery({
        available: staticCatalogFor(kind, provider),
        filtered: false,
        error: null,
        loading: false,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const fd = new FormData(e.currentTarget);
        fd.set('kind', kind);
        fd.set('enabled', enabled ? 'on' : 'off');
        fd.set('isDefault', isDefault ? 'on' : 'off');
        startTransition(async () => {
          try {
            await action(fd);
            if (mode === 'edit') toast.success('Saved');
          } catch (err) {
            // Next's `redirect()` inside a server action throws a
            // sentinel error with `digest` starting with 'NEXT_REDIRECT'
            // — the framework catches it at the boundary and performs
            // the navigation. If we swallow it here, the redirect never
            // happens and the user sees a useless "NEXT_REDIRECT" toast.
            // Re-throw so React/Next can do its thing.
            // Same goes for 'NEXT_NOT_FOUND'.
            const digest = (err as { digest?: string } | null)?.digest;
            if (typeof digest === 'string' && (digest.startsWith('NEXT_REDIRECT') || digest === 'NEXT_NOT_FOUND')) {
              throw err;
            }
            const msg = err instanceof Error ? err.message : String(err);
            setError(msg);
            toast.error(msg);
          }
        });
      }}
      className="space-y-6"
    >
      {/* ── Identity ─────────────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            name="name"
            defaultValue={worker?.name ?? ''}
            placeholder="e.g. Saskia's voice"
            required
          />
          <p className="text-xs text-muted-foreground">
            Display label only. The system uses the auto-generated slug for lookups.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="apiKeyId">API key</Label>
          <select
            id="apiKeyId"
            name="apiKeyId"
            value={apiKeyId}
            onChange={(e) => {
              setApiKeyId(e.target.value);
              void refreshDiscovery(e.target.value);
            }}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
          >
            <option value="">— none —</option>
            {keys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.service}/{k.label} ({k.masked})
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            {kind === 'embedding'
              ? 'Pick your OpenRouter key — embedding requests at runtime route through it. Discovery itself is keyless.'
              : supportsDiscovery
              ? 'Selecting a key queries OpenAI to show only models this key can use.'
              : 'Pick a key whose service matches the provider.'}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="provider">Provider</Label>
            <select
              id="provider"
              name="provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              required
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
            >
              {eligibleProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.isAggregator ? ' (aggregator)' : ''}
                  {!isProviderWired(p.id, capability) ? ' — not yet wired' : ''}
                </option>
              ))}
            </select>
            {selectedProvider && (
              <p className="text-xs text-muted-foreground">
                {selectedProvider.description}{' '}
                <a
                  href={selectedProvider.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  docs →
                </a>
              </p>
            )}
            {selectedProvider && !isProviderWired(selectedProvider.id, capability) && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                No adapter registered for <code>{selectedProvider.id}</code> ·{' '}
                <code>{capability}</code>. The UI saves the config, but calls will fail
                until we ship the dispatch code for this provider.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="model">Model</Label>
            {supportsDiscovery ? (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <ModelSelect
                      id="model"
                      name="model"
                      value={model}
                      onValueChange={setModel}
                      models={explorerModels}
                      loading={discovery.loading}
                      placeholder="— pick a model —"
                      emptyMessage="No models in this catalogue match."
                      required
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={!apiKeyId || discovery.loading}
                    onClick={() => void refreshDiscovery(apiKeyId)}
                    title="Re-query the provider for the latest model list"
                  >
                    <RefreshCw
                      className={discovery.loading ? 'animate-spin' : ''}
                    />
                  </Button>
                </div>
                {model && (
                  <p className="text-xs text-muted-foreground">
                    {discovery.available.find((m) => m.id === model)?.description ??
                      'Custom model id — make sure your key has access.'}
                  </p>
                )}
                {!discovery.filtered && discovery.error && apiKeyId && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    Couldn't verify which models this key can use ({discovery.error}). Showing
                    the full catalogue.
                  </p>
                )}
                {discovery.filtered && discovery.available.length === 0 && (
                  <p className="text-xs text-destructive">
                    This key doesn't have access to any {kind === 'tts' ? 'TTS' : 'transcription'}{' '}
                    models. Check the key's project at platform.openai.com.
                  </p>
                )}
              </div>
            ) : (
              <Input
                id="model"
                name="model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={MODEL_HINT_FOR_KIND[kind]}
                required
              />
            )}
          </div>
        </div>
      </section>

      {/* ── Kind-specific config ─────────────────────────────────── */}
      <section className="space-y-4 border-t border-border pt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {kind === 'tts' && 'Voice settings'}
          {kind === 'stt' && 'Transcription settings'}
          {kind === 'vision' && 'Vision settings'}
          {kind === 'image_gen' && 'Image gen settings'}
          {kind === 'reflector' && 'Reflector settings'}
          {kind === 'extractor' && 'Extractor settings'}
          {kind === 'summarizer' && 'Summarizer settings'}
          {kind === 'embedding' && 'Embedding settings'}
        </h2>

        {kind === 'tts' && (
          <TtsFields
            params={params}
            model={model}
            provider={provider}
            apiKeyId={apiKeyId}
          />
        )}
        {kind === 'stt' && <SttFields params={params} />}
        {kind === 'vision' && <VisionFields params={params} systemPrompt={worker?.systemPrompt} />}
        {kind === 'image_gen' && <ImageGenFields params={params} />}
        {kind === 'reflector' && <LlmWorkerFields params={params} systemPrompt={worker?.systemPrompt} kind="reflector" provider={provider} />}
        {kind === 'extractor' && <LlmWorkerFields params={params} systemPrompt={worker?.systemPrompt} kind="extractor" provider={provider} />}
        {kind === 'summarizer' && <LlmWorkerFields params={params} systemPrompt={worker?.systemPrompt} kind="summarizer" provider={provider} />}
        {kind === 'embedding' && <EmbeddingFields model={model} />}
      </section>

      {/* ── Priority ─────────────────────────────────────────────── */}
      <section className="space-y-3 border-t border-border pt-6">
        <div className="space-y-1.5">
          <Label htmlFor="priority">Priority</Label>
          <Input
            id="priority"
            name="priority"
            type="number"
            defaultValue={worker?.priority ?? 100}
            className="w-32"
          />
          <p className="text-xs text-muted-foreground">
            Higher wins when no default is set and several workers of this kind are enabled.
          </p>
        </div>
      </section>

      {/* ── Test button (kind-aware) ──────────────────────────────── */}
      {mode === 'edit' && worker && kind === 'tts' && (
        <section className="space-y-2 border-t border-border pt-6">
          <h3 className="text-sm font-semibold">Test the voice</h3>
          <p className="text-xs text-muted-foreground">
            Synthesise a short sample using the saved configuration so you can hear it before
            it ships. Uses the live API key.
          </p>
          <TtsTestButton workerId={worker.id} />
        </section>
      )}
      {mode === 'edit' && worker && kind === 'stt' && (
        <section className="space-y-2 border-t border-border pt-6">
          <h3 className="text-sm font-semibold">Test transcription</h3>
          <p className="text-xs text-muted-foreground">
            Record a short clip from your microphone; we send it through this worker's Whisper
            config and show what comes back.
          </p>
          <SttTestButton workerId={worker.id} />
        </section>
      )}
      {mode === 'edit' && worker && chatShaped && wiredChatProviders.has(provider) && (
        <section className="space-y-2 border-t border-border pt-6">
          <h3 className="text-sm font-semibold">Test chat</h3>
          <p className="text-xs text-muted-foreground">
            Send a one-shot prompt through this worker's adapter ({provider}) and see what comes back.
            Uses the saved system prompt, model, and params — same path as production.
          </p>
          <ChatTestButton workerId={worker.id} />
        </section>
      )}
      {mode === 'edit' && worker && kind === 'vision' && (
        <section className="space-y-2 border-t border-border pt-6">
          <h3 className="text-sm font-semibold">Test extraction</h3>
          <p className="text-xs text-muted-foreground">
            Pick an image from disk and we'll run it through this worker's vision adapter
            ({provider}) using the saved extraction prompt and model. Use this to dial in the
            prompt before the ingest pipeline starts feeding it photos.
          </p>
          <VisionTestButton workerId={worker.id} />
        </section>
      )}
      {mode === 'edit' && worker && kind === 'image_gen' && (
        <section className="space-y-2 border-t border-border pt-6">
          <h3 className="text-sm font-semibold">Test generation</h3>
          <p className="text-xs text-muted-foreground">
            Type a prompt and we'll send it through this worker's image adapter ({provider})
            using the saved size/style/quality. The result is rendered here only — nothing is
            persisted until Saskia (or another caller) invokes the `generate_image` tool.
          </p>
          <ImageGenTestButton workerId={worker.id} />
        </section>
      )}

      {/* ── Footer ──────────────────────────────────────────────── */}
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2 border-t border-border pt-6">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : mode === 'create' ? 'Create' : 'Save changes'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => router.push('/settings/ai-workers')}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ─── Kind-specific field sets ─────────────────────────────────────────

function TtsFields({
  params,
  model,
  provider,
  apiKeyId,
}: {
  params: Record<string, unknown>;
  model: string;
  provider: string;
  apiKeyId: string;
}) {
  // Voice list is provider-dependent.
  //   OpenAI:     static per-model catalog (9 or 13 voices).
  //   ElevenLabs: live /v1/voices query — includes the user's clones.
  //   xAI:        static 5-voice catalog (eve, ara, rex, sal, leo).
  //   Google:     static 30-voice catalog (Kore, Puck, Zephyr, ...).
  // OpenAI is resolved locally from the model catalog; everything
  // else goes through the adapter's voicesForModel via listVoicesAction
  // so the right adapter handles the discovery (live or static).
  const isElevenLabs = provider === 'elevenlabs';
  const providerWithLiveVoices =
    provider === 'elevenlabs' ||
    provider === 'xai' ||
    provider === 'google';
  const [liveVoices, setLiveVoices] = useState<
    Array<{ id: string; description: string }> | null
  >(null);

  useEffect(() => {
    if (providerWithLiveVoices && apiKeyId) {
      // Lazy-fetch the voice list. ElevenLabs queries /v1/voices
      // live (includes clones); xAI/Google return their static
      // catalogs through the adapter's voicesForModel.
      listVoicesAction(apiKeyId, provider, model)
        .then((r) => setLiveVoices(r.voices))
        .catch(() => setLiveVoices(null));
    } else {
      setLiveVoices(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, apiKeyId, model]);

  const availableVoices = providerWithLiveVoices
    ? liveVoices ?? []
    : model
    ? voicesForModel(model)
    : (Object.entries(VOICE_DESCRIPTIONS) as Array<
        [OpenAiVoice, string]
      >).map(([id, description]) => ({ id, description }));

  // xAI and ElevenLabs both let operators use voice IDs that AREN'T in
  // the preset list — xAI's console generates opaque ids like
  // "69smp8rm" for custom-tuned voices; ElevenLabs returns user-cloned
  // voice ids alongside premades. Other providers (OpenAI, Google)
  // have closed rosters and reject arbitrary ids. We surface an extra
  // "Custom voice ID" input on the two that accept it.
  const supportsCustomVoiceId = provider === 'xai' || provider === 'elevenlabs';

  // Pick a sensible default voice. Logic per provider:
  //   - If the stored voice matches a preset, use it.
  //   - Else, if the provider accepts custom ids, KEEP the stored
  //     value verbatim (operator typed a custom id; don't clobber it).
  //   - Else, fall back to nova (preferred) or the first available
  //     voice (existing OpenAI-style behaviour).
  const storedVoice = (params.voice as string | undefined) ?? 'nova';
  const presetIds = new Set(availableVoices.map((v) => v.id));
  const validVoice = presetIds.has(storedVoice)
    ? storedVoice
    : supportsCustomVoiceId && storedVoice.length > 0
    ? storedVoice
    : availableVoices.find((v) => v.id === 'nova')?.id ??
      availableVoices[0]?.id ??
      storedVoice;

  // Controlled state for the voice field so the dropdown and the
  // custom-id input can stay in sync. Re-seeded when the worker model
  // changes (handled by the useEffect below) so switching to a model
  // with a disjoint voice list doesn't leave the form in a bad state.
  const [voiceValue, setVoiceValue] = useState<string>(validVoice);
  // When availableVoices loads asynchronously (ElevenLabs/xAI/Google
  // live discovery) the validVoice recomputes — sync it into state so
  // the dropdown reflects the freshly-discovered list. Only resync
  // when the chosen voice ISN'T already valid; otherwise typing into
  // the custom input would get stomped on each re-render.
  useEffect(() => {
    if (presetIds.has(voiceValue)) return;
    // For providers that accept custom ids, keep whatever the user
    // typed even if it's not in the preset list.
    if (supportsCustomVoiceId && voiceValue.length > 0) return;
    setVoiceValue(validVoice);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, availableVoices.length]);
  const isCustomVoice = voiceValue.length > 0 && !presetIds.has(voiceValue);

  // Style instructions are honoured by gpt-4o-mini-tts; tts-1 and
  // tts-1-hd ignore the field. ElevenLabs has its own steering
  // (voice_settings) which we expose via speed only for now.
  const supportsInstructions = model === 'gpt-4o-mini-tts';

  // Audio-tag hint — the LLM gets these injected into its system
  // prompt at runtime, but the operator should see them here too so
  // they understand what their voice replies can do. Different
  // providers honour different tag sets; we dispatch on provider.
  const audioTags: readonly AudioTag[] =
    provider === 'elevenlabs'
      ? audioTagsForElevenLabsModel(model)
      : provider === 'xai'
      ? audioTagsForXaiTtsModel(model)
      : provider === 'google'
      ? audioTagsForGoogleTtsModel(model)
      : [];

  // Wrapping speech tags (<whisper>…</whisper>, <soft>, …). Only xAI
  // Grok voice exposes these today; other providers return [].
  const wrappingTags: readonly WrappingTag[] =
    provider === 'xai' ? wrappingTagsForXaiTtsModel(model) : [];

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="voice">Voice</Label>
        {/* Hidden input carries the canonical voice value on submit.
            The dropdown and custom-id input both write to `voiceValue`
            — this is what FormData picks up. */}
        <input type="hidden" name="voice" value={voiceValue} />
        <select
          id="voice"
          // No `name` — the hidden input above owns submission. This
          // is just the preset picker UI.
          value={isCustomVoice ? '__custom__' : voiceValue}
          onChange={(e) => {
            // The "Custom voice ID" sentinel is a no-op selection —
            // the actual custom value lives in the text input below.
            if (e.target.value === '__custom__') return;
            setVoiceValue(e.target.value);
          }}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
        >
          {availableVoices.map((v) => (
            <option key={v.id} value={v.id}>
              {v.id} — {v.description}
            </option>
          ))}
          {supportsCustomVoiceId && (
            <option value="__custom__">
              {isCustomVoice ? `Custom: ${voiceValue}` : 'Custom voice ID…'}
            </option>
          )}
        </select>
        {supportsCustomVoiceId && (
          <div className="space-y-1">
            <Input
              id="voice-custom"
              value={isCustomVoice ? voiceValue : ''}
              onChange={(e) => {
                const next = e.target.value.trim();
                if (next.length === 0) {
                  // Cleared — snap back to the first preset so the
                  // dropdown has a meaningful selection again.
                  setVoiceValue(availableVoices[0]?.id ?? '');
                } else {
                  setVoiceValue(next);
                }
              }}
              placeholder={
                provider === 'xai'
                  ? 'Custom voice ID from console.x.ai (e.g. 69smp8rm) — overrides the preset'
                  : 'Custom voice ID from your ElevenLabs library — overrides the preset'
              }
            />
            <p className="text-xs text-muted-foreground">
              {provider === 'xai'
                ? "Use this for voices generated in xAI's voice studio. The console assigns each one an id like 69smp8rm — paste it here to use it from this worker."
                : "Use this for ElevenLabs voices that aren't auto-discovered (e.g. shared voices, IDs from your library)."}
            </p>
          </div>
        )}
        {model && availableVoices.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {availableVoices.length} voice{availableVoices.length === 1 ? '' : 's'}{' '}
            {isElevenLabs
              ? 'available on your ElevenLabs account (includes any clones)'
              : provider === 'xai'
              ? 'available for Grok TTS'
              : provider === 'google'
              ? 'available for Gemini TTS'
              : `available for ${model}`}
            {supportsCustomVoiceId ? '; custom ids accepted above.' : '.'}
          </p>
        )}
        {providerWithLiveVoices && !apiKeyId && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Pick your {provider === 'elevenlabs'
              ? 'ElevenLabs'
              : provider === 'xai'
              ? 'xAI'
              : 'Google'}{' '}
            API key first; the voice list loads from the adapter.
          </p>
        )}
        {audioTags.length > 0 && (
          <details className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
            <summary className="cursor-pointer font-medium text-foreground">
              Inline audio tags ({audioTags.length}) — your model honours these
            </summary>
            <div className="mt-2 space-y-1">
              <p className="text-muted-foreground">
                The agent's prompt is auto-augmented with these so it can sprinkle them
                inline in voice replies. Text replies have them stripped automatically.
              </p>
              <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5 pt-1 font-mono text-[11px]">
                {audioTags.map((t) => (
                  <li key={t.tag} title={t.description}>
                    {t.tag}{' '}
                    <span className="font-sans text-muted-foreground">— {t.description}</span>
                  </li>
                ))}
              </ul>
            </div>
          </details>
        )}
        {wrappingTags.length > 0 && (
          <details className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
            <summary className="cursor-pointer font-medium text-foreground">
              Wrapping speech tags ({wrappingTags.length}) — your model honours these
            </summary>
            <div className="mt-2 space-y-1">
              <p className="text-muted-foreground">
                Angle-bracket pairs that style a whole phrase, e.g.{' '}
                <code className="font-mono">&lt;whisper&gt;…&lt;/whisper&gt;</code>. The agent's
                prompt is auto-augmented with these for voice replies; text replies have them
                stripped (the inner words are kept).
              </p>
              <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5 pt-1 font-mono text-[11px]">
                {wrappingTags.map((t) => (
                  <li key={t.name} title={t.description}>
                    &lt;{t.name}&gt;…&lt;/{t.name}&gt;{' '}
                    <span className="font-sans text-muted-foreground">— {t.description}</span>
                  </li>
                ))}
              </ul>
            </div>
          </details>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="instructions">
          Style instructions {supportsInstructions ? '' : '(unsupported on this model)'}
        </Label>
        <Input
          id="instructions"
          name="instructions"
          defaultValue={(params.instructions as string) ?? ''}
          placeholder={
            supportsInstructions
              ? 'e.g. "Speak warmly, like an old friend, with a touch of humour."'
              : 'gpt-4o-mini-tts only'
          }
          disabled={!supportsInstructions}
        />
        <p className="text-xs text-muted-foreground">
          {supportsInstructions
            ? 'Steers tone, accent, pacing, emotion. Only the gpt-4o-mini-tts model reads this — older models ignore it.'
            : 'Switch to gpt-4o-mini-tts to use style instructions.'}
        </p>
      </div>

      {/* Language hint — only the xAI TTS endpoint has a structured
          `language` body field today. Critical for xAI custom voices:
          a clone trained on French audio needs language='fr' to keep
          its accent regardless of the text it's reading. OpenAI and
          ElevenLabs derive language from the text/voice; Google
          biases pronunciation via natural-language phrasing in the
          prompt rather than a structured code. */}
      {provider === 'xai' && (
        <div className="space-y-1.5">
          <Label htmlFor="language">Language hint</Label>
          <Input
            id="language"
            name="language"
            defaultValue={(params.language as string) ?? ''}
            placeholder="BCP-47 (e.g. 'en', 'fr', 'pt-BR') or 'auto' / blank to detect."
          />
          <p className="text-xs text-muted-foreground">
            Required when using a custom voice cloned in a non-English language — set this to the
            voice&apos;s native language (e.g. <code className="font-mono">fr</code> for a French
            clone) so the accent stays in character. Leave blank to let Grok auto-detect.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="speed">Speed</Label>
          <Input
            id="speed"
            name="speed"
            type="number"
            step="0.05"
            min="0.25"
            max="4"
            defaultValue={(params.speed as number) ?? 1.0}
          />
          <p className="text-xs text-muted-foreground">0.25–4.0. Try 0.95 for a touch slower.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="format">Format</Label>
          <select
            id="format"
            name="format"
            defaultValue={(params.format as string) ?? 'opus'}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
          >
            <option value="opus">opus (Telegram-native)</option>
            <option value="mp3">mp3</option>
            <option value="wav">wav</option>
            <option value="flac">flac</option>
          </select>
        </div>
      </div>
    </div>
  );
}

function SttFields({ params }: { params: Record<string, unknown> }) {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="language">Language hint (optional)</Label>
        <Input
          id="language"
          name="language"
          defaultValue={(params.language as string) ?? ''}
          placeholder="e.g. en, af, fr — leave blank for auto-detect"
        />
        <p className="text-xs text-muted-foreground">
          ISO-639-1 code. Whisper auto-detects when blank; set this only if you speak one
          language exclusively and want faster results.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="max_duration_seconds">Max duration (seconds)</Label>
        <Input
          id="max_duration_seconds"
          name="max_duration_seconds"
          type="number"
          min="10"
          max="3600"
          defaultValue={(params.max_duration_seconds as number) ?? 180}
          className="w-32"
        />
        <p className="text-xs text-muted-foreground">
          Hard cap. Voice notes longer than this are rejected with a polite reply.
        </p>
      </div>
    </div>
  );
}

function VisionFields({
  params,
  systemPrompt,
}: {
  params: Record<string, unknown>;
  systemPrompt: string | null | undefined;
}) {
  // Default extraction prompt — verbatim transcription. Picked
  // deliberately for the "photo of handwritten notes" use case: the
  // pipeline does its own structuring downstream (extractor agents),
  // so the vision worker should just be a faithful OCR. Operators
  // who want markdown can override; the placeholder shows the shape.
  const defaultPrompt =
    'Transcribe everything visible in this image verbatim, preserving line breaks and structure. If something is unclear, mark it [unclear]. Output plain text only — do not summarise or comment.';
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="systemPrompt">System prompt</Label>
        <textarea
          id="systemPrompt"
          name="systemPrompt"
          defaultValue={systemPrompt ?? ''}
          rows={3}
          placeholder="You are an OCR engine. Output exactly what's on the page — no commentary."
          className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
        />
        <p className="text-xs text-muted-foreground">
          Optional. Use to nudge the model's behaviour across all calls (e.g. &quot;preserve
          mathematical notation as LaTeX&quot;). Leave blank for plain transcription.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="extraction_prompt">Per-image prompt</Label>
        <textarea
          id="extraction_prompt"
          name="extraction_prompt"
          defaultValue={(params.extraction_prompt as string) ?? defaultPrompt}
          rows={3}
          placeholder={defaultPrompt}
          className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
        />
        <p className="text-xs text-muted-foreground">
          Sent alongside each image. The default is verbatim transcription — change it for
          structured-markdown output, summarisation, action-item extraction, etc.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="max_tokens">Max output tokens</Label>
        <Input
          id="max_tokens"
          name="max_tokens"
          type="number"
          defaultValue={(params.max_tokens as number) ?? 2000}
          className="w-32"
        />
        <p className="text-xs text-muted-foreground">
          Caps cost on long transcripts. 2000 covers ~3 pages of dense handwriting.
        </p>
      </div>
    </div>
  );
}

function ImageGenFields({ params }: { params: Record<string, unknown> }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="size">Size</Label>
          <Input
            id="size"
            name="size"
            defaultValue={(params.size as string) ?? '1024x1024'}
            placeholder="1024x1024"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="quality">Quality</Label>
          <select
            id="quality"
            name="quality"
            defaultValue={(params.quality as string) ?? 'standard'}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
          >
            <option value="standard">standard</option>
            <option value="hd">hd</option>
          </select>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="style">Style (DALL-E only)</Label>
        <select
          id="style"
          name="style"
          defaultValue={(params.style as string) ?? 'natural'}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
        >
          <option value="natural">natural</option>
          <option value="vivid">vivid</option>
        </select>
      </div>
    </div>
  );
}

/**
 * Embedding-kind worker fields. Deliberately tiny — embedding is a pure
 * text→vector transformation with no temperature / max_tokens / system
 * prompt to tune. The model picker above this section is the entire
 * interaction.
 *
 * What this surface adds: an explicit reminder of the column constraint
 * (`vector(1536)`) and a soft warning if the picked model is known to
 * produce a different dim — switching to a non-1536 model needs a
 * one-shot `pnpm re-embed` pass or new vectors will fail to insert.
 *
 * The dim → model mapping is intentionally a tight allow-list of slugs
 * we've verified rather than a string-match heuristic — false positives
 * here would block legitimate switches. If a model isn't in the list,
 * we say so plainly instead of guessing.
 */
function EmbeddingFields({ model }: { model: string }) {
  // Lower-cased slug → dimensions for the OR routes we've confirmed.
  // Keep growing this map as new embedding models land in OR's catalog;
  // anything not listed prints the neutral "unknown dimensions" hint and
  // assumes the user knows what they're doing.
  const KNOWN_DIMS: Record<string, number> = {
    'openai/text-embedding-3-small': 1536,
    'openai/text-embedding-3-large': 3072,
    'openai/text-embedding-ada-002': 1536,
    'google/gemini-embedding-2-preview': 1536, // honours output_dimensionality
    'nvidia/llama-nemotron-embed-vl-1b-v2': 1024,
    'nvidia/llama-nemotron-embed-vl-1b-v2:free': 1024,
    'thenlper/gte-base': 768,
    'thenlper/gte-large': 1024,
    'intfloat/e5-base-v2': 768,
    'intfloat/e5-large-v2': 1024,
    'perplexity/pplx-embed-v1-4b': 1024,
    'perplexity/pplx-embed-v1-0.6b': 1024,
  };
  const COLUMN_DIMS = 1536;
  const slug = (model ?? '').toLowerCase().trim();
  const knownDims = slug ? KNOWN_DIMS[slug] : undefined;
  const mismatched = knownDims !== undefined && knownDims !== COLUMN_DIMS;
  return (
    <div className="space-y-3 rounded-md border border-border bg-card/40 p-3 text-sm">
      <p className="text-muted-foreground">
        Embedding is a single text→vector transformation. No temperature, no
        max-tokens. Picking a model here applies it to every embedding call
        in the stack — extractor writes, agent semantic-memory reads, recall,
        MCP search, and the tool-result spill query.
      </p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Column shape</dt>
        <dd className="font-mono tabular-nums">vector({COLUMN_DIMS})</dd>
        <dt className="text-muted-foreground">Selected model dim</dt>
        <dd className="font-mono tabular-nums">
          {knownDims ? (
            <span className={mismatched ? 'text-destructive' : ''}>{knownDims}</span>
          ) : slug ? (
            <span className="text-muted-foreground">unknown</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </dd>
      </dl>
      {mismatched && (
        <p className="rounded border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
          <strong>Dimension mismatch.</strong> This model emits {knownDims}-dim
          vectors but the brain's column is {COLUMN_DIMS}. Saving this worker
          will work, but new embeddings will fail to insert. You'd need to
          either run <code>pnpm re-embed</code> with a column-width migration,
          or pick a 1536-dim model.
        </p>
      )}
      {!knownDims && slug && (
        <p className="text-xs text-muted-foreground">
          Dimensions for this slug aren't in our verified map — confirm at the
          provider's docs. If it's not 1536-dim, insertion will fail; treat
          this as "use at your own risk" until we add it to the allow-list.
        </p>
      )}
    </div>
  );
}

function LlmWorkerFields({
  params,
  systemPrompt,
  kind,
  provider,
}: {
  params: Record<string, unknown>;
  systemPrompt: string | null | undefined;
  kind: 'reflector' | 'extractor' | 'summarizer';
  provider: string;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="systemPrompt">System prompt</Label>
        <textarea
          id="systemPrompt"
          name="systemPrompt"
          defaultValue={systemPrompt ?? ''}
          rows={8}
          placeholder="(default prompt is used if blank)"
          className="flex min-h-[120px] w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm font-mono shadow-sm"
        />
        <p className="text-xs text-muted-foreground">
          Leave blank to use the built-in default for this worker kind.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="temperature">Temperature</Label>
          <Input
            id="temperature"
            name="temperature"
            type="number"
            step="0.05"
            min="0"
            max="2"
            defaultValue={(params.temperature as number) ?? 0.2}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="max_tokens">Max tokens</Label>
          <Input
            id="max_tokens"
            name="max_tokens"
            type="number"
            defaultValue={(params.max_tokens as number) ?? 1500}
          />
        </div>
      </div>
      {kind === 'reflector' && (
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="window_size">Window size (turns)</Label>
            <Input
              id="window_size"
              name="window_size"
              type="number"
              defaultValue={(params.window_size as number) ?? 50}
            />
            <p className="text-xs text-muted-foreground">
              How many recent turns the reflector reviews per run.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="max_notes_per_run">Max notes per run</Label>
            <Input
              id="max_notes_per_run"
              name="max_notes_per_run"
              type="number"
              defaultValue={(params.max_notes_per_run as number) ?? 10}
            />
          </div>
        </div>
      )}
      {kind === 'extractor' && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="target_types">Target node types (comma-separated)</Label>
            <Input
              id="target_types"
              name="target_types"
              defaultValue={
                Array.isArray(params.target_types)
                  ? (params.target_types as string[]).join(', ')
                  : ''
              }
              placeholder="note, * (* = all non-skip types)"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="extract_facts"
                defaultChecked={params.extract_facts !== false}
              />
              Extract facts (vs. summary only)
            </label>
            <div className="space-y-1.5">
              <Label htmlFor="extract_cost_cap_micro_usd">Cost cap (µUSD per node)</Label>
              <Input
                id="extract_cost_cap_micro_usd"
                name="extract_cost_cap_micro_usd"
                type="number"
                defaultValue={
                  (params.extract_cost_cap_micro_usd as number | undefined) ?? ''
                }
                placeholder="blank = no cap"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="embedding_model">
              Embedding model override{' '}
              <span className="text-muted-foreground">(advanced)</span>
            </Label>
            <Input
              id="embedding_model"
              name="embedding_model"
              defaultValue={(params.embedding_model as string) ?? ''}
              placeholder="blank = use the global Embedding worker"
            />
            <p className="text-xs text-muted-foreground">
              Per-extractor override. Leave blank to use the global{' '}
              <a
                href="/settings/ai-workers"
                className="underline decoration-dotted underline-offset-2"
              >
                Embedding worker
              </a>{' '}
              — that's the canonical place to pick the model now, since
              embeddings are used by more than just the extractor (recall,
              MCP search, tool-result spill). Set a value here only if you
              genuinely want this one worker to use a different model from
              the rest of the stack.
            </p>
          </div>
        </>
      )}
      {kind === 'summarizer' && (
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="summarize_threshold">Threshold (turns)</Label>
            <Input
              id="summarize_threshold"
              name="summarize_threshold"
              type="number"
              defaultValue={(params.summarize_threshold as number) ?? 30}
            />
            <p className="text-xs text-muted-foreground">
              Min undigested turns before we attempt a rollup.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="summarize_batch">Batch (turns)</Label>
            <Input
              id="summarize_batch"
              name="summarize_batch"
              type="number"
              defaultValue={(params.summarize_batch as number) ?? 20}
            />
            <p className="text-xs text-muted-foreground">Max turns folded per digest.</p>
          </div>
        </div>
      )}
      {provider === 'huggingface' && (
        <div className="space-y-1.5">
          <Label htmlFor="huggingface_routing">HF routing policy</Label>
          <select
            id="huggingface_routing"
            name="huggingface_routing"
            defaultValue={(params.huggingface_routing as string) ?? 'fastest'}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
          >
            {HUGGINGFACE_ROUTING_POLICIES.map((policy) => (
              <option key={policy} value={policy}>
                {policy}
                {policy === 'fastest' && ' — lowest latency provider (default)'}
                {policy === 'cheapest' && ' — lowest cost per output token'}
                {policy === 'preferred' && ' — your saved provider preference order'}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            HF's router picks which sub-provider (Cerebras, Groq, Together…) actually serves
            this call. Appended as a suffix to the model id at request time.
          </p>
        </div>
      )}
    </div>
  );
}
