/**
 * The vault namespace MCP connectors seal their OAuth state under (service =
 * the connector's `mcp-<slug>` group slug). RESERVED: these rows hold live
 * bearer tokens and sometimes a registration client_secret nobody ever typed
 * in, so they must never be usable as `{{secret:…}}` template refs, listed by
 * `api_key_refs`, probed/shown as ordinary keys, or named as a binding's
 * `secret_ref`. Enforced in the dispatcher, `api_key_refs`, the keys API,
 * `parseMcpBinding` (@mantle/tools integration-meta.ts), and the vault's
 * write gateway (@mantle/api-keys vault.ts), which refuses the namespace on
 * every write. One definition, here, for both packages.
 */
export const MCP_VAULT_SERVICE_PREFIX = 'mcp-';
export function isMcpManagedSecretService(service: string): boolean {
  return service.startsWith(MCP_VAULT_SERVICE_PREFIX);
}
