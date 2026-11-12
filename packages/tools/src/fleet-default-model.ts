/**
 * The Control Center's Default Model (docs/control-center.md, "Default
 * Model"): a chat provider and one of this brain's keys for it, stored as a
 * BRAIN preference (`fleetDefaultModel`), so every admin and browser sees
 * the same choice. The Fleet screen lists that provider's models with that
 * key (GET /api/models?provider&keyId, the catalog the Models screen reads)
 * and every place there that picks a model picks from that list.
 *
 * One module for the route (/api/fleet/default-model) and the tools
 * (control_default_model_get / _set), so both check the same way. It reads
 * key rows only (id, service, name, label, the masked hint): no key is
 * decrypted here, and no key value is ever answered.
 */
import { listApiKeys, type ApiKeySummary } from '@mantle/api-keys';
import type {
  FleetDefaultModelChoice,
  FleetDefaultModelKey,
  FleetDefaultModelView,
  StoredFleetDefaultModel,
} from '@mantle/client-types';
import { loadPreferencesFor, projectFleetDefaultModel, savePreferencesFor } from '@mantle/content';
import { InputError, isUuid } from '@mantle/std';
import { providersForCapability } from '@mantle/voice-client';

/** A provider key: a token with no target (a host-bound secret is not one). */
function isProviderKey(k: ApiKeySummary): boolean {
  return k.kind === 'token' && k.target.length === 0;
}

function keyView(k: ApiKeySummary): FleetDefaultModelKey {
  return { id: k.id, name: k.name, label: k.label, masked: k.masked };
}

/** The chat providers this brain holds a provider key for, each with its
 *  keys, in the provider list's order (pure). */
export function defaultModelChoices(keys: readonly ApiKeySummary[]): FleetDefaultModelChoice[] {
  const out: FleetDefaultModelChoice[] = [];
  for (const p of providersForCapability('chat')) {
    const own = keys.filter((k) => k.service === p.id && isProviderKey(k));
    if (own.length === 0) continue;
    out.push({
      provider: p.id,
      providerName: p.label,
      keys: own.map(keyView).sort((a, b) => a.name.localeCompare(b.name)),
    });
  }
  return out;
}

/** The view of a stored choice against this brain's keys now (pure). */
export function defaultModelView(
  stored: StoredFleetDefaultModel | undefined,
  keys: readonly ApiKeySummary[],
): FleetDefaultModelView {
  const choices = defaultModelChoices(keys);
  if (!stored) {
    return { provider: null, providerName: null, key: null, problem: null, choices };
  }
  const providerName =
    providersForCapability('chat').find((p) => p.id === stored.provider)?.label ?? stored.provider;
  const key = choices
    .find((c) => c.provider === stored.provider)
    ?.keys.find((k) => k.id === stored.keyId);
  return {
    provider: stored.provider,
    providerName,
    key: key ?? null,
    problem: key ? null : 'key-missing',
    choices,
  };
}

/** Check a choice against this brain's keys (pure). Throws InputError with
 *  the reason a person can act on. */
export function checkDefaultModel(
  input: { provider: unknown; keyId: unknown },
  keys: readonly ApiKeySummary[],
): StoredFleetDefaultModel {
  const provider = typeof input.provider === 'string' ? input.provider.trim().toLowerCase() : '';
  const keyId = typeof input.keyId === 'string' ? input.keyId.trim().toLowerCase() : '';
  const chat = providersForCapability('chat').find((p) => p.id === provider);
  if (!chat) throw new InputError('provider must be a chat model provider, e.g. openrouter.');
  if (!isUuid(keyId)) throw new InputError('keyId must be the id of one of this brain’s keys.');
  const key = keys.find((k) => k.id === keyId);
  // Another owner's key and a missing one read the same.
  if (!key) throw new InputError('That API key was not found on this brain.');
  if (key.service !== provider || !isProviderKey(key)) {
    throw new InputError(`That key is not a provider key for ${provider}.`);
  }
  return { provider, keyId };
}

async function providerKeys(ownerId: string): Promise<ApiKeySummary[]> {
  return listApiKeys(ownerId);
}

/** The Default Model as the card and the tools show it. */
export async function readFleetDefaultModel(ownerId: string): Promise<FleetDefaultModelView> {
  const [prefs, keys] = await Promise.all([loadPreferencesFor(ownerId), providerKeys(ownerId)]);
  return defaultModelView(projectFleetDefaultModel(prefs.fleetDefaultModel), keys);
}

/** Set the Default Model (checked), or clear it with null. */
export async function setFleetDefaultModel(
  ownerId: string,
  input: { provider: unknown; keyId: unknown } | null,
): Promise<FleetDefaultModelView> {
  const keys = await providerKeys(ownerId);
  const stored = input === null ? null : checkDefaultModel(input, keys);
  const prefs = await savePreferencesFor(ownerId, { fleetDefaultModel: stored });
  return defaultModelView(projectFleetDefaultModel(prefs.fleetDefaultModel), keys);
}
