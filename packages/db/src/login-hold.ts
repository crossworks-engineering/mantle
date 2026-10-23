/**
 * A login's disable or session end on a narrow exit (migration 0326): the
 * narrow login may not move the owner's or an Admin user's disabled_at or
 * session_epoch, so such a write runs at the spot login-credential.
 */
import { loginHeldFromNarrow } from './gateway/scope-answers';
import { onFullSystemRoute, systemRouteNow } from './viewer';

/**
 * Run `write` (a login's disable or session end: auth.users disabled_at or
 * session_epoch) at the spot login-credential when the exit's route is the
 * narrow one and the login is held from the narrow login (the owner or an
 * Admin user: 0326's hold, loginHeldFromNarrow), else as it is. Read on the
 * route the exit picked, not the switch, so with the switch off the same
 * write is at the spot and the would-refuse count does not see it.
 */
export async function onLoginHoldSpot<T>(loginId: string, write: () => PromiseLike<T>): Promise<T> {
  if (systemRouteNow() !== 'narrow' || !(await loginHeldFromNarrow(loginId))) return await write();
  return onFullSystemRoute('login-credential', write);
}
