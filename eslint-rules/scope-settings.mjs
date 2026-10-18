/**
 * scope-settings: who sets a login's scope by hand, and who carries one onto
 * the system pool (plan v3.2 S2a a1+a2, audit L1 and L7).
 *
 * The scope settings (mantle.ws, mantle.mod_ws, mantle.scope_login) decide
 * what a workspace definer takes as the acting login (0305). They are set in
 * packages/db/src/client.ts only, each place a scope mechanism of its own:
 * writeScopeSettings (the system pool: systemPoolTx and systemPoolTxInScope),
 * the write role's settings, the turn scope's and withScope's. Anywhere else
 * a quoted setting name is a hand-set scope and fails the pin.
 *
 * systemPoolTxInScope (a system-pool transaction in a login's scope set by
 * hand) and withSystemPoolInWriteScope (a request's write scope carried onto
 * the system pool) are ways onto the system pool that a definer reads as the
 * login: each call site is pinned, so a new caller fails the pin until it is
 * reviewed.
 *
 * Pinned-count mode, as system-work-allowlist.mjs: the rules flag a file
 * over its pin (an unlisted file: 0); eslint-rules/arch-lints.test.ts fails
 * on any other count, so a pin only goes down. Raising one is a review
 * decision.
 */
import { isCounted, pinnedRule, repoPathOf, stripComments } from './arch-counts.mjs';

const SETTING = /['"`]mantle\.(?:ws|mod_ws|scope_login)['"`]/g;
const CARRIER = /\b(?:systemPoolTxInScope|withSystemPoolInWriteScope)\s*(?:<[^>()]*>)?\(/g;

/** The quoted scope setting names in `text` (comments stripped). */
export function scopeSettingNames(text) {
  return stripComments(text).match(SETTING)?.length ?? 0;
}

/** The call sites of systemPoolTxInScope and withSystemPoolInWriteScope in
 *  `text` (comments stripped; their definitions are not calls). */
export function systemPoolScopeCalls(text) {
  const code = stripComments(text);
  let n = 0;
  for (const m of code.matchAll(CARRIER)) {
    if (/function\s+$/.test(code.slice(Math.max(0, m.index - 20), m.index))) continue;
    n += 1;
  }
  return n;
}

/** @type {Record<string, { count: number, why: string }>} */
export const SCOPE_SETTING_PINS = {
  'packages/db/src/client.ts': {
    count: 9,
    why: 'writeScopeSettings (3), the write role settings (2), the turn scope (2), withScope (2)',
  },
  'packages/db/src/matrix/test-support/a8-grid.ts': {
    count: 3,
    why: 'test support: the matrix fixtures set a caller scope as the superuser',
  },
};

/** @type {Record<string, { count: number, why: string }>} */
export const SYSTEM_POOL_SCOPE_PINS = {
  'packages/db/src/client.ts': {
    count: 2,
    why: 'createHomeFallback (the login only, for mantle_ws_private_workspace); systemPoolProp (withSystemPoolInWriteScope transactions)',
  },
  'server/web/lib/workspaces-migrate.ts': {
    count: 1,
    why: 'attachDefaultAssistants: the first owner and onboarding attach in the login scope',
  },
  'server/web/lib/workspaces.ts': {
    count: 1,
    why: 'adminRoleChange: auth.users, sessions and push devices, with the user definer inside',
  },
};

const pins = (p) => Object.fromEntries(Object.entries(p).map(([f, v]) => [f, v.count]));

export const settingsRule = pinnedRule({
  description: 'The scope settings are set in packages/db/src/client.ts only (S2a, L1).',
  message:
    'mantle.ws, mantle.mod_ws and mantle.scope_login are set by client.ts only: use systemPoolTxInScope (packages/db), or pin the site with its reason in eslint-rules/scope-settings.mjs (review).',
  pins: pins(SCOPE_SETTING_PINS),
  swept: (path) => isCounted(path),
  count: scopeSettingNames,
  repoPath: repoPathOf,
});

export const carrierRule = pinnedRule({
  description: 'systemPoolTxInScope and withSystemPoolInWriteScope only at pinned sites (S2a, L7).',
  message:
    'A login scope on the system pool: pin the call site with its reason in eslint-rules/scope-settings.mjs (review), or run in the caller scope.',
  pins: pins(SYSTEM_POOL_SCOPE_PINS),
  swept: (path) => isCounted(path),
  count: systemPoolScopeCalls,
  repoPath: repoPathOf,
});

export default {
  rules: { 'scope-settings-in-client': settingsRule, 'system-pool-scope-sites': carrierRule },
};
