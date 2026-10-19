/**
 * no-raw-write-sql (plan v3.2 section 3.2): scoped code writes through a
 * typed drizzle write or a definer call, never SQL text it writes by hand,
 * so the database routes and checks every write the same way.
 *
 * Findings (cleanup-counts.mjs rawWriteSqlSites, the scoreboard's measure):
 *  - a tagged template (`sql`, `sqlTag`, a name or transaction handle that
 *    holds one), or `.unsafe(text)`, `<tag>.raw(text)` or `.execute(text)`
 *    with literal text, whose static text starts with INSERT, UPDATE,
 *    DELETE, MERGE or TRUNCATE, after its comments are stripped and a
 *    leading WITH and its CTEs are walked;
 *  - text with a data-modifying CTE (`as ( insert|update|delete|merge`);
 *  - `.unsafe(x)` or `<tag>.raw(x)` whose text is no literal, unless it is
 *    wrapped in `readSql(...)`.
 * Not findings: reads (FOR UPDATE included), definer calls
 * (`select "public"."mantle_x"(...)`), drizzle typed writes.
 *
 * Where: packages/<name>/src and server/, counted files only (no tests, no
 * migrations), test support left out. A file of the raw write allowlist
 * (raw-write-allowlist.mjs) is held to its own pin there.
 *
 * Pinned-count mode, per file: the rule flags a file over its pin (an
 * unlisted file: 0); eslint-rules/arch-lints.test.ts fails on any other
 * count, so a pin only goes down. Each raw write leaves by becoming a
 * typed drizzle write or a definer call; the scoreboard pins
 * rawWriteSqlScoped and rawSqlNonLiteral are the totals.
 */
import { isCounted, pinnedRule, repoPathOf } from './arch-counts.mjs';
import { isTestSupport, rawWriteSqlSites, rawWriteSwept } from './cleanup-counts.mjs';
import { RAW_WRITE_ALLOWLIST } from './raw-write-allowlist.mjs';

/** Whether the rule reads `path` (repo-relative). */
export function rawWriteLinted(path) {
  return isCounted(path) && rawWriteSwept(path) && !isTestSupport(path);
}

/** The raw write SQL sites of a file (literal writes and non-literal text). */
export function rawWriteSiteCount(text, path) {
  return rawWriteSqlSites(path ?? 'x.ts', text).length;
}

/** @type {Record<string, number>} Raw write sites per file outside the
 *  allowlist (scoped code). */
export const RAW_WRITE_PINS = {
  'packages/db/src/access-matrix.ts': 5,
  'packages/db/src/call-audit.ts': 1,
  'packages/db/src/check-floor.ts': 1,
  'packages/db/src/concurrent-indexes.ts': 1,
  'packages/db/src/content-changed.ts': 1,
  'packages/db/src/email-attachment.ts': 2,
  'packages/db/src/extract-skip-backfill.ts': 1,
  'packages/db/src/gateway/actor-sql.ts': 9,
  'packages/db/src/gateway/check-mode.ts': 1,
  'packages/db/src/gateway/handles.ts': 2,
  'packages/db/src/gateway/pools.ts': 2,
  'packages/db/src/gateway/role-runner.ts': 3,
  'packages/db/src/gateway/role-tx.ts': 1,
  'packages/db/src/gateway/scope.ts': 3,
  'packages/db/src/gateway/system-tx.ts': 1,
  'packages/db/src/gateway/write-route.ts': 1,
  'packages/db/src/grant-reads.ts': 1,
  'packages/db/src/index-work.ts': 1,
  'packages/db/src/init-scratch.ts': 1,
  'packages/db/src/item-acl.ts': 2,
  'packages/db/src/runtime-role.ts': 8,
  'packages/db/src/scope-readable.ts': 5,
  'packages/db/src/space-carry.ts': 4,
  'packages/db/src/store-broker.ts': 1,
  'packages/db/src/viewer-roles.ts': 3,
  'packages/db/src/workspace-live.ts': 1,
  'packages/db/src/workspaces-check.ts': 1,
  'packages/search/src/entities.ts': 1,
  'packages/tools/src/builtins-eval.ts': 1,
  'server/api/src/agent/runtime.ts': 1,
  'server/web/lib/auth/first-owner.ts': 1,
  'server/web/lib/integrity/audit.ts': 5,
  'server/web/lib/integrity/landed.ts': 2,
  'server/web/lib/maintenance/actor-misses-reap.ts': 1,
  'server/web/lib/maintenance/ocr-rescan.ts': 1,
  'server/web/lib/push/store.ts': 1,
  'server/web/scripts/backfill-conversation.ts': 2,
  'server/web/scripts/dedupe-edges.ts': 3,
  'server/web/scripts/extract-backfill.ts': 1,
  'server/web/scripts/extract-images-backfill.ts': 2,
  'server/web/scripts/relations-backfill.ts': 2,
  'server/web/scripts/traces-reap.ts': 1,
};

export const rule = pinnedRule({
  description: 'No raw write SQL in scoped code (plan v3.2 section 3.2).',
  message:
    'Raw write SQL: write through a typed drizzle write or a definer call. Text that only reads and is no literal goes in readSql(...). System work that must stay raw is an allowlist entry (raw-write-allowlist.mjs, review).',
  pins: {
    ...RAW_WRITE_PINS,
    ...Object.fromEntries(Object.entries(RAW_WRITE_ALLOWLIST).map(([f, v]) => [f, v.count])),
  },
  swept: rawWriteLinted,
  count: rawWriteSiteCount,
  repoPath: repoPathOf,
});

export default { rules: { 'no-raw-write-sql': rule } };
