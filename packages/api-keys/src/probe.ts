/**
 * "Does this API key work?" probe of a token: shared by the vault's
 * write gateway (testVaultKey, behind Settings > Keys' Test and the
 * api_key_test tool) and the onboarding sanity checks. Server-only: it opens
 * the stored key and calls the provider. Auth is the caller's job.
 *
 * How it works: every wired adapter ships a `discoverModels(credential)`
 * method that hits the provider's models endpoint; calling that is
 * effectively an auth probe (200 = key good, 401/403 = key bad) and surfaces
 * the provider's actual error, with the key scrubbed out of it (a provider
 * may echo the key it refused). We pick the adapter by trying chat, tts,
 * stt in turn. Providers in our catalog without an adapter yet return a
 * clear "can't test this" result.
 */
import { getChatAdapter, getProvider, getSttAdapter, getTtsAdapter } from '@mantle/voice';
import type { TestApiKeyResult } from '@mantle/client-types';
import { errorMessage, isMcpManagedSecretService, scrubSecrets } from '@mantle/std';
import { getApiKeyById } from './index';

export type { TestApiKeyResult };

export async function probeApiKey(keyId: string, service: string): Promise<TestApiKeyResult> {
  // Connector-sealed OAuth state, not a provider key: nothing to probe.
  if (isMcpManagedSecretService(service)) {
    return {
      ok: false,
      message: `'${service}' rows hold MCP connector OAuth state, not a provider key, so there is nothing to test here; manage the connector under Settings → Connectors.`,
      provider: service,
      adapter: '',
    };
  }
  const provider = getProvider(service);
  const providerLabel = provider?.label ?? service;

  const credential = await getApiKeyById(keyId);
  if (!credential) {
    return {
      ok: false,
      message: 'Key not found or could not be decrypted.',
      provider: providerLabel,
      adapter: '',
    };
  }
  const scrub = (text: string) => scrubSecrets(text, new Map([[service, credential.apiKey]]));

  // Resolve whichever adapter exists for this provider (chat is the cheapest
  // probe; fall back to TTS then STT).
  const adapter = getChatAdapter(service) ?? getTtsAdapter(service) ?? getSttAdapter(service);

  if (!adapter) {
    return {
      ok: false,
      message: `No adapter wired for ${providerLabel} yet, so it can't be tested automatically. Save the key and the next time you create a worker for this provider the form will surface any auth issues.`,
      provider: providerLabel,
      adapter: '',
    };
  }

  if (!adapter.discoverModels) {
    return {
      ok: false,
      message: `${adapter.adapterName} doesn't expose a discovery endpoint to probe, so it can't be tested without spending API credits.`,
      provider: providerLabel,
      adapter: adapter.adapterName,
    };
  }

  try {
    const result = await adapter.discoverModels(credential);
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
        message: scrub(result.error),
        provider: providerLabel,
        adapter: adapter.adapterName,
      };
    }
    return {
      ok: true,
      message:
        'Key accepted, but none of the catalogued models are accessible: your tier may not include them. Check the provider console.',
      provider: providerLabel,
      adapter: adapter.adapterName,
      modelsFound: 0,
    };
  } catch (err) {
    return {
      ok: false,
      message: scrub(errorMessage(err)),
      provider: providerLabel,
      adapter: adapter.adapterName,
    };
  }
}
