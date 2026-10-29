/**
 * Role and actor names: each list is written here once, and every type,
 * zod enum, Set and membership test elsewhere reads it, so a role added
 * here reaches every reader.
 *
 * The other name lists already had a source in this package and stay there
 * (one source each, read the same way): the Admin areas WORKSPACE_AREAS
 * (./dto/workspaces), the access levels ACCESS_LEVELS (./dto/access) and the
 * key areas ACCESS_KEY_AREAS (./dto/access-keys).
 *
 * Each list is a non-empty `as const` tuple, so it is its own zod enum:
 * `z.enum(LOGIN_ROLES)`. Zero dependency and browser safe, as every
 * subpath of this package is.
 */

/** Every role a login can hold (there is no client role). A role grants
 *  nothing: what a login reads and may do comes from its workspaces. The SQL CHECK users_role_ck admits the same values
 *  (role-names.test.ts pins it). A row whose role is not one of these is no
 *  login (fail closed). */
export const LOGIN_ROLES = ['admin', 'member'] as const;
export type LoginRole = (typeof LOGIN_ROLES)[number];

/** Whether `v` is a role this code knows: anything else is no login. */
export function isLoginRole(v: unknown): v is LoginRole {
  return typeof v === 'string' && (LOGIN_ROLES as readonly string[]).includes(v);
}

/** Who a version or snapshot row of an app or a table names
 *  (node_snapshots.actor): 'member' is a member author's own act, and the
 *  row then names the login too. */
export const HISTORY_ACTORS = ['owner', 'agent', 'mcp', 'system', 'member'] as const;
export type HistoryActor = (typeof HISTORY_ACTORS)[number];

/** Who wrote a recall revision (recall v2): the owner's UI or an agent's
 *  recall-write tool. The SQL CHECK recall_revisions_actor_kind_ck admits
 *  the same values (role-names.test.ts pins it). */
export const RECALL_ACTOR_KINDS = ['owner', 'agent'] as const;
export type RecallActorKind = (typeof RECALL_ACTOR_KINDS)[number];
