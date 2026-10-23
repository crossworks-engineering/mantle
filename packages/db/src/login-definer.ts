/**
 * One call of a definer that takes its login from the scope (the identity
 * gateway's scope login reader), never as an argument: an Admin act's
 * definer (migrations 0308, 0310) and the member turn ledger's (0325,
 * 0326). The one place such a call is made: one transaction on the system
 * pool in that login's scope (systemPoolTxInScope, which sets the scope by
 * hand), the runtime role's to run (RUNTIME_SYSTEM_FUNCTIONS; the write
 * role and the narrow role hold no EXECUTE on them).
 *
 *  - `admin`: the login's live workspaces in the scope (loginScopeFor); the
 *    definer asks inside whether that login is an Admin user with the Admin
 *    workspace in it (mantle_admin_act_brain). mantle.login_id stays unset,
 *    so no stamp or audit row names the login.
 *  - `own`: the login only, no workspaces (the ledger is the login's own).
 *
 * Its rules: the login is a uuid, compared without case; in a request or
 * turn whose bound actor is a login, it is that login (a request never acts
 * in another login's scope; a Telegram turn, system work, names its chat's
 * paired login, checked before); and the statement is one select of a
 * mantle_* function (a definer call), never a callback that could run
 * anything else in that scope.
 */
import type { SQL } from 'drizzle-orm';
import { RuntimeFaultError, UUID_RE } from '@mantle/std';
import { currentActor } from './actor';
import { loginScopeFor, systemPoolTxInScope } from './client';
import { getAdminDb } from './gateway/pools';

/** One select of a mantle_* function, one statement. */
const DEFINER_CALL = /^\s*select\b[^;]*?"?\bmantle_[a-z0-9_]+"?\s*\([^;]*$/is;

/** The SQL text of a drizzle query. */
function textOf(query: SQL): string {
  const admin = getAdminDb() as unknown as {
    dialect: { sqlToQuery: (q: unknown) => { sql: string } };
  };
  return admin.dialect.sqlToQuery(query).sql;
}

export type LoginDefinerScope = 'admin' | 'own';

/** Run one definer call `query` in `loginId`'s scope (see the file
 *  comment) and answer its rows. */
export async function loginDefinerCall<R>(
  loginId: string,
  scope: LoginDefinerScope,
  query: SQL,
): Promise<R[]> {
  if (!UUID_RE.test(loginId)) throw new Error('loginDefinerCall: the login is no uuid');
  const login = loginId.toLowerCase();
  const actor = currentActor();
  if (actor?.kind === 'login' && actor.loginId.toLowerCase() !== login) {
    throw new RuntimeFaultError("loginDefinerCall: the login is not the request's own");
  }
  if (!DEFINER_CALL.test(textOf(query))) {
    throw new RuntimeFaultError('loginDefinerCall: only one select of a mantle_* definer');
  }
  const ws =
    scope === 'admin'
      ? await loginScopeFor(login)
      : { ws: null as readonly string[] | null, modWs: null as readonly string[] | null };
  return systemPoolTxInScope(
    { loginId: login, ws: ws.ws, modWs: ws.modWs },
    async (tx) => (await tx.execute(query)) as unknown as R[],
  );
}
