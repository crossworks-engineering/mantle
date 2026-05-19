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

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import type { AiWorker, AiWorkerKind } from '@mantle/db';
import {
  ANTHROPIC_CHAT_MODELS,
  CAPABILITY_FOR_KIND,
  GOOGLE_CHAT_MODELS,
  HUGGINGFACE_CHAT_MODELS,
  HUGGINGFACE_ROUTING_POLICIES,
  OPENAI_STT_MODELS,
  OPENAI_TTS_MODELS,
  VOICE_DESCRIPTIONS,
  XAI_CHAT_MODELS,
  audioTagsForElevenLabsModel,
  audioTagsForGoogleTtsModel,
  audioTagsForXaiTtsModel,
  isProviderWired,
  providersForCapability,
  voicesForModel,
  type AudioTag,
  type ChatModelInfo,
  type OpenAiVoice,
  type ProviderCapability,
  type SttModelInfo,
  type TtsModelInfo,
} from '@mantle/voice';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';
import { discoverModelsAction, listVoicesAction } from './actions';
import { TtsTestButton } from './tts-test-button';
import { SttTestButton } from './stt-test-button';
import { ChatTestButton } from './chat-test-button';

type KeyOption = { id: string; service: string; label: string; masked: string };

type Props = {
  mode: 'create' | 'edit';
  kind: AiWorkerKind;
  worker?: AiWorker;
  keys: KeyOption[];
  action: (formData: FormData) => Promise<void>;
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
};

/** Suggested model per kind, used as the placeholder. */
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
};

export function WorkerForm({ mode, kind, worker, keys, action }: Props) {
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
  const supportsDiscovery =
    kind === 'tts' ||
    kind === 'stt' ||
    (chatShaped && wiredChatProviders.has(provider));

  // The initial model list rendered before live discovery returns
  // depends on which provider+kind we're configuring. Picking the
  // right static fallback per (kind, provider) means the dropdown
  // is never empty in create mode.
  const initialCatalog = ((): Array<TtsModelInfo | SttModelInfo | ChatModelInfo> => {
    if (kind === 'tts') return [...OPENAI_TTS_MODELS];
    if (kind === 'stt') return [...OPENAI_STT_MODELS];
    if (chatShaped) {
      if (provider === 'xai') return [...XAI_CHAT_MODELS];
      if (provider === 'huggingface') return [...HUGGINGFACE_CHAT_MODELS];
      if (provider === 'anthropic') return [...ANTHROPIC_CHAT_MODELS];
      if (provider === 'google') return [...GOOGLE_CHAT_MODELS];
    }
    return [];
  })();
  const [discovery, setDiscovery] = useState<{
    available: Array<TtsModelInfo | SttModelInfo | ChatModelInfo>;
    filtered: boolean;
    error: string | null;
    loading: boolean;
  }>(() => ({
    available: initialCatalog,
    filtered: false,
    error: null,
    loading: false,
  }));

  const refreshDiscovery = async (keyId: string, providerOverride?: string) => {
    if (!keyId) return;
    // Decide which dispatch kind to hand to the action: 'chat' for
    // reflector/extractor/summarizer (they make chat calls), or the
    // worker kind directly for tts/stt. We bail out cleanly if the
    // worker kind isn't supported by discovery yet.
    const discoveryKind =
      kind === 'tts' || kind === 'stt'
        ? kind
        : chatShaped
        ? 'chat'
        : null;
    if (!discoveryKind) return;
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

  // On first mount, if we already have a key (edit mode), fetch the
  // live model list so the dropdown narrows immediately. Skip in
  // create mode until the user picks a key.
  useEffect(() => {
    if (apiKeyId) void refreshDiscovery(apiKeyId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-discover when the provider changes — different providers have
  // different model-listing surfaces, and the catalog the form falls
  // back to in the meantime is OpenAI-shaped.
  useEffect(() => {
    if (apiKeyId) void refreshDiscovery(apiKeyId, provider);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const fd = new FormData(e.currentTarget);
        fd.set('kind', kind);
        startTransition(async () => {
          try {
            await action(fd);
            if (mode === 'edit') toast.success('Saved');
          } catch (err) {
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
            {supportsDiscovery
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
                  <select
                    id="model"
                    name="model"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    required
                    className="flex h-9 flex-1 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                  >
                    <option value="">— pick a model —</option>
                    {discovery.available.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={!apiKeyId || discovery.loading}
                    onClick={() => void refreshDiscovery(apiKeyId)}
                    title="Re-query OpenAI for the latest model list"
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${discovery.loading ? 'animate-spin' : ''}`}
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
      </section>

      {/* ── Flags ────────────────────────────────────────────────── */}
      <section className="space-y-3 border-t border-border pt-6">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={worker?.enabled ?? true}
          />
          Enabled
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="isDefault"
            defaultChecked={worker?.isDefault ?? mode === 'create'}
          />
          Default for this kind
          <span className="text-xs text-muted-foreground">
            (the runtime picks this when no specific worker is named)
          </span>
        </label>
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

  // Pick a sensible default voice: keep the stored one if it's still
  // valid for the selected model; otherwise fall back to nova (if
  // available) or the first voice in the list.
  const storedVoice = (params.voice as string | undefined) ?? 'nova';
  const validVoice = availableVoices.find((v) => v.id === storedVoice)
    ? storedVoice
    : availableVoices.find((v) => v.id === 'nova')?.id ??
      availableVoices[0]?.id ??
      storedVoice;

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

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="voice">Voice</Label>
        <select
          id="voice"
          name="voice"
          // `key` forces a remount when the model changes so the
          // selected option reflects the new validVoice default.
          key={`voice-${model}-${availableVoices.length}`}
          defaultValue={validVoice}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
        >
          {availableVoices.map((v) => (
            <option key={v.id} value={v.id}>
              {v.id} — {v.description}
            </option>
          ))}
        </select>
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
            .
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
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="systemPrompt">System prompt</Label>
        <textarea
          id="systemPrompt"
          name="systemPrompt"
          defaultValue={systemPrompt ?? ''}
          rows={4}
          placeholder="You are a vision assistant. Extract the contents as markdown…"
          className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="extraction_prompt">Extraction prompt (per-image)</Label>
        <Input
          id="extraction_prompt"
          name="extraction_prompt"
          defaultValue={(params.extraction_prompt as string) ?? ''}
          placeholder="Transcribe everything on this whiteboard verbatim, preserving structure."
        />
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
            <Label htmlFor="embedding_model">Embedding model override</Label>
            <Input
              id="embedding_model"
              name="embedding_model"
              defaultValue={(params.embedding_model as string) ?? ''}
              placeholder="text-embedding-3-small (blank = global default)"
            />
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
