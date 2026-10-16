/**
 * no-policy-name-lists (workspaces arch plan v2, section 11; A0): access
 * policy is not a list of tool slugs or route patterns. Tools get a
 * ToolPolicy on their definition (A5), routes one ROUTE_POLICY row (A4).
 *
 * Pinned-count mode: each file that holds such lists today is listed with
 * how many tool lists (and their slug entries) and route lists it has.
 * eslint-rules/arch-lints.test.ts fails on any other count, so a pin only
 * goes down. No editor rule: a tool list needs the slug set of the repo.
 */
/** @type {Record<string, { lists: number, entries: number }>} A0 baseline;
 *  A5 step 1: the @mantle/tools access lists are views of the tool policy
 *  table, and a list of definition objects is not counted (RUN_TOOLS).
 *  A5 step 2: the @mantle/mcp-core lists are views of the builtin policy
 *  table and the MCP definitions (mcp-defs.ts), none left there.
 *  A5 step 6a: the views are deleted (each consumer reads the tool's
 *  policy), the three auto-grant lists are read off their definitions, and
 *  the deferred selection's core (selection/core.ts) is no access list (arch-counts.mjs
 *  toolPolicySwept). One pin is left: TEAM_PRIVATE_READ_SLUGS, kept in the
 *  published content-core contract for one jackdaw pair release (its
 *  consumers here read the policy's `privateCorpus`). */
export const TOOL_LIST_PINS = {
  'packages/content-core/src/profile-projections.ts': { lists: 1, entries: 4 },
};

/** @type {Record<string, number>} route lists per file, A0 baseline.
 *  A4 hand batch B fix round 1 (M2), up one in route-policy.ts, reviewed:
 *  PUBLIC_LOGIN_ROWS names the public rows that read a login, so a public
 *  login kind is read on those rows only, not on every public row (the
 *  audit's ask; ROUTE_POLICY's own check, not a policy beside it).
 *  A10 #8, one in route-limits.ts, reviewed: ROUTE_GATES gives each row
 *  its rate limits by name and its cross-site refusal, read into the row
 *  by buildRouteRow (the source of two ROUTE_POLICY fields, as
 *  PUBLIC_LOGIN_ROWS is of the caller check), where 38 limits were taken
 *  by hand in the route files.
 *  F4 fix round 1, one in route-scope.ts, reviewed: ADMIN_ACT_WRITES names
 *  the write routes an Admin user's request runs on the system pool with
 *  no scope (contact sharing, Revoke all, an entity merge), the guard's
 *  named exit beside the share close and the deleted-app trash. */
export const ROUTE_LIST_PINS = {
  'server/web/lib/api-v1.ts': 1,
  'server/web/lib/auth-constants.ts': 2,
  'server/web/lib/auth/any-login-routes.ts': 3,
  'server/web/lib/auth/member-routes.ts': 1,
  'server/web/lib/auth/route-policy.ts': 1,
  'server/web/lib/auth/route-scope.ts': 7,
  'server/web/lib/body-limit.ts': 1,
  'server/web/lib/route-limits.ts': 1,
  'server/web/server/public-session-routes.ts': 1,
};
