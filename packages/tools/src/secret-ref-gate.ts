/**
 * Who may point the key vault at a host (workspaces W7a fix round 3).
 *
 * An http tool's templates may carry `{{secret:service/label}}` refs and an
 * `{{oauth:<group>}}` ref, which the dispatcher decrypts from the API-key
 * vault and sends to the tool's URL (or, for OAuth, the group's token URL).
 * So whoever writes such a template can send any key in the vault to any
 * host: that is the keys area's, not the connectors area's. In a workspace
 * scope:
 *
 *  - creating, updating or testing a tool whose templates carry such a ref
 *    needs the caller to hold the keys area (secretRefsWriteRefusal); the
 *    Tools routes ask the same of the signed-in login;
 *  - a tool records the login that wrote its templates when that is not the
 *    brain owner (tools.created_by, toolMaker), and at run time its refs
 *    resolve only while that login holds the keys area
 *    (secretRefsRunRefusal), whoever runs the tool.
 *
 * The brain owner's tools (no maker) and system work are as before.
 */
import { loginHasArea, type ToolHandler } from '@mantle/db';
import { callerHasArea, callerScope } from './admin-gate';
import { collectOauthRefs, collectSecretRefs, type HttpHandler } from './http-template';

/** The refusal of a secret-carrying tool write or test without the keys area. */
export const SECRET_REFS_NEED_KEYS =
  "This tool's templates carry {{secret:...}} or {{oauth:...}} refs, which send keys from the API-key vault to the tool's host: writing or testing such a tool needs the keys area, and this login does not hold it. Leave the refs out, or ask a user with the keys area to add them.";

/** The refusal at run time of a tool whose maker does not hold the keys area. */
export const SECRET_REFS_MAKER_NO_KEYS =
  "This tool's {{secret:...}} or {{oauth:...}} refs do not resolve: the login that wrote its templates does not hold the keys area. Ask a user with the keys area to save the tool again (api_tool_update), or remove the refs.";

/** Whether handler `h` is an http handler whose templates carry a vault ref. */
export function handlerCarriesSecretRefs(h: ToolHandler): boolean {
  if (h.kind !== 'http') return false;
  return collectSecretRefs(h).length > 0 || collectOauthRefs(h).length > 0;
}

/** Why the current caller may not write or test handler `h`, or null. */
export async function secretRefsWriteRefusal(h: ToolHandler): Promise<string | null> {
  if (!handlerCarriesSecretRefs(h)) return null;
  return (await callerHasArea('keys')) ? null : SECRET_REFS_NEED_KEYS;
}

/** The login to record as a tool's maker: the current caller's login in a
 *  workspace scope, unless it is the brain owner (`ownerId`); else null. */
export function toolMaker(ownerId: string): string | null {
  const login = callerScope()?.loginId ?? null;
  return login && login !== ownerId ? login : null;
}

/**
 * The maker of a tool authored into an integration group (W7a fix round 4):
 * the writer (`writer`, null for the anchor) when it is not the anchor;
 * else, when the stored handler carries a vault ref the group's template
 * may have put there, the login that configured the group
 * (tool_groups.configured_by), so the run-time check answers to it.
 */
export function inheritedToolMaker(
  writer: string | null,
  group: { configuredBy?: string | null } | null | undefined,
  h: ToolHandler,
): string | null {
  if (writer) return writer;
  return group?.configuredBy && handlerCarriesSecretRefs(h) ? group.configuredBy : null;
}

/**
 * Why tool `tool` (handler `h`) may not resolve its vault refs now, or null:
 * a maker other than the brain owner that does not hold the keys area (any
 * more). Asked whoever runs the tool, on the system pool.
 */
export async function secretRefsRunRefusal(
  tool: { createdBy?: string | null } | undefined,
  h: HttpHandler,
  ownerId: string,
): Promise<string | null> {
  const maker = tool?.createdBy ?? null;
  if (!maker || maker === ownerId || !handlerCarriesSecretRefs(h)) return null;
  return (await loginHasArea(maker, 'keys')) ? null : SECRET_REFS_MAKER_NO_KEYS;
}

/**
 * A vault key paired with a destination (W7a fix round 4). One rule for
 * every place that sends a key from the API-key vault to a host it names: a
 * {{secret:...}} or {{oauth:...}} ref, a group's or connector's secretRef,
 * an OAuth2 group's client credentials, or a model route's key id (the KEY
 * side), and a base URL, a URL or a token URL (the DESTINATION side).
 *
 *  - Setting or changing either side while the other is present needs the
 *    keys area, or the anchor login (vaultPairingChanged, then
 *    vaultPairLoginRefusal for a route's signed-in login, or
 *    vaultPairCallerRefusal for a tool call in a scope).
 *  - Where the pair is stored, it records the login that set it when that
 *    is not the anchor (tools.created_by, tool_groups.configured_by), and at
 *    run time the key resolves only while that login holds the keys area
 *    (vaultPairRunRefusal; for http tools secretRefsRunRefusal above).
 *
 * `key` and `dest` are canonical strings: '' means none.
 */
export type VaultPairing = { key: string; dest: string };

/** The refusal of a key-to-host pairing change without the keys area. */
export const VAULT_PAIR_NEEDS_KEYS =
  'This pairs a key from the API-key vault (a {{secret:...}} or {{oauth:...}} ref, a secret ref or a key id) with the host it is sent to: setting or changing either side while the other is present needs the keys area, and this login does not hold it. Leave the key or the host as it is, or ask a user with the keys area to make this change.';

/** The refusal at run time of a pairing whose configuring login lost the keys area. */
export const VAULT_PAIR_MAKER_NO_KEYS =
  "This connection's vault key does not resolve: the login that paired it with its host does not hold the keys area. Ask a user with the keys area to save the connection again.";

/** The vault refs (sorted, distinct) in an auth template's headers and query. */
export function templateVaultRefs(
  t: { headers?: Record<string, string>; query?: Record<string, string> } | null | undefined,
): string[] {
  if (!t) return [];
  const h = {
    kind: 'http',
    url: '',
    method: 'GET',
    headers: t.headers ?? {},
    query: t.query ?? {},
  } as HttpHandler;
  const refs = [
    ...collectSecretRefs(h).map((r) => `secret:${r.service}/${r.label}`),
    ...collectOauthRefs(h).map((s) => `oauth:${s}`),
  ];
  return [...new Set(refs)].sort();
}

/** The integration fields the pairing reads (ToolGroupIntegration's shape). */
type IntegrationLike = {
  baseUrl?: string;
  secretRef?: string;
  authTemplate?: { headers?: Record<string, string>; query?: Record<string, string> };
  oauth2?: { tokenUrl?: string; clientIdRef?: string; clientSecretRef?: string };
  openapi?: { specUrl?: string };
};

/**
 * The key and destination of a tool group's integration: its secretRef, the
 * vault refs of its auth template and its OAuth2 credentials, sent to its
 * base URL and its OAuth2 token URL. An OpenAPI connector without a base URL
 * adopts the spec's server, so its spec URL stands for the host. An MCP
 * connector's binding is mcpPairing.
 */
export function integrationPairing(i: IntegrationLike | null | undefined): VaultPairing {
  if (!i) return { key: '', dest: '' };
  const keys = [
    ...(i.secretRef ? [`ref:${i.secretRef}`] : []),
    ...templateVaultRefs(i.authTemplate),
    ...(i.oauth2 ? [`oauth2:${i.oauth2.clientIdRef ?? ''}|${i.oauth2.clientSecretRef ?? ''}`] : []),
  ];
  const dests = [
    i.baseUrl ?? (i.openapi?.specUrl ? `spec:${i.openapi.specUrl}` : ''),
    i.oauth2?.tokenUrl ?? '',
  ];
  return {
    key: keys.length > 0 ? JSON.stringify(keys) : '',
    dest: dests.some(Boolean) ? JSON.stringify(dests) : '',
  };
}

/**
 * The key and destination of an MCP connector's binding: its secretRef, sent
 * to its URL. `withOauth`: an OAuth connector's tokens count as a key too (a
 * URL change sends them elsewhere). The authorization itself pairs a token
 * with the URL it was minted for, so creating an OAuth connector and the run
 * time check leave them out.
 */
export function mcpPairing(
  mcp: { url?: string; secretRef?: string; oauth?: { enabled?: boolean } } | null | undefined,
  withOauth = false,
): VaultPairing {
  if (!mcp) return { key: '', dest: '' };
  const key = mcp.secretRef
    ? `ref:${mcp.secretRef}`
    : withOauth && mcp.oauth?.enabled
      ? 'oauth'
      : '';
  return { key, dest: mcp.url ?? '' };
}

/** Whether going from `before` (null: nothing stored yet) to `after` sets
 *  or changes a key-to-host pairing: `after` carries a key, and its key or
 *  its destination differs from `before`'s. */
export function vaultPairingChanged(before: VaultPairing | null, after: VaultPairing): boolean {
  if (!after.key) return false;
  return !before || before.key !== after.key || before.dest !== after.dest;
}

/** Why login `login` may not make a pairing change, or null. Null `login`:
 *  the anchor login or system work, which always may. */
export async function vaultPairLoginRefusal(login: string | null): Promise<string | null> {
  if (!login) return null;
  return (await loginHasArea(login, 'keys')) ? null : VAULT_PAIR_NEEDS_KEYS;
}

/** Why the current tool caller may not make a pairing change, or null. */
export async function vaultPairCallerRefusal(): Promise<string | null> {
  return (await callerHasArea('keys')) ? null : VAULT_PAIR_NEEDS_KEYS;
}

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
