/**
 * "Does a shared workspace read this item?" from the grants. Product
 * code asks this instead of reading the level columns (workspaces plan S2;
 * W5b1, and since W5b2 the grants alone).
 *
 * Until migration 0286 this asked about the built-in Team workspace. Team
 * is a normal workspace now (owner decision 2026-10-13) and a new brain has
 * none, so the question is about every shared workspace: the one rule,
 * whatever the workspaces are called.
 *
 * "Shared" has one meaning (sharedWorkspacesSql): a workspace that is
 * neither Admin, nor a login's private workspace, nor a Former user
 * workspace. A grant to the author's own private workspace shares nothing.
 *
 * Read where the caller runs: on the system pool every workspace; in a
 * workspace scope, a workspace the scope may name (one of the
 * scope's own, or any when the scope holds Admin: an Admin user's app list
 * tells the reach of an app held by a workspace they are not in). With no
 * grant nothing reads as shared: it fails closed.
 */
import { sql, type SQL } from 'drizzle-orm';
import { nodes } from './schema/index';

/**
 * Any of the workspace ids `ws` (a uuid[] expression) is a shared workspace:
 * not Admin, not private, not a Former user one (mantle_ws_any_shared,
 * 0286, on mantle_ws_class, the one class of a workspace: a definer, the
 * workspace role reads neither record table; this brain's workspaces only).
 * The grant reads below and firstSharedWorkspaceId (member-apps.ts) ask it.
 */
export function sharedWorkspacesSql(ws: SQL): SQL<boolean> {
  return sql<boolean>`coalesce("public"."mantle_ws_any_shared"(${ws}), false)`;
}

/** A shared workspace reads the row, over `nodes` as drizzle names it. */
export function sharedReadsSql(): SQL<boolean> {
  return sharedWorkspacesSql(sql`${nodes.readWs}`);
}

/** The same, over a raw query's alias of `nodes` (`n`). */
export function sharedReadsAliasSql(alias: string): SQL<boolean> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error(`sharedReadsAliasSql: bad alias ${alias}`);
  }
  return sharedWorkspacesSql(sql`${sql.raw(alias)}.read_ws`);
}

/**
 * Any of the workspace ids `ws` (a uuid[] expression) is a live holder
 * beyond Admin: live, and not Admin; a private or Former user workspace
 * holds too, its user runs and reaches the item there (mantle_ws_any_holder,
 * 0286, on the same class as sharedWorkspacesSql). An app run's holders
 * (appRunHolders, gateway/viewer-scope.ts), an app's MCP reach
 * (app-nav.ts) and the 0286 roll count of member-built apps with none
 * (server/web lib/workspace-ticks.ts) ask this one rule.
 */
export function holderWorkspacesSql(ws: SQL): SQL<boolean> {
  return sql<boolean>`coalesce("public"."mantle_ws_any_holder"(${ws}), false)`;
}

/** A live holder beyond Admin reads the row, over `nodes` as drizzle names
 *  it: someone outside Admin reaches it. */
export function holderReadsSql(): SQL<boolean> {
  return holderWorkspacesSql(sql`${nodes.readWs}`);
}
