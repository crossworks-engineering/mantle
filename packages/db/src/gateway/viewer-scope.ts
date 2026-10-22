/**
 * The viewer scopes: withViewer (run for whoever `actsFor` names, in a
 * workspace scope), the scope it builds (viewerScopeFor, once per request:
 * memoScopeFor), a signed-in login's scope (loginScopeColumns,
 * seedLoginScope, loginScopeFor) and createHomeFallback, a login's private
 * create home.
 */
import { sql as sqlTag } from 'drizzle-orm';
import { type AnyPgColumn } from 'drizzle-orm/pg-core';
import { RuntimeFaultError, UUID_RE } from '@mantle/std';
import {
  boundLoginId,
  currentRequestMode,
  currentWorkspaceScope,
  requestScopeMemo,
  runInViewerScope,
  type AppRunFor,
  type ViewerFor,
  type WorkspaceScope,
} from '../viewer';
import { holderWorkspacesSql } from '../grant-reads';
import { liveWorkspaceSql } from '../workspace-live';
import { getAdminDb } from './pools';
import { ownPrivate } from './write-route';
import { systemPoolTxInScope } from './system-tx';

/**
 * The R6 shim (plan R6, S2, T4): run `fn` for whoever `actsFor` names, in a
 * WORKSPACE scope. A login reads the union of its
 * live workspaces (a disabled login: none); an assistant reads its own
 * workspace (none when it sits on no workspace); a public link reads no
 * workspace and carries its served list. Every query inside, after any
 * await, runs on the workspace role in its own short transaction that sets
 * the scope (as a turn scope does), so a long request holds no transaction.
 * Fails closed: an empty scope reads nothing.
 *
 * System work never comes through here: a caller that may run as the
 * system runs `fn` itself (the level argument that said so went in W8c).
 * Inside the same workspace scope it just runs `fn`; inside another one it
 * is refused, unless it narrows a request scope.
 *
 * `writes`: only a login running an app (`{ login, app }`), for a write its
 * app rule allowed (a team app's Table row write, @mantle/tools
 * member-app-tools.ts rule 6): the app's scope writes as that login, so the
 * database decides whether the login may (runInViewerScope). Any other
 * caller asking it is refused: an assistant, a link or a login's whole
 * union never write through here.
 */
export async function withViewer<T>(
  actsFor: ViewerFor,
  fn: () => Promise<T>,
  opts: { writes?: boolean } = {},
): Promise<T> {
  if (opts.writes) {
    if (!('login' in actsFor) || !actsFor.app) {
      throw new RuntimeFaultError('withViewer: only a login running an app writes through here');
    }
    return runInViewerScope(await memoScopeFor(actsFor), fn, { writes: true, drafts: false });
  }
  // Inside the request scope of this very login (W6a): that scope is the
  // one withViewer would build, read once by the session guard. No second
  // lookup per call (the W5b2 member search cost).
  const open = currentWorkspaceScope();
  if (
    'login' in actsFor &&
    !actsFor.app &&
    currentRequestMode() &&
    open?.kind === 'user' &&
    open.loginId === actsFor.login.toLowerCase()
  ) {
    return fn();
  }
  return runInViewerScope(await memoScopeFor(actsFor), fn);
}

/** viewerScopeFor, once per request for the same login (and app) or agent:
 *  workspace and membership changes take effect on the next request. */
function memoScopeFor(actsFor: ViewerFor): Promise<WorkspaceScope> {
  const memo = requestScopeMemo();
  const key =
    'login' in actsFor
      ? `login:${actsFor.login.toLowerCase()}:${actsFor.app ? JSON.stringify(actsFor.app) : ''}`
      : 'agent' in actsFor
        ? `agent:${actsFor.agent ?? ''}`
        : null;
  if (!memo || key === null) return viewerScopeFor(actsFor);
  let p = memo.get(key);
  if (!p) {
    p = viewerScopeFor(actsFor);
    // A failed lookup is not kept: the next call asks again.
    p.catch(() => memo.delete(key!));
    memo.set(key, p);
  }
  return p;
}

/**
 * The login's workspaces and Moderator ones, as SQL columns of a query on
 * auth.users (W6a fix round 1, the bench): the session's one login read
 * carries them, and seedLoginScope keeps them as this request's scope, so
 * the guard needs no second lookup. The same rule as viewerScopeFor: live
 * workspaces only, none for a disabled login. The login is a bound id, not
 * the outer column: drizzle writes a single-table query's columns without
 * their table, and a bare "id" in the subquery would be the workspace's.
 */
export function loginScopeColumns(loginId: string, disabledAt: AnyPgColumn) {
  return {
    scopeWs: sqlTag<string[]>`case when ${disabledAt} is null then coalesce((
        select array_agg(u.workspace_id::text order by u.workspace_id)
          from workspace_users u
          join workspaces w on w.id = u.workspace_id and ${liveWorkspaceSql('w')}
         where u.login_id = ${loginId}::uuid), '{}') else '{}' end`,
    scopeModWs: sqlTag<string[]>`case when ${disabledAt} is null then coalesce((
        select array_agg(u.workspace_id::text order by u.workspace_id)
          from workspace_users u
          join workspaces w on w.id = u.workspace_id and ${liveWorkspaceSql('w')}
         where u.login_id = ${loginId}::uuid and u.moderator), '{}') else '{}' end`,
  };
}

/** Keep a login's scope, read with its row (loginScopeColumns), as this
 *  request's: loginScopeFor and withViewer for that login reuse it. No-op
 *  outside a request, or when the request already looked it up. */
export function seedLoginScope(
  loginId: string,
  ws: readonly string[],
  modWs: readonly string[],
): void {
  const memo = requestScopeMemo();
  if (!memo || !UUID_RE.test(loginId)) return;
  const key = `login:${loginId.toLowerCase()}:`;
  if (memo.has(key)) return;
  memo.set(
    key,
    Promise.resolve(
      Object.freeze({
        kind: 'user' as const,
        loginId: loginId.toLowerCase(),
        ws: Object.freeze([...ws]),
        modWs: Object.freeze([...modWs]),
      }),
    ),
  );
}

/**
 * The scope the session guard enters for a signed-in login (W6a): the
 * union of its live workspaces, Moderator where it is one (a disabled
 * login: none). The same scope `withViewer({ login }, …)` builds.
 */
export async function loginScopeFor(loginId: string): Promise<WorkspaceScope> {
  return memoScopeFor({ login: loginId });
}

/**
 * The fallback of a login's create home (docs/workspaces.md, "Where a new
 * item lands"; W6b): for a login outside the Admin workspace (`ownWork`;
 * 'auto' asks the database) its private workspace, made now when
 * `makePrivate` and it has none; with no workspace to make one in,
 * refused. An Admin user has no private fallback (null): the folder's home,
 * else Admin. Only createHomeIntent (create-home.ts, the one create-home
 * intent of arch A3c) calls it; not exported from the package.
 *
 * Admin pool: it names a place, it grants nothing (the database's create
 * checks still run).
 */
export async function createHomeFallback(
  loginId: string,
  o: { ownWork: boolean | 'auto'; makePrivate: boolean },
): Promise<{ privateWs: string | null } | { refused: 'no-workspace'; message: string }> {
  const admin = getAdminDb();
  const ownWork =
    o.ownWork === 'auto'
      ? !(
          (await admin.execute(sqlTag`
            select 1 from workspace_users u
              join workspaces w on w.id = u.workspace_id and w.is_admin and ${liveWorkspaceSql('w')}
             where u.login_id = ${loginId}::uuid limit 1`)) as unknown as unknown[]
        ).length
      : o.ownWork;
  if (!ownWork) return { privateWs: null };
  if (!o.makePrivate) {
    const own = (await admin.execute(sqlTag`
      select p.workspace_id::text as ws from private_workspaces p
        join workspaces w on w.id = p.workspace_id and ${liveWorkspaceSql('w')}
       where p.login_id = ${loginId}::uuid`)) as unknown as { ws: string }[];
    return { privateWs: ownPrivate(loginId, own[0]?.ws ?? null) };
  }
  // The definer makes only the acting login's own (0307):
  // the scope's login (mantle.scope_login, read by the scope's checks only)
  // is the login bound to this call, never the one asked for.
  const bound = boundLoginId();
  if (bound === null || bound !== loginId.toLowerCase()) {
    throw new RuntimeFaultError('createHomeFallback: the login asked for is not the one bound');
  }
  const rows = (await systemPoolTxInScope({ loginId: bound, ws: null, modWs: null }, (tx) =>
    tx.execute(sqlTag`select "public"."mantle_ws_private_workspace"(${loginId}::uuid)::text as ws`),
  )) as unknown as { ws: string | null }[];
  const privateWs = ownPrivate(loginId, rows[0]?.ws ?? null);
  if (!privateWs) {
    return { refused: 'no-workspace', message: 'You have no workspace to create in yet.' };
  }
  return { privateWs };
}

/** The live workspaces beyond Admin an app run reads through (AppRunFor):
 *  a brain app's holders from its grants. `{ team: true }`, an id that is
 *  not an app, and an app with no live holder beyond Admin read nothing
 *  (they read the built-in Team workspace until 0286 made it a normal one;
 *  no workspace stands in for "team rules" now). Admin pool. Also asked
 *  by appHolderHomes (app-holder-homes.ts). */
export async function appRunHolders(app: AppRunFor): Promise<string[]> {
  if (!('id' in app)) return [];
  if (!UUID_RE.test(app.id)) throw new Error('withViewer: app must be a uuid');
  const [row] = (await getAdminDb().execute(
    sqlTag`select coalesce(array(
                    select w.id::text from workspaces w
                     where w.id = any(n.read_ws) and ${holderWorkspacesSql(sqlTag`array[w.id]`)}
                     order by w.id), '{}') as live
             from nodes n
            where n.id = ${app.id} and n.type = 'app'`,
  )) as unknown as { live: string[] }[];
  return row ? [...row.live] : [];
}

/** The scope `withViewer` enters for `actsFor`, read on the admin pool. */
export async function viewerScopeFor(actsFor: ViewerFor): Promise<WorkspaceScope> {
  const admin = getAdminDb();
  if ('login' in actsFor) {
    if (!UUID_RE.test(actsFor.login)) throw new Error('withViewer: login must be a uuid');
    const rows = (await admin.execute(
      sqlTag`select coalesce(array_agg(u.workspace_id::text order by u.workspace_id), '{}') as ws,
                    coalesce(array_agg(u.workspace_id::text order by u.workspace_id)
                             filter (where u.moderator), '{}') as mod
               from workspace_users u
               join workspaces w on w.id = u.workspace_id and ${liveWorkspaceSql('w')}
               join auth.users l on l.id = u.login_id and l.disabled_at is null
              where u.login_id = ${actsFor.login}`,
    )) as unknown as { ws: string[]; mod: string[] }[];
    let ws = rows[0]?.ws ?? [];
    let mod = rows[0]?.mod ?? [];
    if (actsFor.app) {
      // An app run (plan R2, H1): the holders beyond Admin, met with the
      // runner's workspaces; see AppRunFor.
      const held = await appRunHolders(actsFor.app);
      const holder = held.length === 1 ? held[0]! : null;
      ws = holder && ws.includes(holder) ? [holder] : [];
      mod = mod.filter((m) => ws.includes(m));
    }
    return Object.freeze({
      kind: 'user',
      loginId: actsFor.login.toLowerCase(),
      ws: Object.freeze([...ws]),
      modWs: Object.freeze([...mod]),
    });
  }
  if ('agent' in actsFor) {
    const none = Object.freeze({
      kind: 'assistant' as const,
      loginId: null,
      ws: Object.freeze([]),
      modWs: Object.freeze([]),
    });
    if (actsFor.agent === null) return none;
    if (!UUID_RE.test(actsFor.agent)) throw new Error('withViewer: agent must be a uuid');
    const rows = (await admin.execute(
      sqlTag`select a.workspace_id::text as ws from agents a
               join workspaces w on w.id = a.workspace_id and ${liveWorkspaceSql('w')}
              where a.id = ${actsFor.agent}`,
    )) as unknown as { ws: string }[];
    return Object.freeze({
      kind: 'assistant',
      loginId: null,
      ws: Object.freeze(rows[0]?.ws ? [rows[0].ws] : []),
      modWs: Object.freeze([]),
    });
  }
  const served = actsFor.link.served.filter((id) => UUID_RE.test(id)).map((id) => id.toLowerCase());
  return Object.freeze({
    kind: 'link',
    loginId: null,
    ws: Object.freeze([]),
    modWs: Object.freeze([]),
    served: Object.freeze([...new Set(served)].sort()),
  });
}
