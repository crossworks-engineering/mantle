/**
 * no-raw-acl-columns (workspaces arch plan v2, section 11; A0): code outside
 * packages/db does not read the raw ACL columns (read_ws, write_ws, home_ws,
 * and their camelCase names). Access goes through @mantle/db: the row rules,
 * item-rights.ts, the grant helpers. Comments are exempt.
 *
 * Pinned-count mode: each file that reads them today is listed with its
 * number of lines. The rule flags a file over its pin (an unlisted file: 0);
 * eslint-rules/arch-lints.test.ts fails on any other count, so a pin only
 * goes down. Raising one is a review decision.
 */
import { rawAclLines, rawAclSwept, repoPathOf, pinnedRule } from './arch-counts.mjs';

/** @type {Record<string, number>} lines per file, A0 baseline */
export const RAW_ACL_PINS = {
  'packages/content/src/app-snapshots.ts': 2,
  'packages/content/src/app-trash.ts': 1,
  'packages/content/src/apps.ts': 1,
  'packages/content/src/link-serve.ts': 5,
  'packages/content/src/member-apps.ts': 2,
  'packages/content/src/member-brain-apps.ts': 10,
  'packages/content/src/notes.ts': 1,
  'packages/content/src/pages/level-text.ts': 3,
  'packages/content/src/pages/read.ts': 1,
  'packages/content/src/tree/read.ts': 1,
  'packages/content/src/tree/visibility.ts': 9,
  'packages/files/src/ops/files.ts': 4,
  'packages/mcp-core/src/create-home.ts': 1,
  'packages/mcp-core/src/shared-item.ts': 1,
  'packages/runtime/src/agent/conversation.ts': 1,
  'packages/search/src/index.ts': 1,
  'packages/search/src/scope.ts': 4,
  'packages/tools/src/builtins-apps.ts': 1,
  'packages/tools/src/builtins-nodes.ts': 1,
  'packages/tools/src/client-sourced-rules.ts': 2,
  'packages/tools/src/client-sourced.ts': 1,
  'packages/tools/src/external-access.ts': 2,
  'server/web/lib/auth/session.ts': 3,
  'server/web/lib/grants.ts': 25,
  'server/web/lib/list-workspaces.ts': 3,
  'server/web/lib/snapshot-copies.ts': 1,
};

export const rule = pinnedRule({
  description: 'No raw ACL column reads outside packages/db (plan v2, section 11).',
  message:
    'Read access through @mantle/db (row rules, item-rights.ts, the grant helpers), not read_ws / write_ws / home_ws. See eslint-rules/no-raw-acl-columns.mjs.',
  pins: RAW_ACL_PINS,
  swept: (path) => rawAclSwept(path),
  count: (text) => rawAclLines(text),
  repoPath: repoPathOf,
});

export default { rules: { 'no-raw-acl-columns': rule } };
