/**
 * The transaction the member turn ledger's definers run in (migration
 * 0325, plan v3.2 S7b part b2 round 14d). The ledger is written only by
 * mantle_member_turn_claim and mantle_member_turn_release, which take the
 * login from the identity gateway (mantle_scope_login_id), never as an
 * argument. This opens one transaction on the system pool in that login's
 * scope (systemPoolTxInScope: the login in mantle.scope_login, no
 * workspaces), as adminActTx does for an Admin act's definer: the runtime
 * role runs the definers (RUNTIME_SYSTEM_FUNCTIONS), the narrow role and
 * the write role may not.
 *
 * In a request or turn that names its login (the bound actor is a login),
 * `loginId` must be that login: a member's chat request claims only its own
 * slot. A Telegram turn (system work, no login actor) names the chat's
 * paired login, which the turn checked before it claims.
 *
 * Nothing else runs in it: `fn` calls a definer and reads its answer.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { RuntimeFaultError, UUID_RE } from '@mantle/std';
import { currentActor } from './actor';
import { systemPoolTxInScope } from './client';
import type * as schema from './schema/index';

export function memberTurnTx<T>(
  loginId: string,
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(loginId)) throw new Error('memberTurnTx: the login is no uuid');
  const actor = currentActor();
  if (actor?.kind === 'login' && actor.loginId.toLowerCase() !== loginId.toLowerCase()) {
    throw new RuntimeFaultError("memberTurnTx: the login is not the request's own");
  }
  return systemPoolTxInScope({ loginId: loginId.toLowerCase(), ws: null, modWs: null }, fn);
}
