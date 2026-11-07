/**
 * no-policy-name-lists: access policy is not a list of tool slugs or route
 * patterns. Tools get a ToolPolicy on their definition, routes one
 * ROUTE_POLICY row.
 *
 * Pinned-count mode: each file that holds such lists today is listed with
 * how many tool lists (and their slug entries) and route lists it has.
 * eslint-rules/arch-lints.test.ts fails on any other count, so a pin only
 * goes down. No editor rule: a tool list needs the slug set of the repo.
 */
/** @type {Record<string, { lists: number, entries: number }>} A list of
 *  definition objects is not counted (RUN_TOOLS), nor the deferred
 *  selection's core (selection/core.ts; arch-counts.mjs toolPolicySwept).
 *  The one pin: TEAM_PRIVATE_READ_SLUGS, kept in the published
 *  content-core contract for the client (its consumers here read the
 *  policy's `privateCorpus`). */
export const TOOL_LIST_PINS = {
  'packages/content-core/src/profile-projections.ts': { lists: 1, entries: 4 },
};

/** @type {Record<string, number>} route lists per file. Each route file's
 *  declaration is the one source. Out of the count by name: the session
 *  sweep's test data (arch-counts.mjs ROUTE_LISTS_NOT_POLICY) and
 *  body-limit.ts's three ceiling lists (sizes, not who may call:
 *  ROUTE_LIST_NAMES_NOT_POLICY; the rest of the file is counted). The one
 *  pin: PUBLIC_PATHS, the gate's answer for a request no row answers
 *  (gate.ts gateRouteView). */
export const ROUTE_LIST_PINS = {
  'server/web/lib/auth-constants.ts': 1,
};
