/**
 * THE create-home intent (the gate's step 6): where a login's create lands,
 * decided by one function for every way in (the HTTP guard, an MCP
 * connection, an assistant turn), so no entry can set no intent at all.
 *
 * The rule (docs/workspaces.md, "Where a new item lands"):
 *
 *  1. The asked workspace, when the call names one:
 *     - an HTTP create's `?ws=` and an assistant turn's own workspace: an
 *       id; one the login is not in is refused, one it moderates is where
 *       the create lands, one it only reads is as if none was named;
 *     - an MCP create's `workspace` argument: the id or the name of a
 *       workspace the caller moderates; any other is refused, with a reply
 *       that says what to pass instead.
 *  2. Else the folder's workspace, when the item is made in a folder the
 *     login may edit (the database's mantle_default_home reads the folder).
 *  3. Else the login's private workspace (made now when the call may make
 *     an item and it has none); for a user of the Admin workspace, Admin.
 *
 * The result is the CreateHome the system transactions set as
 * mantle.create_ws and mantle.private_ws. Nothing here grants: it names a
 * place, and the database's create checks still run. Where the items a
 * call made landed (landedIn) is read here too, for every reply that names
 * it: an MCP create's (@mantle/mcp-core create-home.ts) and an export's
 * (@mantle/files export-home.ts).
 */
import { and, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { createHomeFallback, loginScopeFor } from './gateway/viewer-scope';
import { db } from './gateway/handles';
import { itemHomeSql } from './item-acl';
import { nodes, workspaces, workspaceUsers } from './schema/index';
import { currentWorkspaceScope, type CreateHome } from './viewer';
import { liveWorkspace } from './workspace-live';
import { UUID_RE } from '@mantle/std';

/** The workspace a call asks its creates to land in. */
export type CreateAsk =
  /** An HTTP create route's `?ws=` (an id, or null when none). */
  | { from: 'param'; ws: string | null }
  /** An assistant turn: the assistant's own workspace. */
  | { from: 'assistant'; ws: string | null }
  /** An MCP create's `workspace` argument: an id or a name. */
  | { from: 'argument'; workspace: unknown };

/** The fallback (step 3 of the rule): resolved now, or already resolved
 *  for this connection by this function (an MCP connection resolves it
 *  once, when it connects). */
export type CreateFallback =
  { ownWork: boolean | 'auto'; makePrivate: boolean } | { privateWs: string | null };

/** Why a create home was refused. `invalid`: a ?ws= that is not an id
 *  (HTTP 400); every other one is a 403 `workspace`, or a tool's refusal. */
export type CreateHomeRefusal = {
  refused: 'invalid' | 'not-member' | 'no-workspace' | 'unknown' | 'ambiguous' | 'not-moderator';
  message: string;
};

/** Where `loginId`'s creates land: see the module comment. */
export async function createHomeIntent(
  loginId: string,
  ask: CreateAsk | null,
  fallback: CreateFallback,
): Promise<CreateHome | CreateHomeRefusal> {
  let createWs: string | null = null;
  if (ask) {
    const asked =
      ask.from === 'argument'
        ? await namedWorkspace(loginId, ask.workspace)
        : await idWorkspace(loginId, ask.ws);
    if (typeof asked !== 'string' && asked !== null) return asked;
    createWs = asked;
  }
  if ('privateWs' in fallback) return { createWs, privateWs: fallback.privateWs };
  const own = await createHomeFallback(loginId, fallback);
  if ('refused' in own) return own;
  return { createWs, privateWs: own.privateWs };
}

/** An asked workspace id (?ws=, an assistant's own): the workspace the
 *  creates land in when the login moderates it, null when none was named
 *  or the login only reads it, else the refusal. */
async function idWorkspace(
  loginId: string,
  ws: string | null,
): Promise<string | null | CreateHomeRefusal> {
  if (ws === null || ws === undefined || ws === '') return null;
  if (!UUID_RE.test(ws)) return { refused: 'invalid', message: 'ws must be a workspace id.' };
  const scope = await loginScopeFor(loginId);
  const id = ws.toLowerCase();
  if (!scope.ws.includes(id)) {
    return { refused: 'not-member', message: 'You are not in that workspace.' };
  }
  return scope.modWs.includes(id) ? id : null;
}

/** The workspaces `loginId` may name, from the call's scope (or, outside
 *  one, its own user rows): id, name, Moderator. */
async function namable(
  loginId: string,
): Promise<{ id: string; name: string; moderator: boolean }[]> {
  const scope = currentWorkspaceScope();
  if (scope) {
    if (scope.ws.length === 0) return [];
    const mod = new Set(scope.modWs);
    const rows = await db
      .select({ id: workspaces.id, name: workspaces.name })
      .from(workspaces)
      .where(and(inArray(workspaces.id, [...scope.ws]), liveWorkspace()));
    return rows.map((r) => ({ ...r, moderator: mod.has(r.id) }));
  }
  return db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      moderator: workspaceUsers.moderator,
    })
    .from(workspaceUsers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceUsers.workspaceId))
    .where(and(eq(workspaceUsers.loginId, loginId), liveWorkspace()));
}

/** An MCP create's `workspace` (an id or a name): one the caller
 *  moderates, null when the argument is absent or blank, else the
 *  refusal (each says what to pass instead). */
async function namedWorkspace(
  loginId: string,
  asked: unknown,
): Promise<string | null | CreateHomeRefusal> {
  if (typeof asked !== 'string' || asked.trim() === '') return null;
  const want = asked.trim();
  const list = await namable(loginId);
  const byId = UUID_RE.test(want) ? list.filter((w) => w.id === want.toLowerCase()) : [];
  const hits = byId.length
    ? byId
    : list.filter((w) => w.name.trim().toLowerCase() === want.toLowerCase());
  if (hits.length === 0) {
    return {
      refused: 'unknown',
      message: `You are not in a workspace "${want.slice(0, 100)}". List yours with workspaces_list and pass one you moderate.`,
    };
  }
  if (hits.length > 1) {
    return {
      refused: 'ambiguous',
      message: `More than one of your workspaces is called "${want.slice(0, 100)}": pass its id from workspaces_list.`,
    };
  }
  const ws = hits[0]!;
  if (!ws.moderator) {
    return {
      refused: 'not-moderator',
      message: `You are not a Moderator of ${ws.name}, so you cannot create in it. Pass a workspace whose moderator is true in workspaces_list, or leave workspace out.`,
    };
  }
  return ws.id;
}

/** Where items `ids` landed: their home workspaces (id, name), read in the
 *  current scope, each once. With `since`, only items made since then (a
 *  reply that names an older item it did not make names no home for it). */
export async function landedIn(
  ids: readonly string[],
  since?: Date,
): Promise<{ id: string; name: string }[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(nodes)
    .innerJoin(workspaces, sql`${workspaces.id} = ${itemHomeSql()}`)
    .where(
      and(
        inArray(nodes.id, [...ids]),
        since ? or(gte(nodes.createdAt, since), sql`${nodes.createdAt} is null`) : undefined,
      ),
    );
  const seen = new Map<string, string>();
  for (const r of rows) seen.set(r.id, r.name);
  return [...seen].map(([id, name]) => ({ id, name }));
}
