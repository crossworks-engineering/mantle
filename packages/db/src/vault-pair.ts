/**
 * The run-time half of the vault key pairing rule (the whole rule is
 * @mantle/tools secret-ref-gate.ts). It
 * lives here, below @mantle/tools, so the model route resolvers
 * (@mantle/runtime resolveChatKey, @mantle/embeddings) answer to the same
 * check as connectors and API tools.
 */
import { loginHasArea } from './client';

/** The refusal at run time of a pairing whose configuring login lost the keys area. */
export const VAULT_PAIR_MAKER_NO_KEYS =
  "This connection's vault key does not resolve: the login that paired it with its host does not hold the keys area. Ask a user with the keys area to save the connection again.";

/**
 * Why a stored pairing (`carriesKey`) whose configuring login is `maker`
 * may not resolve its key now, or null: a maker other than the brain owner
 * that does not hold the keys area (any more). Null maker: the anchor's or
 * the system's, as before.
 */
export async function vaultPairRunRefusal(
  maker: string | null | undefined,
  ownerId: string,
  carriesKey: boolean,
): Promise<string | null> {
  if (!maker || maker === ownerId || !carriesKey) return null;
  return (await loginHasArea(maker, 'keys')) ? null : VAULT_PAIR_MAKER_NO_KEYS;
}
