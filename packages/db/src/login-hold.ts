/**
 * A login's disable or session end on a narrow exit (migration 0326): the
 * narrow login may not move the owner's or an Admin user's disabled_at or
 * session_epoch, nor revoke their keys, tokens and devices, nor remove
 * their OAuth codes or an MCP client a live grant of theirs rides on, so
 * such a write runs at the spot login-credential.
 */
import { clientHeldFromNarrow, loginHeldFromNarrow } from './gateway/scope-answers';
import { onFullSystemRoute, systemRouteNow } from './viewer';

/**
 * Run `write` (a login's disable or session end: auth.users disabled_at or
 * session_epoch; a revoke of its key, token or device; a delete of its
 * OAuth code) at the spot login-credential when the exit's route is the
 * narrow one and the login is held from the narrow login (the owner or an
 * Admin user: 0326's hold, loginHeldFromNarrow), else as it is. Read on the
 * route the exit picked, not the switch, so with the switch off the same
 * write is at the spot and the would-refuse count does not see it.
 */
export async function onLoginHoldSpot<T>(loginId: string, write: () => PromiseLike<T>): Promise<T> {
  return atHoldSpot(() => loginHeldFromNarrow(loginId), write);
}

/** The one place the hold takes the spot: on the narrow route, when
 *  `held` says yes. */
async function atHoldSpot<T>(
  held: () => Promise<boolean>,
  write: () => PromiseLike<T>,
): Promise<T> {
  if (systemRouteNow() !== 'narrow' || !(await held())) return await write();
  return onFullSystemRoute('login-credential', write);
}

/**
 * Run `write` (an MCP client's removal: oauth_clients, cascading to its
 * tokens and codes) at the spot login-credential when the exit's route is
 * the narrow one and a live grant of a held login rides on the client
 * (clientHeldFromNarrow), else as it is.
 */
export async function onClientHoldSpot<T>(
  clientId: string,
  write: () => PromiseLike<T>,
): Promise<T> {
  if (systemRouteNow() !== 'narrow' || !(await clientHeldFromNarrow(clientId)))
    return await write();
  return onFullSystemRoute('login-credential', write);
}
