/**
 * The transaction an Admin act's definer runs in (workspaces arch plan
 * v3.2, "Admin acts become definers"; migrations 0308, 0310). An Admin
 * act's request runs in the login's scope since S6 c3 (on the system pool
 * with no scope in c1 and c2), but the definers are the runtime role's to
 * run (RUNTIME_SYSTEM_FUNCTIONS; the write role holds no EXECUTE on them).
 * This opens one transaction on the system pool in the login's scope
 * (systemPoolTxInScope, the one place that sets it by hand): its live
 * workspaces (loginScopeFor) and the login in mantle.scope_login, which only
 * the scope's checks read (mantle_scope_login_id, 0291); mantle.login_id
 * stays unset, so no stamp or audit row names the login. The definer then
 * asks, inside, whether that login is an Admin user with the Admin
 * workspace in the scope (mantle_admin_act_brain, 0308).
 *
 * Nothing else runs in it: `fn` calls the definer and reads its answer.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { RuntimeFaultError, UUID_RE } from '@mantle/std';
import { currentActor } from './actor';
import { loginScopeFor, systemPoolTxInScope } from './client';
import type * as schema from './schema/index';

/** Run `fn` in one transaction in `loginId`'s scope, for an Admin act's
 *  definer (see the file comment). In a request that names its login (the
 *  bound actor is a login), `loginId` must be that login: the scope is
 *  never another login's. */
export async function adminActTx<T>(
  loginId: string,
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(loginId)) throw new Error('adminActTx: the login is no uuid');
  const actor = currentActor();
  if (actor?.kind === 'login' && actor.loginId !== loginId) {
    throw new RuntimeFaultError("adminActTx: the login is not the request's own");
  }
  const scope = await loginScopeFor(loginId);
  return systemPoolTxInScope({ loginId, ws: scope.ws, modWs: scope.modWs }, fn);
}
