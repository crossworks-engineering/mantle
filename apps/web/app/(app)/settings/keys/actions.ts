'use server';

/**
 * Server actions for /settings/api-keys.
 *
 * Currently one: `testApiKeyAction` — a "Does this key work?" probe
 * the UI calls right after a key is created (or whenever the user
 * clicks "Test"). It avoids the previous failure mode where you'd
 * paste a key, save, forget about it, then discover at 11pm in a
 * voice message that the OpenAI key was missing the `:tts-1` scope.
 *
 * How it works: every wired adapter ships a `discoverModels(apiKey)`
 * method that hits the provider's models endpoint. Calling that is
 * effectively an auth probe — 200 = key good, 401/403/whatever =
 * key bad — and it surfaces the actual error message from the
 * provider. We pick the right adapter for the key's service by
 * trying chat → tts → stt in turn (most providers have at least
 * one of these).
 *
 * For providers in our catalog that don't have an adapter yet
 * (DeepSeek, Mistral, Cohere, Deepgram, AssemblyAI today), the
 * action returns a clear "no adapter wired" result so the UI can
 * say "we can't test this yet" rather than silently passing.
 */

import { requireOwner } from '@/lib/auth';
import { getApiKeyById } from '@mantle/api-keys';
import {
  getChatAdapter,
  getProvider,
  getSttAdapter,
  getTtsAdapter,
} from '@mantle/voice';

export type TestApiKeyResult = {
  ok: boolean;
  /** One-line summary for the UI — e.g. '13 models accessible' or
   *  'OpenAI rejected the key (401)'. */
  message: string;
  /** Provider label for the result line. Empty when we can't resolve
   *  the provider from the key's service. */
  provider: string;
  /** Which adapter ran the probe ('openai-tts', 'anthropic-chat', …).
   *  Helps debugging when something goes wrong. Empty when no adapter
   *  was available. */
  adapter: string;
  /** Number of models accessible to this key, if discovery succeeded
   *  and filtered. Surfaced in the result so the user can sanity-
   *  check that the right tier showed up. */
  modelsFound?: number;
};

export async function testApiKeyAction(
  keyId: string,
  service: string,
): Promise<TestApiKeyResult> {
  await requireOwner();

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

  // Resolve whichever adapter exists for this provider. Try chat
  // first since that's the most common shape; fall back to TTS then
  // STT. The order matters only for providers that ship multiple
  // capabilities (OpenAI has all three — chat is the cheapest probe).
  const adapter =
    getChatAdapter(service) ??
    getTtsAdapter(service) ??
    getSttAdapter(service);

  if (!adapter) {
    return {
      ok: false,
      message: `No adapter wired for ${providerLabel} yet — can't test automatically. Save the key and the next time you create a worker for this provider the form will surface any auth issues.`,
      provider: providerLabel,
      adapter: '',
    };
  }

  if (!adapter.discoverModels) {
    // Adapters can opt out of discovery (provider doesn't expose a
    // models endpoint). We can't test those without making a real
    // synthesis/transcription call, which costs money. Skip.
    return {
      ok: false,
      message: `${adapter.adapterName} doesn't expose a discovery endpoint to probe — can't test without spending API credits.`,
      provider: providerLabel,
      adapter: adapter.adapterName,
    };
  }

  try {
    const result = await adapter.discoverModels(apiKey);
    // `filtered === true` means the provider's /v1/models returned
    // something and our catalog had overlap → key definitely works.
    if (result.filtered) {
      return {
        ok: true,
        message: `${result.available.length} model${result.available.length === 1 ? '' : 's'} accessible.`,
        provider: providerLabel,
        adapter: adapter.adapterName,
        modelsFound: result.available.length,
      };
    }
    // `filtered === false` with an error means the call failed — that's
    // usually the auth path (401/403). Pass the error through verbatim;
    // it tells the user EXACTLY what's wrong (wrong key, missing scope,
    // rate limited, etc.).
    if (result.error) {
      return {
        ok: false,
        message: result.error,
        provider: providerLabel,
        adapter: adapter.adapterName,
      };
    }
    // `filtered === false` with no error is unusual — the call
    // succeeded but our catalog had zero overlap with the live model
    // list. That can happen on a free-tier key with restricted access.
    // Treat as a soft pass with a heads-up.
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
