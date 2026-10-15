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

/**
 * @type {Record<string, number>} lines per file: none since A6 (25 files,
 * 86 lines at A0). The rules come from the database (item-acl.ts: the scope
 * forms, and the array forms for a login asked on the system pool and the
 * previews); the facts (an item's home, the workspaces holding it) from
 * item-acl.ts too. A new read is a lint error anywhere outside packages/db.
 */
export const RAW_ACL_PINS = {};

export const rule = pinnedRule({
  description: 'No raw ACL column reads outside packages/db (plan v2, section 11).',
  message:
    'Read access through @mantle/db (item-acl.ts: mayEditSql, mayEditInSql, itemHomeSql and the rest; row rules, item-rights.ts), not read_ws / write_ws / home_ws. See eslint-rules/no-raw-acl-columns.mjs.',
  pins: RAW_ACL_PINS,
  swept: (path) => rawAclSwept(path),
  count: (text) => rawAclLines(text),
  repoPath: repoPathOf,
});

export default { rules: { 'no-raw-acl-columns': rule } };
