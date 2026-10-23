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
 * Its rules: the login is a uuid, compared without case; it is the login
 * the call runs for wherever one is bound: a login actor's, the acting
 * login of the request's or turn's exit (an Admin area exit's system
 * actor), and the open scope's login (a Telegram turn, system work, runs
 * in its chat's paired login's scope). A request never acts in another
 * login's scope. And the statement is exactly one select of one mantle_*
 * function whose arguments are bound parameters only (a definer call):
 * no other call, table or clause beside it, never a callback that could
 * run anything else in that scope.
 */
import type { SQL } from 'drizzle-orm';
import { RuntimeFaultError, UUID_RE } from '@mantle/std';
import { currentActor } from './actor';
import { loginScopeFor, systemPoolTxInScope } from './client';
import { getAdminDb } from './gateway/pools';
import { actingLoginNow, currentWorkspaceScope } from './viewer';

/** A column the definer answers, optionally cast (`share_id::text`). */
const COL = String.raw`[a-z_][a-z0-9_]*(?:::[a-z_][a-z0-9_]*)?`;
/** An argument: a bound parameter, optionally cast (`$2::uuid[]`). */
const ARG = String.raw`\$[0-9]+(?:::[a-z_][a-z0-9_]*(?:\[\])?)?`;

/** Exactly one select of one mantle_* function, its arguments bound
 *  parameters only: `select [<cols> from] mantle_x($1, $2::uuid) [as n]`.
 *  Anything else beside it (another call, a table, a where) is refused. */
export const DEFINER_CALL = new RegExp(
  String.raw`^\s*select\s+(?:${COL}(?:\s*,\s*${COL})*\s+from\s+)?` +
    String.raw`(?:"?public"?\.)?"?mantle_[a-z0-9_]+"?\s*\(\s*(?:${ARG}(?:\s*,\s*${ARG})*)?\s*\)` +
    String.raw`(?:\s+as\s+[a-z_][a-z0-9_]*)?\s*$`,
  'i',
);

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
  const bound = [
    actor?.kind === 'login' ? actor.loginId : null,
    actingLoginNow(),
    currentWorkspaceScope()?.loginId ?? null,
  ];
  if (bound.some((b) => b !== null && b.toLowerCase() !== login)) {
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
