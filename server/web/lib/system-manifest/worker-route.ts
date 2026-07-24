/**
 * Pure route resolution for manifest workers — shared by onboarding and the boot
 * reconcile so the "which key → which provider/model" decision lives in one
 * place. Dependency-free (type-only imports) so it's unit-tested directly, like
 * ./reconcile-util.ts.
 *
 * The manifest owns BOTH routes (see MANIFEST_WORKERS): a default route on the
 * one-OpenRouter-key baseline, and an optional alt route a worker upgrades to
 * when the user holds a dedicated key (voice → xAI). The only thing that depends
 * on user input is which keys exist — that's the overlay this resolver applies.
 */

import type { ManifestWorker } from './manifest';
import type { AiWorkerParams } from '@mantle/db';

export type WorkerRoute = {
  provider: string;
  model: string;
  params?: AiWorkerParams;
  /** The api_keys service whose key authenticates this route's provider. */
  keyService: string;
};

/** Map a chat provider to the api_keys service that authenticates it (1:1 today). */
function serviceForProvider(provider: string): string {
  return provider;
}

/**
 * Pick the route to seed a worker on given the API-key services the owner has.
 * Prefers the alt route (e.g. voice → xAI) when the user holds its key; else the
 * default route. Returns null when no key exists for the chosen route's provider
 * — the worker can't be seeded and the caller skips it.
 */
export function resolveWorkerRoute(
  w: ManifestWorker,
  keyServices: Set<string>,
): WorkerRoute | null {
  if (w.altKeyService && w.altProvider && w.altModel && keyServices.has(w.altKeyService)) {
    return {
      provider: w.altProvider,
      model: w.altModel,
      params: w.altParams,
      keyService: serviceForProvider(w.altProvider),
    };
  }
  const keyService = serviceForProvider(w.provider);
  if (!keyServices.has(keyService)) return null;
  return { provider: w.provider, model: w.model, params: w.params, keyService };
}
