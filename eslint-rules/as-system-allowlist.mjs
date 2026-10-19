/**
 * as-system-allowlist (workspaces arch plan v2, section 11; A0): asSystem
 * leaves every workspace scope, so each file that calls it is listed with
 * its number of call sites and the reasons it passes (the why). Target: at
 * most 40 sites, each in a pinned file with a reason (section 3).
 *
 * Pinned-count mode: the rule flags a file over its pin (an unlisted file:
 * 0); eslint-rules/arch-lints.test.ts fails on any other count or reason
 * set, so a pin only goes down. Raising one is a review decision.
 *
 * Since A2a every call names its reason (a type error without one), and
 * each `why` here is the set of real reasons the file passes: names of
 * AS_SYSTEM_TURN_REASONS or AS_SYSTEM_OTHER_REASONS (packages/db/src/
 * viewer.ts says what each one allows). 'test' is for test files only.
 */
import { asSystemSites, isCounted, repoPathOf, pinnedRule } from './arch-counts.mjs';

/**
 * @type {Record<string, { count: number, why: string[] }>} A6: 39 sites in
 * 36 files, 28 reasons (88 in 45 before). Where a file left the scope by
 * one reason at several places, the places now go through that file's one
 * door (a function that calls asSystem once, with the reason): the exits are
 * the same, each is reviewed at its door. The rule-in-query routes and
 * libraries go through lib/auth/rule-in-query.ts (inRuleInQuery), the one
 * exit of the any-login handlers; dispatch.ts's connector binding through
 * external-access.ts (connectorGroupRow). docs/actors.md, "A6",
 * lists every door and its callers.
 *
 * A6 round 2: 39 sites in 36 files, 29 reasons (41, 38, 30 before main
 * dropped the provider-key exits). lib/grants.ts and lib/workspaces.ts read
 * in the caller's scope and no longer leave it through rule-in-query.ts;
 * each has its own door for what still needs the system pool. These pins
 * say where the code CAN leave the scope; the honest number is the exits,
 * every use of a function holding a site (A6 fix round 1, L1:
 * as-system-exits.mjs, asSystemExits in scripts/arch-scoreboard.pins.json).
 *
 * A6b (docs/actors.md): 16 sites in 15 files, 14 reasons. The reads that left the scope
 * for one answer read it in the scope (the own-login rule) or by a narrow
 * definer (migration 0293); the code that never ran in a scope says so with
 * systemWork (no exit: it refuses a workspace scope). The client-sourced
 * guard (client-sourced.ts, client-sourced-rules.ts, app-table-exports.ts)
 * and a turn's own heartbeats (heartbeats/tick.ts) left the list: their
 * definers answer as the system pool did, in the scope.
 */
export const AS_SYSTEM_PINS = {
  // F4 fix round 2: the named system step, the one door for the brain-wide
  // bookkeeping a write does after its item check (systemStep: a table's
  // history prune, an Admin scope's attachment bytes, a file's derived
  // items and drawings, the re-index of a flag change or a move, an app's
  // export sync). docs/actors.md, "F4 fix round 2", lists its sites.
  'packages/db/src/system-step.ts': { count: 1, why: ['brain-bookkeeping'] },
  'packages/mcp-core/src/login-surface.ts': { count: 1, why: ['audit-log'] },
  'packages/runtime/src/agent/agent-viewer.ts': { count: 1, why: ['agent-workspace'] },
  'packages/runtime/src/heartbeats/tools.ts': {
    count: 2,
    why: ['admin-area', 'heartbeat-own-row'],
  },
  'packages/search/src/index.ts': { count: 1, why: ['keyword-candidates'] },
  'packages/telegram/src/pairing.ts': { count: 1, why: ['login-telegram'] },
  'packages/tools/src/admin-gate.ts': { count: 1, why: ['admin-area'] },
  'packages/tools/src/builtins-app-data.ts': { count: 1, why: ['app-data'] },
  'packages/tools/src/builtins-apps.ts': { count: 1, why: ['app-trash'] },
  'packages/tools/src/dispatch.ts': { count: 1, why: ['connector-call'] },
  // One door since A6b (connector-binding: the tool group row, dispatch.ts
  // reads it through connectorGroupRow); the workspace resources and a
  // connector's state read by their definers (0293).
  'packages/tools/src/external-access.ts': { count: 1, why: ['connector-binding'] },
  // The approval re-check (A5 step 6c): leaves the approving path's scope
  // only to enter the scope the call was asked in.
  'packages/tools/src/pending-origin.ts': { count: 1, why: ['pending-approval'] },
  'server/web/lib/app-runner.ts': { count: 1, why: ['app-data'] },
  'server/web/lib/auth/rule-in-query.ts': { count: 1, why: ['rule-in-query'] },
  // A6 round 2: the grants panel reads in the caller's scope; the page
  // refold after a change is its one exit (pageRefoldSystem).
  'server/web/lib/grants.ts': { count: 1, why: ['page-refold'] },
};

export const rule = pinnedRule({
  description: 'asSystem only in pinned files (plan v2, section 11).',
  message:
    "asSystem leaves the workspace scope: run in the caller's scope, or pin the site with its reason in eslint-rules/as-system-allowlist.mjs (review).",
  pins: Object.fromEntries(Object.entries(AS_SYSTEM_PINS).map(([f, v]) => [f, v.count])),
  swept: (path) => isCounted(path),
  count: (text) => asSystemSites(text).count,
  repoPath: repoPathOf,
});

export default { rules: { 'as-system-allowlist': rule } };
