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
 *  named exit beside the share close and the deleted-app trash.
 *  Pre-check removal part 2, route-scope.ts 7 to 6: ITEM_REF_PREFIXES lost
 *  its recall-revision entry (two left, share and deleted-app); 6 to 5 in
 *  round 3: ITEM_WRITE_PREFIXES lost tables, files and folders (two left,
 *  apps and tree items). Round 4 (the last family), still 5:
 *  ITEM_WRITE_PREFIXES and ITEM_READ_WRITES are gone, and NO_ITEM_WRITES
 *  names the same seven routes as ITEM_READ_WRITES did, for
 *  route-policy's makesItems only (no item check). Plan v3.2 S6 c3: 5 to
 *  4, ADMIN_ACT_WRITES is gone (the four Admin acts run in the login's
 *  scope, each asking its definer).
 *  The narrow area sweep's hand list of login-self rows (LOGIN_SELF_ROWS)
 *  is gone: its entries come from the route table now (selfWriteRows),
 *  keyed like the area entries, so narrow-area-sweep.entries.ts holds no
 *  list (1 to 0). The route declarations (plan v3.2), part 0 round 2:
 *  public-session-routes.ts leaves the count, the session sweep's test
 *  data, not a policy (arch-counts.mjs ROUTE_LISTS_NOT_POLICY). Part 3:
 *  the lists are deleted, each route file's declaration the one source
 *  (api-v1.ts's key table, auth-constants.ts's audit paths, the three of
 *  any-login-routes.ts, member-routes.ts, route-policy.ts's public login
 *  rows, the four of route-scope.ts, route-limits.ts's ROUTE_GATES), and
 *  body-limit.ts leaves the count (its ceilings are sizes, not who may
 *  call: ROUTE_LISTS_NOT_POLICY). One is left: PUBLIC_PATHS, the gate's
 *  answer for a request no row answers (gate.ts gateRouteView). */
export const ROUTE_LIST_PINS = {
  'server/web/lib/auth-constants.ts': 1,
};
