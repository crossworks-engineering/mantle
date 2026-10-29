/**
 * as-system-allowlist: asSystem leaves every workspace scope, so each file
 * that calls it is listed with its number of call sites and the reasons it
 * passes (the why).
 *
 * Pinned-count mode: the rule flags a file over its pin (an unlisted file:
 * 0); eslint-rules/arch-lints.test.ts fails on any other count or reason
 * set, so a pin only goes down. Raising one is a review decision.
 *
 * Every call names its reason (a type error without one), and
 * each `why` here is the set of real reasons the file passes: names of
 * AS_SYSTEM_TURN_REASONS or AS_SYSTEM_OTHER_REASONS (packages/db/src/
 * viewer.ts says what each one allows). 'test' is for test files only.
 */
import { asSystemSites, isCounted, repoPathOf, pinnedRule } from './arch-counts.mjs';

/**
 * @type {Record<string, { count: number, why: string[] }>} Where a file
 * leaves the scope by one reason at several places, the places go through
 * that file's one door (a function that calls asSystem once, with the
 * reason), each reviewed at its door. The rule-in-query routes and
 * libraries go through lib/auth/rule-in-query.ts (inRuleInQuery), the one
 * exit of the any-login handlers; dispatch.ts's connector binding through
 * external-access.ts (connectorGroupRow).
 *
 * These pins say where the code CAN leave the scope; the honest number is
 * the exits, every use of a function holding a site (as-system-exits.mjs,
 * asSystemExits in scripts/arch-scoreboard.pins.json). A read that needs
 * one answer outside the scope asks a narrow definer instead (docs/actors.md,
 * "9. Definers"); code that never runs in a scope says so with systemWork
 * (no exit: it refuses a workspace scope).
 *
 * docs/actors.md, "A6" (a dangling quote, listed in docs-quotes.mjs DANGLING)
 */
export const AS_SYSTEM_PINS = {
  // The named system step, the one door for the brain-wide bookkeeping a
  // write does after its item check (systemStep: a table's history prune,
  // an Admin scope's attachment bytes, a file's derived items and drawings,
  // the re-index of a flag change or a move, an app's export sync; never in
  // the caller's scope, docs/actors.md, "8. Exits").
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
  // One door (connector-binding: the tool group row, dispatch.ts
  // reads it through connectorGroupRow); the workspace resources and a
  // connector's state read by their definers (0293).
  'packages/tools/src/external-access.ts': { count: 1, why: ['connector-binding'] },
  // The approval re-check: leaves the approving path's scope
  // only to enter the scope the call was asked in.
  'packages/tools/src/pending-origin.ts': { count: 1, why: ['pending-approval'] },
  'server/web/lib/app-runner.ts': { count: 1, why: ['app-data'] },
  'server/web/lib/auth/rule-in-query.ts': { count: 1, why: ['rule-in-query'] },
  // The grants panel reads in the caller's scope; the page
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
