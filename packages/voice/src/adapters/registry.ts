/**
 * Adapter registry — provider id → dispatcher lookup, per capability.
 *
 * Built-in adapters self-register at module load via the import chain
 * in `./index.ts`. Apps that want to add custom adapters at runtime
 * call `registerTtsAdapter(...)` etc. before the first use.
 *
 * Resolution is intentionally strict: if no adapter is registered for
 * a given `providerId`, the lookup returns null and the runtime
 * surfaces a clear "not yet wired" error rather than guessing. The
 * catalog's `wired` flag is derived from these registries so the UI
 * stays honest about which providers can actually be called.
 */

import type { Provider, ProviderCapability, ProviderId } from '../providers';
import type {
  ChatDispatcher,
  EmbeddingDispatcher,
  ImageGenDispatcher,
  SttDispatcher,
  TtsDispatcher,
  VisionDispatcher,
} from './types';
import { withChatRetry } from './retry';

const CHAT = new Map<ProviderId, ChatDispatcher>();
const TTS = new Map<ProviderId, TtsDispatcher>();
const STT = new Map<ProviderId, SttDispatcher>();
const VISION = new Map<ProviderId, VisionDispatcher>();
const IMAGE_GEN = new Map<ProviderId, ImageGenDispatcher>();
const EMBEDDING = new Map<ProviderId, EmbeddingDispatcher>();

// ─── Chat ────────────────────────────────────────────────────────────

export function registerChatAdapter(adapter: ChatDispatcher): void {
  CHAT.set(adapter.providerId, adapter);
}

export function getChatAdapter(providerId: string): ChatDispatcher | null {
  const adapter = CHAT.get(providerId as ProviderId) ?? null;
  if (!adapter) return null;
  // OpenRouter's SDK already retries transient errors internally; wrapping it
  // would compound attempt counts. The native-fetch adapters (anthropic /
  // google / xai / huggingface / deepseek) have no retry of their own, so wrap
  // those once here for uniform 429/5xx/network/timeout backoff.
  if (adapter.providerId === 'openrouter') return adapter;
  return withChatRetry(adapter);
}

export function listChatAdapters(): ChatDispatcher[] {
  return Array.from(CHAT.values());
}

// ─── TTS ─────────────────────────────────────────────────────────────

export function registerTtsAdapter(adapter: TtsDispatcher): void {
  TTS.set(adapter.providerId, adapter);
}

export function getTtsAdapter(providerId: string): TtsDispatcher | null {
  return TTS.get(providerId as ProviderId) ?? null;
}

export function listTtsAdapters(): TtsDispatcher[] {
  return Array.from(TTS.values());
}

// ─── STT ─────────────────────────────────────────────────────────────

export function registerSttAdapter(adapter: SttDispatcher): void {
  STT.set(adapter.providerId, adapter);
}

export function getSttAdapter(providerId: string): SttDispatcher | null {
  return STT.get(providerId as ProviderId) ?? null;
}

export function listSttAdapters(): SttDispatcher[] {
  return Array.from(STT.values());
}

// ─── Vision (interface ready, no adapters yet) ───────────────────────

export function registerVisionAdapter(adapter: VisionDispatcher): void {
  VISION.set(adapter.providerId, adapter);
}

export function getVisionAdapter(providerId: string): VisionDispatcher | null {
  return VISION.get(providerId as ProviderId) ?? null;
}

/**
 * Provider ids whose vision adapter can read a PDF NATIVELY — i.e. implements
 * `extractDocument`. This is the SELF-MAINTAINING source of truth for "which
 * providers a Document worker can use natively": it reads the adapter registry,
 * so the moment a new adapter (e.g. Google) gains `extractDocument`, it appears
 * here with no second list to update. Native-PDF capability is a fact about OUR
 * adapter code, not something the provider's API advertises — so the registry
 * is the only honest place to derive it.
 */
export function nativeDocumentProviders(): ProviderId[] {
  const out: ProviderId[] = [];
  for (const [id, adapter] of VISION) {
    if (typeof adapter.extractDocument === 'function') out.push(id);
  }
  return out;
}

// ─── Image generation (interface ready, no adapters yet) ─────────────

export function registerImageGenAdapter(adapter: ImageGenDispatcher): void {
  IMAGE_GEN.set(adapter.providerId, adapter);
}

export function getImageGenAdapter(providerId: string): ImageGenDispatcher | null {
  return IMAGE_GEN.get(providerId as ProviderId) ?? null;
}

// ─── Embedding ───────────────────────────────────────────────────────

export function registerEmbeddingAdapter(adapter: EmbeddingDispatcher): void {
  EMBEDDING.set(adapter.providerId, adapter);
}

export function getEmbeddingAdapter(providerId: string): EmbeddingDispatcher | null {
  return EMBEDDING.get(providerId as ProviderId) ?? null;
}

export function listEmbeddingAdapters(): EmbeddingDispatcher[] {
  return Array.from(EMBEDDING.values());
}

// ─── Capability check (used by UI to derive `wired` flag) ────────────

/**
 * Verify the providers catalog and the adapter registry agree on
 * "what each provider supports". Returns an array of drift problems
 * (empty when consistent). Each problem is the human-readable
 * sentence we surface to the dev log or to the failing test.
 *
 * The drift we care about: a registered adapter exists for a
 * (provider, capability) pair that the providers catalog does NOT
 * declare. Symptom in production: provider dropdown filters in the
 * worker form (which read the catalog's `capabilities`) hide the
 * provider for that kind, even though the runtime would happily
 * accept it. We hit this exact bug when xai-tts + google-tts
 * shipped — adapters registered, catalog still said chat-only —
 * and the TTS dropdown wouldn't list either.
 *
 * Catalog without adapter is the OTHER direction and is FINE — it
 * means "we plan to wire this; not yet." That's the documented
 * "not yet wired" state and isn't a bug.
 *
 * Called from `./index.ts` once on module load (dev-log warning) and
 * exercised explicitly in catalog-consistency.test.ts so a missed
 * catalog edit fails CI.
 */
export function findAdapterCatalogDrift(
  providers: ReadonlyArray<{ id: string; capabilities: readonly string[] }>,
): string[] {
  const problems: string[] = [];
  const catalogById = new Map(providers.map((p) => [p.id as string, p.capabilities]));

  function check(
    label: 'chat' | 'tts' | 'stt' | 'vision' | 'image_gen' | 'embedding',
    registry: Map<ProviderId, { adapterName: string }>,
  ): void {
    for (const [providerId, adapter] of registry) {
      const caps = catalogById.get(providerId);
      if (!caps) {
        problems.push(
          `${adapter.adapterName} is registered, but provider id '${providerId}' is not in SUPPORTED_PROVIDERS.`,
        );
        continue;
      }
      if (!caps.includes(label)) {
        problems.push(
          `${adapter.adapterName} is registered, but the providers catalog for '${providerId}' does not list '${label}' in capabilities. ` +
            `Add '${label}' to the entry in packages/voice/src/providers.ts so the worker-form dropdown surfaces this provider for ${label} workers.`,
        );
      }
    }
  }

  check('chat', CHAT);
  check('tts', TTS);
  check('stt', STT);
  check('vision', VISION);
  check('image_gen', IMAGE_GEN);
  check('embedding', EMBEDDING);

  return problems;
}

/**
 * Is the given provider wired (i.e. has a registered adapter) for the
 * given capability? Drives the "wired" / "not yet wired" hint in the
 * settings UI so the catalog stays honest.
 */
export function isProviderWired(
  providerId: string,
  capability: 'tts' | 'stt' | 'vision' | 'image_gen' | 'chat' | 'embedding',
): boolean {
  switch (capability) {
    case 'tts':
      return TTS.has(providerId as ProviderId);
    case 'stt':
      return STT.has(providerId as ProviderId);
    case 'vision':
      return VISION.has(providerId as ProviderId);
    case 'image_gen':
      return IMAGE_GEN.has(providerId as ProviderId);
    case 'chat':
      // Chat is wired if a chat adapter is registered for this
      // provider. OpenRouter has its own adapter now (closes the
      // pre-Phase-3 special case where OR was the only chat provider
      // without an adapter file). The 'openai' carve-out stays because
      // there's no direct openai-chat adapter — OpenAI chat is reached
      // via OpenRouter today and probably forever (OR's OpenAI route
      // is identical pricing + adds failover).
      return (
        CHAT.has(providerId as ProviderId) || providerId === 'openai'
      );
    case 'embedding':
      // As of Stage 1 of the embedding adapter framework, every
      // embedding provider goes through the registry. Treat
      // "registered adapter exists" as the truth.
      return EMBEDDING.has(providerId as ProviderId);
    default:
      return false;
  }
}

/**
 * For each capability the provider's catalog DECLARES, return whether
 * an adapter is registered for it. Drives the api-keys form's
 * per-provider wired-status summary so operators see exactly what a
 * key for this provider will be usable for (vs. the binary
 * "any-capability-wired" check which misclassifies partially-wired
 * providers like Mistral/Cohere — both declare chat but only wire
 * embedding).
 *
 * Returns wired + unwired arrays preserving the catalog's declared
 * order. UI typically renders wired ones first (the usable
 * capabilities) and unwired ones separately as "supported but not
 * dispatched by Mantle yet."
 */
export function wiredCapabilitiesFor(
  provider: Provider,
): { wired: ProviderCapability[]; unwired: ProviderCapability[] } {
  const wired: ProviderCapability[] = [];
  const unwired: ProviderCapability[] = [];
  for (const cap of provider.capabilities) {
    if (isProviderWired(provider.id, cap)) wired.push(cap);
    else unwired.push(cap);
  }
  return { wired, unwired };
}
