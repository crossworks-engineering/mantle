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
  /**
   * EVERY model id the provider reported, before we intersected it with our
   * catalog. Optional: only the adapters that curate a static catalog and
   * filter it need to set this.
   *
   * It exists because `available` answers "which of OUR models are live?" and
   * deliberately discards the other half of the answer — "which of THEIRS
   * aren't ours?" That discarded half is the only automatic signal that a
   * catalog has gone stale, and we were computing it on every discovery call
   * and dropping it. grok-4.5 shipped, our dropdown never mentioned it, and
   * nothing anywhere could have said so.
   *
   * Consumed by `pnpm -C server/web models:drift`. See {@link catalogDrift}.
   */
  liveIds?: string[];
};

/**
 * Compare what a provider serves against what we catalogue.
 *
 * `unlisted` = the provider has it, we don't offer it (a new model nobody can
 * pick). `stale` = we offer it, the provider no longer lists it (a dead entry
 * that 404s when someone picks it).
 *
 * `aliasOf` handles the one legitimate mismatch: Anthropic's Models API returns
 * dated ids (`claude-haiku-4-5-20251001`) while our catalog holds the alias
 * (`claude-haiku-4-5`). Without it every dated snapshot would report as drift
 * forever, and a report that always cries wolf is a report nobody reads.
 */
export function catalogDrift(
  liveIds: readonly string[],
  catalogIds: readonly string[],
  aliasOf?: (liveId: string) => string | undefined,
): { unlisted: string[]; stale: string[] } {
  const catalog = new Set(catalogIds);
  const live = new Set(liveIds);
  const unlisted: string[] = [];
  for (const id of liveIds) {
    if (catalog.has(id)) continue;
    const alias = aliasOf?.(id);
    if (alias && catalog.has(alias)) continue;
    unlisted.push(id);
  }
  const aliased = new Set(
    aliasOf ? liveIds.map((id) => aliasOf(id)).filter((v): v is string => Boolean(v)) : [],
  );
  const stale = catalogIds.filter((id) => !live.has(id) && !aliased.has(id));
  return { unlisted: [...new Set(unlisted)].sort(), stale: stale.sort() };
}

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
export async function discoverTtsModels(apiKey: string): Promise<DiscoveryResult<TtsModelInfo>> {
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
export async function discoverSttModels(apiKey: string): Promise<DiscoveryResult<SttModelInfo>> {
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
