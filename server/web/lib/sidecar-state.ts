/**
 * How the Sync sidecar's state values are sealed (service_state, 0380): JSON
 * under the master key, with the AAD `sync:<key>`, so a value cannot be
 * moved to another key. Pure: the sidecar routes (lib/sidecar.ts) and the
 * copy task (scripts/sync-copy-accounts.ts) share it.
 */
import { openJSON, sealJSON } from '@mantle/crypto';

/** The service every sidecar state value belongs to (one today). */
export const SIDECAR_SERVICE = 'sync';

const aad = (key: string) => `${SIDECAR_SERVICE}:${key}`;

/** Seal a state value for storage. */
export function sealState(key: string, value: unknown): Buffer {
  return sealJSON(value, aad(key)).ciphertext;
}

/** Open a stored state value. */
export function openState(key: string, sealed: Buffer): unknown {
  return openJSON(sealed, aad(key));
}
