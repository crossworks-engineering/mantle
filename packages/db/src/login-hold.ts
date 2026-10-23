/**
 * A login's disable or session end on a narrow exit (migration 0327): the
 * narrow login may not move the owner's or an Admin user's disabled_at or
 * session_epoch, nor revoke their keys, tokens and devices, nor remove
 * their OAuth codes or an MCP client a live grant of theirs rides on, so
 * such a write runs at the spot login-credential.
 */
import { clientHeldFromNarrow, loginHeldFromNarrow } from './gateway/scope-answers';
import { onFullSystemRoute } from './viewer';

/**
 * Run `write` (a login's disable or session end: auth.users disabled_at or
 * session_epoch; a revoke of its key, token or device; a delete of its
 * OAuth code, unclaimed pairing code or push device; a peer taken off
 * acting as it) at the spot login-credential when the exit's route is the
 * narrow one and a login it touches is held from the narrow login (the
 * owner or an Admin user: 0327's and 0328's hold, loginHeldFromNarrow),
 * else as it is. Read on the route the exit picked, not the switch, so
 * with the switch off the same write is at the spot and the would-refuse
 * count does not see it. The decision is onFullSystemRoute's own (its
 * `when`): one rule for every hold.
 */
export function onLoginHoldSpot<T>(
  who:
    | string
    | readonly string[]
    | { client: string }
    | { logins: () => PromiseLike<readonly string[]> },
  write: () => PromiseLike<T>,
): Promise<T> {
  // A login; the logins a write touches (any held one takes the spot), or
  // a lookup of them (`{ logins }`: run only on the narrow route, so a
  // write elsewhere pays no read); or an MCP client (`{ client }`: its
  // removal cascades to its tokens and codes, held when a live grant of a
  // held login rides on it, clientHeldFromNarrow).
  const held = async () => {
    if (typeof who === 'string') return loginHeldFromNarrow(who);
    if ('client' in who) return clientHeldFromNarrow(who.client);
    const ids = 'logins' in who ? await who.logins() : who;
    for (const id of new Set(ids)) if (await loginHeldFromNarrow(id)) return true;
    return false;
  };
  return onFullSystemRoute('login-credential', write, held);
}
