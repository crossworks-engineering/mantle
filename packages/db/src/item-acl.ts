/**
 * The item access rules and the item access facts as SQL (arch A6, plan v2
 * page fcc4aee4, sections 5.1 and 11: no hand-written grant logic). Outside
 * packages/db no code names the raw ACL columns (home_ws, read_ws,
 * write_ws: the lint no-raw-acl-columns, pinned at 0): it asks here.
 *
 * Rules, one definition each, in the database:
 *  - scope forms (the code runs in a workspace scope, or with the scope set
 *    on its transaction): mayEditSql, mayManageSql (mantle_may_edit,
 *    mantle_may_manage), readsInScopeSql (the row rule on nodes);
 *  - array forms (a preview, or a rule asked for a login on the system
 *    pool, with that login's workspaces as arrays): mayReadInSql,
 *    mayEditInSql, mayManageInSql, mayManageHomeInSql (mantle_may_edit_in,
 *    mantle_may_manage_in of 0280; the scope forms call them).
 *
 * Facts (what holds the item, its home), for answers that show them or
 * compare one item's holders with another's: itemHomeSql, itemHoldersSql,
 * heldBySql, holdsAllSql, missesAnySql, the facts table's own copy
 * (factReadsInScopeSql) and a deleted item's home as its snapshot keeps it
 * (snapshotHomeSql, snapshotHomeMeta).
 *
 * `alias`: the alias of `nodes` in a hand-written query (`n`); left out, the
 * drizzle table (`"nodes"`). Every rule answers false, never null.
 */
import { sql, type SQL } from 'drizzle-orm';
import { facts } from './schema/facts';
import { nodes } from './schema/nodes';

const ALIAS_RE = /^[a-z_][a-z0-9_]*$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AclColumn = 'home_ws' | 'read_ws' | 'write_ws';

function column(alias: string | undefined, name: AclColumn): SQL {
  if (alias === undefined) {
    if (name === 'home_ws') return sql`${nodes.homeWs}`;
    if (name === 'read_ws') return sql`${nodes.readWs}`;
    return sql`${nodes.writeWs}`;
  }
  if (!ALIAS_RE.test(alias)) throw new Error(`item-acl: bad alias ${alias}`);
  return sql.raw(`${alias}.${name}`);
}

/** Workspace ids as a uuid[] parameter (each checked). */
export function wsArraySql(ids: readonly string[]): SQL {
  for (const id of ids) {
    if (!UUID_RE.test(id)) throw new Error(`item-acl: not a uuid: ${String(id).slice(0, 40)}`);
  }
  return sql`${`{${ids.join(',')}}`}::uuid[]`;
}

// ── Scope forms ──────────────────────────────────────────────────────────────

/** The scope may edit the item: a Moderator of its home, or a grant with
 *  Write on in the scope (mantle_may_edit). */
export function mayEditSql(alias?: string): SQL<boolean> {
  return sql<boolean>`coalesce("public"."mantle_may_edit"(${column(alias, 'home_ws')}, ${column(alias, 'write_ws')}), false)`;
}

/** The scope may manage the item (grants, links, delete, move): a
 *  Moderator of its home (mantle_may_manage). */
export function mayManageSql(alias?: string): SQL<boolean> {
  return sql<boolean>`coalesce("public"."mantle_may_manage"(${column(alias, 'home_ws')}), false)`;
}

/** The workspace role's read rule on nodes, over the scope's settings
 *  (0242): a workspace of the scope holds the item. Written as the row rule
 *  is, so an index on the column serves it. */
export function readsInScopeSql(alias?: string): SQL<boolean> {
  return sql<boolean>`(${column(alias, 'read_ws')} && mantle_scope_ws())`;
}

/** The same rule on the facts table's own copy (a fact with no item). */
export function factReadsInScopeSql(): SQL<boolean> {
  return sql<boolean>`(${facts.readWs} && mantle_scope_ws())`;
}

// ── Array forms ──────────────────────────────────────────────────────────────

/** One of the workspaces `ws` (a uuid[] expression) reads the item. */
export function mayReadInSql(alias: string | undefined, ws: SQL): SQL<boolean> {
  return sql<boolean>`coalesce(${column(alias, 'read_ws')} && ${ws}, false)`;
}

/** A login in the workspaces `ws`, a Moderator of `modWs`, may edit the
 *  item (mantle_may_edit_in, the one definition). */
export function mayEditInSql(alias: string | undefined, ws: SQL, modWs: SQL): SQL<boolean> {
  return sql<boolean>`coalesce("public"."mantle_may_edit_in"(${ws}, ${modWs}, ${column(alias, 'home_ws')}, ${column(alias, 'write_ws')}), false)`;
}

/** A Moderator of `modWs` may manage the item (mantle_may_manage_in). */
export function mayManageInSql(alias: string | undefined, modWs: SQL): SQL<boolean> {
  return mayManageHomeInSql(column(alias, 'home_ws'), modWs);
}

/** The same rule for a home that is not on a row (a deleted item's, as its
 *  snapshot keeps it). */
export function mayManageHomeInSql(home: SQL, modWs: SQL): SQL<boolean> {
  return sql<boolean>`coalesce("public"."mantle_may_manage_in"(${modWs}, ${home}), false)`;
}

// ── Facts ────────────────────────────────────────────────────────────────────

/** The item's home workspace (null for an item with none). */
export function itemHomeSql(alias?: string): SQL<string | null> {
  return sql<string | null>`${column(alias, 'home_ws')}`;
}

/** The workspaces that hold (read) the item. */
export function itemHoldersSql(alias?: string): SQL<string[]> {
  // Over the drizzle table, decoded as its column is (a string[]).
  if (alias === undefined) return sql<string[]>`${nodes.readWs}`.mapWith(nodes.readWs);
  return sql<string[]>`${column(alias, 'read_ws')}`;
}

/** Workspace `ws` (a uuid expression) holds the item. */
export function heldBySql(alias: string | undefined, ws: SQL): SQL<boolean> {
  return sql<boolean>`(${ws} = any(${column(alias, 'read_ws')}))`;
}

/** Every workspace of `ws` (a uuid[] expression) holds the item. */
export function holdsAllSql(alias: string | undefined, ws: SQL): SQL<boolean> {
  return sql<boolean>`(${column(alias, 'read_ws')} @> ${ws})`;
}

/** Some workspace of `ws` (a uuid[] expression) does not hold the item. */
export function missesAnySql(alias: string | undefined, ws: SQL): SQL<boolean> {
  return sql<boolean>`exists (select 1 from unnest(${ws}) as w(id)
                               where not (w.id = any (${column(alias, 'read_ws')})))`;
}

/** The workspaces holding the item, joined as text ('' for none). */
export function itemHoldersTextSql(alias?: string): SQL<string> {
  return sql<string>`coalesce(array_to_string(${column(alias, 'read_ws')}, ','), '')`;
}

// ── A deleted item's home ───────────────────────────────────────────────────

/** The meta key a snapshot keeps the item's home under (W6a fix round 1). */
const SNAPSHOT_HOME_KEY = 'homeWs';

/** The home a snapshot row (alias `alias` of node_snapshots) names, or
 *  null for a snapshot taken before it was kept. */
export function snapshotHomeSql(alias: string): SQL<string | null> {
  if (!ALIAS_RE.test(alias)) throw new Error(`item-acl: bad alias ${alias}`);
  return sql<string | null>`nullif(${sql.raw(alias)}.code->'meta'->>${SNAPSHOT_HOME_KEY}, '')`;
}

/** The meta field a snapshot keeps the home in: none for no home. */
export function snapshotHomeMeta(home: string | null | undefined): { homeWs?: string } {
  return home ? { [SNAPSHOT_HOME_KEY]: home } : {};
}
