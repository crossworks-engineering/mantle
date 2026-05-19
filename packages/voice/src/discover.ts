/**
 * Live model discovery for OpenAI keys. Calls `GET /v1/models` and
 * cross-references against our static catalog to return ONLY the TTS
 * (or STT) models the user's key has access to.
 *
 * Why bother: OpenAI accounts are tiered. Free-tier and older keys
 * sometimes can't see gpt-4o-mini-tts even though it's "officially
 * released." The list-models call is the only way to know what THIS
 * key can actually use. Without it we'd show models in the dropdown
 * that the API call would later refuse, and the user wouldn't know
 * until their voice message silently failed.
 *
 * Failure mode: if the list call itself fails (rate limit, network),
 * we fall back to the full catalog so the form is still usable. The
 * caller surfaces a hint about the fallback so the user knows the
 * filter wasn't applied.
 */

import {
  OPENAI_TTS_MODELS,
  OPENAI_STT_MODELS,
  type TtsModelInfo,
  type SttModelInfo,
} from './catalog';

const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';

type ListModelsResponse = {
  object: 'list';
  data: Array<{
    id: string;
    object: 'model';
    created: number;
    owned_by: string;
  }>;
};

export type DiscoveryResult<T> = {
  /** The catalog entries the key can actually use, in catalog order. */
  available: T[];
  /** True if the live filter succeeded; false if we fell back to the
   *  full catalog because the API call failed. The UI surfaces a hint
   *  in that case ("couldn't verify; showing everything"). */
  filtered: boolean;
  /** When `filtered=false`, the reason. Null on success. */
  error: string | null;
};

/** Fetch the list of model ids the key has access to. Used by both
 *  TTS and STT discovery — single network round trip. */
async function fetchAvailableModelIds(apiKey: string): Promise<Set<string>> {
  const res = await fetch(OPENAI_MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
    // GET /v1/models is small and fast, but we cap defensively so a
    // misbehaving network doesn't hang the edit page.
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`openai list-models ${res.status}: ${body.slice(0, 300)}`);
  }
  const parsed = (await res.json()) as ListModelsResponse;
  const ids = new Set<string>();
  for (const m of parsed.data ?? []) ids.add(m.id);
  return ids;
}

/** Available TTS models for this key. */
export async function discoverTtsModels(
  apiKey: string,
): Promise<DiscoveryResult<TtsModelInfo>> {
  try {
    const ids = await fetchAvailableModelIds(apiKey);
    return {
      available: OPENAI_TTS_MODELS.filter((m) => ids.has(m.id)),
      filtered: true,
      error: null,
    };
  } catch (err) {
    return {
      available: [...OPENAI_TTS_MODELS],
      filtered: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Available STT models for this key. */
export async function discoverSttModels(
  apiKey: string,
): Promise<DiscoveryResult<SttModelInfo>> {
  try {
    const ids = await fetchAvailableModelIds(apiKey);
    return {
      available: OPENAI_STT_MODELS.filter((m) => ids.has(m.id)),
      filtered: true,
      error: null,
    };
  } catch (err) {
    return {
      available: [...OPENAI_STT_MODELS],
      filtered: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
