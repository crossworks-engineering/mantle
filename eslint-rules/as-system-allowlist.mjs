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
 * exit of the any-login handlers; client-sourced-rules.ts through
 * client-sourced.ts (clientSourcedSystem); dispatch.ts's connector binding
 * through external-access.ts (connectorGroupRow). docs/actors.md, "A6",
 * lists every door and its callers.
 */
export const AS_SYSTEM_PINS = {
  'packages/content/src/admin-space-taken.ts': { count: 1, why: ['space-taken-authors'] },
  'packages/content/src/app-access-log.ts': { count: 1, why: ['login-names'] },
  'packages/content/src/app-table-exports.ts': { count: 1, why: ['client-sourced-mark'] },
  'packages/content/src/contact-share-codes.ts': { count: 1, why: ['contact-sharing'] },
  'packages/content/src/login-notices.ts': { count: 1, why: ['login-notice'] },
  'packages/content/src/profile-preferences.ts': { count: 1, why: ['owner-preferences'] },
  'packages/content/src/tables/shared.ts': { count: 1, why: ['export-link'] },
  'packages/files/src/ops/files.ts': { count: 2, why: ['kind-root', 'name-taken'] },
  'packages/files/src/ops/shared.ts': { count: 1, why: ['kind-root'] },
  'packages/mcp-core/src/login-surface.ts': { count: 1, why: ['audit-log'] },
  'packages/runs/src/boss.ts': { count: 1, why: ['runs-scope-check'] },
  'packages/runtime/src/agent/agent-viewer.ts': { count: 1, why: ['agent-workspace'] },
  'packages/runtime/src/heartbeats/tick.ts': { count: 1, why: ['heartbeat-context'] },
  'packages/runtime/src/heartbeats/tools.ts': {
    count: 2,
    why: ['admin-area', 'heartbeat-own-row'],
  },
  'packages/search/src/index.ts': { count: 1, why: ['keyword-candidates'] },
  'packages/search/src/keyword-query.ts': { count: 1, why: ['lexeme-stats'] },
  'packages/telegram/src/chat-login.ts': { count: 1, why: ['login-telegram'] },
  'packages/telegram/src/pairing.ts': { count: 1, why: ['login-telegram'] },
  'packages/tools/src/admin-gate.ts': { count: 1, why: ['admin-area'] },
  'packages/tools/src/builtins-app-data.ts': { count: 1, why: ['app-data'] },
  'packages/tools/src/builtins-apps.ts': { count: 1, why: ['app-trash'] },
  'packages/tools/src/builtins-replay.ts': { count: 1, why: ['login-telegram'] },
  'packages/tools/src/builtins-telegram.ts': { count: 1, why: ['login-telegram'] },
  'packages/tools/src/client-sourced.ts': { count: 1, why: ['client-sourced-check'] },
  'packages/tools/src/dispatch.ts': { count: 1, why: ['connector-call'] },
  // Two doors since A6 (connector-binding: the tool group row, dispatch.ts
  // reads it through connectorGroupRow; workspace-resources).
  'packages/tools/src/external-access.ts': {
    count: 2,
    why: ['connector-binding', 'workspace-resources'],
  },
  'packages/tools/src/pending-notify.ts': { count: 1, why: ['login-telegram'] },
  // The approval re-check (A5 step 6c): leaves the approving path's scope
  // only to enter the scope the call was asked in.
  'packages/tools/src/pending-origin.ts': { count: 1, why: ['pending-approval'] },
  'server/web/lib/agent-telegram.ts': { count: 1, why: ['login-telegram'] },
  'server/web/lib/app-runner.ts': { count: 1, why: ['app-data'] },
  'server/web/lib/auth/rule-in-query.ts': { count: 1, why: ['rule-in-query'] },
  'server/web/lib/debug.ts': { count: 1, why: ['login-telegram'] },
  'server/web/lib/landing.ts': { count: 1, why: ['owner-preferences'] },
  'server/web/lib/snapshot-copies.ts': { count: 1, why: ['snapshot-copies'] },
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
