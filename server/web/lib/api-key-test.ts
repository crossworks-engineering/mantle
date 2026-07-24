/**
 * "Does this API key work?" probe — shared by the /settings/api-keys test button
 * (via POST /api/keys/test) and the onboarding sanity checks. Server-only (it
 * decrypts the stored key and calls the provider). Auth is the caller's job.
 *
 * How it works: every wired adapter ships a `discoverModels(apiKey)` method that
 * hits the provider's models endpoint — calling that is effectively an auth probe
 * (200 = key good, 401/403 = key bad) and surfaces the provider's actual error.
 * We pick the adapter by trying chat → tts → stt in turn. Providers in our
 * catalog without an adapter yet return a clear "can't test this" result.
 */
import { getApiKeyById } from '@mantle/api-keys';
import { getChatAdapter, getProvider, getSttAdapter, getTtsAdapter } from '@mantle/voice';

export type TestApiKeyResult = {
  ok: boolean;
  /** One-line summary for the UI — e.g. '13 models accessible' or
   *  'OpenAI rejected the key (401)'. */
  message: string;
  /** Provider label for the result line. Empty when we can't resolve the
   *  provider from the key's service. */
  provider: string;
  /** Which adapter ran the probe ('openai-tts', 'anthropic-chat', …). */
  adapter: string;
  /** Number of models accessible to this key, if discovery succeeded. */
  modelsFound?: number;
};

export async function probeApiKey(keyId: string, service: string): Promise<TestApiKeyResult> {
  const provider = getProvider(service);
  const providerLabel = provider?.label ?? service;

  const apiKey = await getApiKeyById(keyId);
  if (!apiKey) {
    return {
      ok: false,
      message: 'Key not found or could not be decrypted.',
      provider: providerLabel,
      adapter: '',
    };
  }

  // Resolve whichever adapter exists for this provider (chat is the cheapest
  // probe; fall back to TTS then STT).
  const adapter = getChatAdapter(service) ?? getTtsAdapter(service) ?? getSttAdapter(service);

  if (!adapter) {
    return {
      ok: false,
      message: `No adapter wired for ${providerLabel} yet — can't test automatically. Save the key and the next time you create a worker for this provider the form will surface any auth issues.`,
      provider: providerLabel,
      adapter: '',
    };
  }

  if (!adapter.discoverModels) {
    return {
      ok: false,
      message: `${adapter.adapterName} doesn't expose a discovery endpoint to probe — can't test without spending API credits.`,
      provider: providerLabel,
      adapter: adapter.adapterName,
    };
  }

  try {
    const result = await adapter.discoverModels(apiKey);
    if (result.filtered) {
      return {
        ok: true,
        message: `${result.available.length} model${result.available.length === 1 ? '' : 's'} accessible.`,
        provider: providerLabel,
        adapter: adapter.adapterName,
        modelsFound: result.available.length,
      };
    }
    if (result.error) {
      return {
        ok: false,
        message: result.error,
        provider: providerLabel,
        adapter: adapter.adapterName,
      };
    }
    return {
      ok: true,
      message:
        'Key accepted, but none of the catalogued models are accessible — your tier may not include them. Check the provider console.',
      provider: providerLabel,
      adapter: adapter.adapterName,
      modelsFound: 0,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      provider: providerLabel,
      adapter: adapter.adapterName,
    };
  }
}
