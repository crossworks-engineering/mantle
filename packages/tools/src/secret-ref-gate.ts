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
