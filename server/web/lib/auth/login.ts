/**
 * The login (plan v3.2 section 2.2): who a request's credential is, and
 * nothing it may do. It carries no role and no kind; whether it is an
 * Admin user, and which Admin areas it holds, is adminFacts(login), asked
 * of its scope.
 */
import { sql } from 'drizzle-orm';
import {
  currentScope,
  currentWorkspaceScope,
  db,
  loginAreas,
  SCOPE_AREAS,
  type ScopeArea,
  type WorkspaceScope,
} from '@mantle/db';
import { errorMessage } from '@mantle/std';
import { log } from '@mantle/tracing';
import { loginAdminPair, type Actor, type AuthSource } from './session';

/** A signed-in login. `brainId` is the brain's anchor login (whose data);
 *  `actor` is the login itself (who acts, what the audit trail names). */
export type Login = {
  readonly loginId: string;
  readonly brainId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly contactId: string | null;
  readonly source: AuthSource;
  readonly sessionEpoch: number;
  readonly actor: Actor;
};

/** Whether a login is an Admin user now, and the Admin areas it holds
 *  (none unless it is one). */
export type AdminFacts = { readonly admin: boolean; readonly areas: ReadonlySet<ScopeArea> };

const NONE: AdminFacts = Object.freeze({
  admin: false,
  areas: Object.freeze(new Set<ScopeArea>()),
});
const NO: Promise<AdminFacts> = Promise.resolve(NONE);

/** What adminFacts asked of each Login: the row's answer (no scope open),
 *  and one answer per scope it was asked in (keyed on the scope itself, as
 *  scopeHoldsAdmin keys its own, so two scopes for one login never share
 *  one). Keyed on the very Login object: a copy, or the Login a later
 *  getLoginOr401 answers (a fresh find, after forgetRequestLogins), asks
 *  afresh. */
type Asked = { row?: Promise<AdminFacts>; scopes: WeakMap<WorkspaceScope, Promise<AdminFacts>> };
const memo = new WeakMap<Login, Asked>();

/**
 * Whether `login` is an Admin user now and which Admin areas it holds,
 * asked once per Login object and scope.
 *
 * In a scope for the login's own login: one SQL call,
 * mantle_scope_admin_facts (the scope holds the brain's live Admin
 * workspace AND the scope's login is an enabled user of it now; the areas
 * mantle_scope_has_area holds, only then). Membership decides, in SQL; the
 * role column is not asked (it follows membership). With no scope open (a
 * route about the login itself that stays on the system pool: sign out,
 * change password, OAuth consent): the login row's answer (a user of
 * Admin, loginAdminPair), and the areas of the area rule
 * (mantle_login_areas) when it is one. A scope for another login, or for
 * none, throws: an ask about another login is loginHasArea's.
 *
 * Either way the row read with the request's login must say a user of
 * Admin (loginAdminPair, membership only: the role is not asked), so a
 * member's ask costs no round trip; a Login getLoginOr401 did not answer
 * has none: no, before any memo. Fails closed: an error answers no.
 */
export function adminFacts(login: Login): Promise<AdminFacts> {
  const scope = currentScope();
  const ws = currentWorkspaceScope();
  if (
    scope.kind !== 'system' &&
    (scope.kind !== 'user' || !ws || scope.loginId !== login.loginId.toLowerCase())
  ) {
    return Promise.reject(
      new Error(`adminFacts: asked for login ${login.loginId} in a scope for another login`),
    );
  }
  if (!loginAdminPair(login)) return NO;
  let asked = memo.get(login);
  if (!asked) memo.set(login, (asked = { scopes: new WeakMap() }));
  if (!ws) return (asked.row ??= rowFacts(login).catch(() => NONE));
  let p = asked.scopes.get(ws);
  if (!p) {
    p = scopeFacts().catch((err: unknown) => {
      log('auth').warn(
        `adminFacts could not ask the scope of login ${login.loginId}, it answers no: ${errorMessage(err)}`,
      );
      return NONE;
    });
    asked.scopes.set(ws, p);
  }
  return p;
}

/** The scope's answers, in one statement: membership and the areas, in
 *  SQL (mantle_scope_admin_facts). */
async function scopeFacts(): Promise<AdminFacts> {
  const areas = sql.join(
    SCOPE_AREAS.map((a) => sql`${a}`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    select f.admin, f.held as areas
      from "public"."mantle_scope_admin_facts"(array[${areas}]::text[]) f`)) as unknown as {
    admin: boolean;
    areas: ScopeArea[] | null;
  }[];
  const r = rows[0];
  if (r?.admin !== true) return NONE;
  return { admin: true, areas: new Set(r.areas ?? []) };
}

/** The row's answer, with no scope open (the caller checked membership;
 *  loginAreas fails closed and logs a lost grant, loginFactFailed). */
async function rowFacts(login: Login): Promise<AdminFacts> {
  return { admin: true, areas: new Set(await loginAreas(login.loginId)) };
}
