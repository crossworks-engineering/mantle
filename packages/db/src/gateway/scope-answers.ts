/**
 * The scope and login answers: thin SQL calls that ask the database one
 * fact now (does this scope hold Admin or an area, does a login, which
 * Admin areas, which Moderator seats), and loginActorNow, the actor bound
 * for deferred work done for a login, read as that login is now.
 */
import { sql as sqlTag } from 'drizzle-orm';
import { errorMessage, UUID_RE } from '@mantle/std';
import {
  currentScope,
  currentWorkspaceScope,
  isUnscoped,
  SCOPE_AREAS,
  SystemWorkRequiredError,
  type ScopeArea,
  type WorkspaceScope,
} from '../viewer';
import {
  actorCheckMode,
  currentActor,
  loginActor,
  runAsSystem,
  systemActor,
  type Actor,
} from '../actor';
import { getAdminDb } from './pools';
import { getDb } from './scope';
import { db } from './handles';
import { sqlState } from './heads';

/**
 * login(rw | owner) for `loginId`, read as that login is NOW: deferred work
 * done for a login (a run, a heartbeat, a pending call, a turn) binds this
 * when it runs, not what the login was when the work was queued. This
 * refuses nothing: a login disabled since (or gone) is still
 * bound and named in one warning. `entry` is the system reason of the entry
 * asking (worker:runs); a bad id gives system(entry).
 */
export async function loginActorNow(
  loginId: string,
  entry: string,
  mode: 'rw' | 'owner' = 'rw',
): Promise<Actor> {
  let actor: Actor;
  try {
    actor = loginActor(loginId, mode);
  } catch {
    return systemActor(entry);
  }
  // With the check off nothing reads the actor: no query (no new query on
  // a hot path while off).
  if (actorCheckMode() === 'off') return actor;
  try {
    const rows = (await runAsSystem(entry, () =>
      getAdminDb().execute(
        // The actor's own lookup: tagged (ACTOR_SQL_TAG).
        sqlTag`/* mantle:actor */ select disabled_at is not null as off from auth.users where id = ${loginId}::uuid`,
      ),
    )) as unknown as { off: boolean }[];
    if (!rows[0] || rows[0].off) {
      console.warn(`[${entry}] login ${loginId} is disabled now; the work runs as it anyway (A2a)`);
    }
  } catch (err) {
    console.warn(`[${entry}] could not read login ${loginId}: ${errorMessage(err)}`);
  }
  return actor;
}

const holdsAdmin = new WeakMap<WorkspaceScope, Promise<boolean>>();

/** The yes given outside every workspace scope, for system work only: with no system actor bound it throws. */
function systemYes(what: string): true {
  if (currentActor()?.kind !== 'system') throw new SystemWorkRequiredError(what);
  return true;
}

/**
 * Whether the current code may do Admin-workspace work (adminOnly):
 * unscoped system work (the owner's paths) yes; a workspace scope when it holds
 * the Admin workspace (asked of the database once per scope). Fails closed:
 * an error reads as no. Unscoped with no system actor bound it throws
 * (SystemWorkRequiredError).
 */
export async function scopeHoldsAdmin(): Promise<boolean> {
  const scope = currentWorkspaceScope();
  if (!scope) return isUnscoped() && systemYes('scopeHoldsAdmin outside every scope');
  let p = holdsAdmin.get(scope);
  if (!p) {
    p = (async () => {
      try {
        const rows = (await getDb().execute(
          sqlTag`select "public"."mantle_scope_is_admin"() as a`,
        )) as unknown as { a: boolean }[];
        return rows[0]?.a === true;
      } catch {
        return false;
      }
    })();
    holdsAdmin.set(scope, p);
  }
  return p;
}

/**
 * Whether the current code may do an "Admin only" thing in `area`: system
 * work may; a user scope may when it holds the Admin workspace,
 * its login is a user there and its limits leave the area on
 * (mantle_scope_has_area, the rule of areasFor); so may an assistant turn
 * that answers such a login (the Admin assistant, which answers the
 * owner when no login asks). A link and an assistant turn with no login
 * never may. An unknown kind or area is refused (fails
 * closed). Outside every scope with no system actor bound it throws
 * (SystemWorkRequiredError).
 */
export async function scopeHasArea(area: ScopeArea): Promise<boolean> {
  if (!SCOPE_AREAS.includes(area)) return false;
  const scope = currentScope();
  switch (scope.kind) {
    case 'system':
      return systemYes(`scopeHasArea(${area}) outside every scope`);
    case 'user':
    case 'assistant': {
      if (!scope.loginId) return false;
      try {
        const rows = (await getDb().execute(
          sqlTag`select "public"."mantle_scope_has_area"(${area}) as a`,
        )) as unknown as { a: boolean }[];
        return rows[0]?.a === true;
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

/** A login fact refused for a missing grant (42501) still answers no, but
 *  says so once per process: a lost EXECUTE grant shows in the log. */
let loginFactDeniedLogged = false;
function loginFactFailed(err: unknown): false {
  if (!loginFactDeniedLogged && sqlState(err) === '42501') {
    loginFactDeniedLogged = true;
    console.warn(`[db] a login fact was refused (42501), it answers no: ${errorMessage(err)}`);
  }
  return false;
}

/**
 * Whether the narrow login may not change `loginId`'s disabled_at or
 * session_epoch (0327's hold): the owner, an admin by role, or a user of the
 * Admin workspace, disabled or not (mantle_narrow_login_held, the same
 * definer the hold asks). A disable or a session end of such a login runs
 * at the spot login-credential. Asked on the system pool; on a failure it
 * answers yes, so the write takes the spot (never a refusal).
 */
export async function loginHeldFromNarrow(loginId: string): Promise<boolean> {
  if (!UUID_RE.test(loginId)) return true;
  try {
    const rows = (await getAdminDb().execute(
      sqlTag`select "public"."mantle_narrow_login_held"(${loginId}::uuid) as h`,
    )) as unknown as { h: boolean }[];
    return rows[0]?.h !== false;
  } catch {
    return true;
  }
}

/**
 * Whether removing the MCP client `clientId` would end a live grant of a
 * login held from the narrow login (0327's hold on grants,
 * mantle_narrow_client_held: the delete cascades to its tokens and codes).
 * Such a removal runs at the spot login-credential. On a failure it
 * answers yes, so the write takes the spot (never a refusal).
 */
export async function clientHeldFromNarrow(clientId: string): Promise<boolean> {
  if (!UUID_RE.test(clientId)) return true;
  try {
    const rows = (await getAdminDb().execute(
      sqlTag`select "public"."mantle_narrow_client_held"(${clientId}::uuid) as h`,
    )) as unknown as { h: boolean }[];
    return rows[0]?.h !== false;
  } catch {
    return true;
  }
}

/**
 * Whether `loginId` is a user of this brain's live Admin workspace now, its
 * login enabled, never the admin role alone (a
 * login taken out of Admin keeps its role): mantle_login_is_admin (0304).
 * Fails closed. Admin pool.
 */
export async function loginHoldsAdmin(loginId: string): Promise<boolean> {
  if (!UUID_RE.test(loginId)) return false;
  try {
    const rows = (await getAdminDb().execute(
      sqlTag`select "public"."mantle_login_is_admin"(${loginId}::uuid) as a`,
    )) as unknown as { a: boolean }[];
    return rows[0]?.a === true;
  } catch (err) {
    return loginFactFailed(err);
  }
}

/**
 * Whether login `loginId` holds Admin `area` now, asked on the system pool
 * for a login other than the current caller (the maker of an API tool,
 * when the tool's secret refs resolve at run time): the area
 * rule, mantle_area_rule (0304). Fails closed.
 */
export async function loginHasArea(loginId: string, area: ScopeArea): Promise<boolean> {
  if (!SCOPE_AREAS.includes(area) || !UUID_RE.test(loginId)) return false;
  try {
    const rows = (await getAdminDb().execute(
      sqlTag`select "public"."mantle_area_rule"(${loginId}::uuid, ${area}) as a`,
    )) as unknown as { a: boolean }[];
    return rows[0]?.a === true;
  } catch (err) {
    return loginFactFailed(err);
  }
}

/** The Admin areas `loginId` holds now, in SCOPE_AREAS order (mantle_login_areas,
 *  0304: the strict rule), on the system pool as loginHasArea. Fails closed. */
export async function loginAreas(loginId: string): Promise<ScopeArea[]> {
  if (!UUID_RE.test(loginId)) return [];
  try {
    const rows = (await getAdminDb().execute(
      sqlTag`select "public"."mantle_login_areas"(${loginId}::uuid) as a`,
    )) as unknown as { a: ScopeArea[] | null }[];
    return rows[0]?.a ?? [];
  } catch (err) {
    loginFactFailed(err);
    return [];
  }
}

/**
 * Which of `wsIds` `loginId` holds a Moderator seat in now, for a turn's
 * write (@mantle/tools moderator-seat.ts): one indexed
 * read of workspace_users, in the turn's scope (its seats are in its ws).
 */
export async function moderatorSeatsNow(
  loginId: string,
  wsIds: readonly string[],
): Promise<string[]> {
  if (!UUID_RE.test(loginId) || wsIds.length === 0) return [];
  if (!wsIds.every((w) => UUID_RE.test(w))) return [];
  const rows = (await db.execute(sqlTag`
    select workspace_id::text as ws from workspace_users
     where login_id = ${loginId}::uuid and moderator
       and workspace_id = any(${`{${wsIds.join(',')}}`}::uuid[])`)) as unknown as { ws: string }[];
  return rows.map((r) => r.ws);
}
