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
/** @type {Record<string, { lists: number, entries: number }>} A0 baseline */
export const TOOL_LIST_PINS = {
  'packages/content-core/src/profile-projections.ts': { lists: 1, entries: 4 },
  'packages/mcp-core/src/build-server.ts': { lists: 1, entries: 9 },
  'packages/mcp-core/src/create-home.ts': { lists: 1, entries: 3 },
  'packages/mcp-core/src/key-email-guard.ts': { lists: 1, entries: 5 },
  'packages/mcp-core/src/key-scope.ts': { lists: 2, entries: 19 },
  'packages/mcp-core/src/login-surface.ts': { lists: 3, entries: 32 },
  'packages/mcp-core/src/register/tables.ts': { lists: 1, entries: 3 },
  'packages/runtime/src/heartbeats/fire.ts': { lists: 1, entries: 3 },
  'packages/tools/src/admin-gate.ts': { lists: 4, entries: 141 },
  'packages/tools/src/builtins-app-data.ts': { lists: 1, entries: 3 },
  'packages/tools/src/builtins-apps.ts': { lists: 1, entries: 6 },
  'packages/tools/src/builtins-contacts.ts': { lists: 1, entries: 5 },
  'packages/tools/src/builtins-formulas.ts': { lists: 1, entries: 5 },
  'packages/tools/src/builtins-journal.ts': { lists: 1, entries: 5 },
  'packages/tools/src/builtins-runs.ts': { lists: 2, entries: 18 },
  'packages/tools/src/client-sourced.ts': { lists: 1, entries: 4 },
  'packages/tools/src/create-tools.ts': { lists: 1, entries: 28 },
  'packages/tools/src/item-write-gate.ts': { lists: 1, entries: 98 },
  'packages/tools/src/member-app-tools.ts': { lists: 1, entries: 4 },
  'packages/tools/src/recipe.ts': { lists: 1, entries: 26 },
  'packages/tools/src/selection/deferred.ts': { lists: 1, entries: 20 },
  'packages/tools/src/untrusted.ts': { lists: 1, entries: 4 },
};

/** @type {Record<string, number>} route lists per file, A0 baseline */
export const ROUTE_LIST_PINS = {
  'server/web/lib/api-v1.ts': 1,
  'server/web/lib/auth-constants.ts': 2,
  'server/web/lib/auth/any-login-routes.ts': 3,
  'server/web/lib/auth/member-routes.ts': 1,
  'server/web/lib/auth/route-scope.ts': 7,
  'server/web/lib/body-limit.ts': 1,
  'server/web/server/public-session-routes.ts': 1,
};
