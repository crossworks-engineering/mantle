/**
 * system-work-allowlist (arch A6b fix round, L2): systemWork runs its work on
 * the system pool and refuses any scope (packages/db/src/viewer.ts). It is
 * no exit, yet each use is a place that reads or writes as the system: a new
 * caller needs review, as an asSystem site does (as-system-allowlist.mjs).
 * So each file that calls it is listed with its number of call sites and the
 * reasons it passes.
 *
 * Pinned-count mode: the rule flags a file over its pin (an unlisted file:
 * 0); eslint-rules/arch-lints.test.ts fails on any other count or reason
 * set, so a pin only goes down. Raising one is a review decision.
 */
import { isCounted, pinnedRule, repoPathOf, systemWorkSites } from './arch-counts.mjs';

/** @type {Record<string, { count: number, why: string[] }>} A6b: 7 sites in 7 files. */
export const SYSTEM_WORK_PINS = {
  // The push worker builds a login's notice from that login's rows.
  'packages/content/src/login-notices.ts': { count: 1, why: ['login-notice'] },
  // A chat's login and its refusal, for the bot's poller (no scope).
  'packages/telegram/src/chat-login.ts': { count: 1, why: ['login-telegram'] },
  // The Telegram tools run whole inside the Admin area's exit.
  'packages/tools/src/builtins-telegram.ts': { count: 1, why: ['login-telegram'] },
  // A login's MCP connector listing (the system pool's own path).
  'packages/tools/src/external-access.ts': { count: 1, why: ['connector-binding'] },
  // A bot's chats screen and pairing helpers, on an Admin area route.
  'server/web/lib/agent-telegram.ts': { count: 1, why: ['login-telegram'] },
  // The debug read of the bots (an Admin area route).
  'server/web/lib/debug.ts': { count: 1, why: ['login-telegram'] },
  // The boot step that makes snapshot copies, under its advisory lock.
  'server/web/lib/snapshot-copies.ts': { count: 1, why: ['snapshot-copies'] },
};

export const rule = pinnedRule({
  description: 'systemWork only in pinned files (arch A6b).',
  message:
    'systemWork runs as the system: pin the site with its reason in eslint-rules/system-work-allowlist.mjs (review), or run in the caller’s scope.',
  pins: Object.fromEntries(Object.entries(SYSTEM_WORK_PINS).map(([f, v]) => [f, v.count])),
  swept: (path) => isCounted(path),
  count: (text) => systemWorkSites(text).count,
  repoPath: repoPathOf,
});

export default { rules: { 'system-work-allowlist': rule } };
