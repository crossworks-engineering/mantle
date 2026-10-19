/**
 * The login (plan v3.2 section 2.2): who a request's credential is, and
 * nothing it may do. It carries no role and no kind; whether it is an
 * Admin user, and which Admin areas it holds, is adminFacts(login), asked
 * of its scope.
 */
import { sql } from 'drizzle-orm';
import { currentScope, db, loginAreas, SCOPE_AREAS, type ScopeArea } from '@mantle/db';
import { getRequestContext } from '../../server/request-context';
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

/** One answer per request and login (per login object outside a request),
 *  told apart by whether it was asked in the login's scope. */
const memo = new WeakMap<object, Map<string, Promise<AdminFacts>>>();

/**
 * Whether `login` is an Admin user now and which Admin areas it holds,
 * asked once per request.
 *
 * In a scope for the login's own login: one SQL round trip, the scope's
 * own answers (mantle_scope_is_admin: the scope holds the live Admin
 * workspace; mantle_scope_has_area for each area). With no scope open (a
 * route about the login itself that stays on the system pool: sign out,
 * change password, OAuth consent): the login row's answer, and the areas
 * of the area rule (mantle_login_areas) when it is one. A scope for
 * another login, or for none, throws: an ask about another login is
 * loginHasArea's.
 *
 * Either way `admin` also needs the row's Admin pair (loginAdminPair: role
 * admin AND a user of Admin), a transition while the role column can still
 * differ from Admin membership; areas count only when `admin` is true.
 * Fails closed: an error answers no.
 */
export function adminFacts(login: Login): Promise<AdminFacts> {
  const scope = currentScope();
  const scoped = scope.kind !== 'system';
  if (scoped && (scope.kind !== 'user' || scope.loginId !== login.loginId.toLowerCase())) {
    return Promise.reject(
      new Error(`adminFacts: asked for login ${login.loginId} in a scope for another login`),
    );
  }
  const holder: object = getRequestContext() ?? login;
  let byLogin = memo.get(holder);
  if (!byLogin) memo.set(holder, (byLogin = new Map()));
  const key = `${login.loginId.toLowerCase()}:${scoped ? 'scope' : 'row'}`;
  let p = byLogin.get(key);
  if (!p) {
    p = (scoped ? scopeFacts(login) : rowFacts(login)).catch(() => NONE);
    byLogin.set(key, p);
  }
  return p;
}

/** The scope's answers, in one statement. */
async function scopeFacts(login: Login): Promise<AdminFacts> {
  if (!loginAdminPair(login)) return NONE;
  const areas = sql.join(
    SCOPE_AREAS.map((a) => sql`${a}`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    select "public"."mantle_scope_is_admin"() as admin,
           coalesce((select array_agg(t.a order by t.o)
                       from unnest(array[${areas}]::text[]) with ordinality as t(a, o)
                      where "public"."mantle_scope_has_area"(t.a)), '{}'::text[]) as areas`)) as unknown as {
    admin: boolean;
    areas: ScopeArea[] | null;
  }[];
  const r = rows[0];
  if (r?.admin !== true) return NONE;
  return { admin: true, areas: new Set(r.areas ?? []) };
}

/** The row's answer, with no scope open. */
async function rowFacts(login: Login): Promise<AdminFacts> {
  if (!loginAdminPair(login)) return NONE;
  return { admin: true, areas: new Set(await loginAreas(login.loginId)) };
}
