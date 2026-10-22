/**
 * The acting-login spot in one place (one helper for the five callers). The definers that need
 * the exit's acting login (mantle_structure_item, mantle_agent_delete,
 * mantle_tg_chat_set, mantle_ws_attach_assistants, mantle_ws_set_moderator)
 * refuse it on the narrow role, where the identity readers answer no login
 * (0321): each runs at the full-route spot acting-login, where the
 * gateway's own SET carries the login. In a login's own scope, or off a
 * narrow exit, `fn` runs as it is (onFullSystemRoute's own rule).
 *
 * `fn` gets the acting login (actingLoginNow at the spot, null when there
 * is none) and opens its own transaction: the system pool's, the caller's
 * scope's or the request's, as each definer needs.
 */
import { actingLoginNow, onFullSystemRoute } from '../viewer';

export function atActingLogin<T>(fn: (login: string | null) => Promise<T>): Promise<T> {
  return onFullSystemRoute('acting-login', () => fn(actingLoginNow()));
}
