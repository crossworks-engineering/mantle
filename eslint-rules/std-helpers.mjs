/**
 * Small helpers and process plumbing copied back (A10 #15, gateway survey
 * finding 15; docs/std-helpers.md). Each helper has one home now, and each
 * hand copy is counted; outside its named list the count is 0:
 *
 *  - uuidCopy: an anchored UUID regex literal; UUID_RE is @mantle/std's
 *    (28 copies before, 34 with the inline ones);
 *  - errorIdiom: `err instanceof Error ? err.message : …` by hand;
 *    errorMessage(err) (@mantle/std) where the fallback is String(err).
 *    The files below keep one whose fallback differs (the value itself, a
 *    fixed text), or cannot import std;
 *  - dedupeTagsCopy: a `function dedupeTags` (12 before): @mantle/content
 *    tags.ts;
 *  - signalHandler: a SIGINT or SIGTERM handler (3 before):
 *    onShutdown (@mantle/std/shutdown), with its exit deadline;
 *  - advisoryLock: an advisory lock in SQL (11 before): advisoryXactLock
 *    and tryAdvisoryXactLock (@mantle/db advisory-lock.ts), each site's key
 *    and hash as on main;
 *  - ttlAgeCheck: a hand TTL cache's age check (`now - hit.at < TTL`, an
 *    `expiresAt > now`; 16 before): TtlCache (@mantle/std);
 *  - cacheControlLiteral: a literal Cache-Control value: CACHE_CONTROL
 *    (server/web/lib/cache-control.ts), and no-store is the /api default.
 *
 * Three counts have no list: they are pinned and may only go down
 * (scripts/arch-scoreboard.pins.json): console calls outside scripts (moved
 * to log(scope) file by file as files are touched), the hand
 * `archived_at is null` (liveWorkspaceSql, @mantle/db), and the files that
 * set Cache-Control at all.
 *
 * std-helpers.test.ts holds each list to exactly the files that still have
 * the pattern, each with a reason. The rules are the editor's early warning:
 * a file outside a list is flagged.
 */
import { repoPathOf, stripComments } from './arch-counts.mjs';

/** @typedef {Record<string, string>} AllowList file -> why */

/** @type {AllowList} */
export const UUID_COPY_ALLOWED = {
  'packages/std/src/index.ts': 'UUID_RE itself',
  'packages/content-core/src/app-nav.ts':
    'a published contract package: it takes no dependency (reads either case, as std)',
  'packages/content-core/src/profile-projections.ts':
    'a published contract package: it takes no dependency',
  'server/sandboxd/src/main.ts': 'the sandbox daemon takes no workspace dependency',
};

/** @type {AllowList} */
export const ERROR_IDIOM_ALLOWED = {
  'packages/app-build/src/index.ts': 'a published contract package: it takes no dependency',
  'packages/content-core/src/formula-dimensions.ts':
    'a published contract package: it takes no dependency',
  'packages/content-core/src/formula-eval.ts':
    'a published contract package: it takes no dependency',
  'packages/content-core/src/formula-spec.ts':
    'a published contract package: it takes no dependency',
  'packages/content/src/app-folders.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'packages/content/src/app-nav.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'packages/content/src/draw-png-render.ts':
    'runs as a bare worker thread (node type stripping): it imports nothing of the workspace',
  'packages/content/src/profile-preferences.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'packages/content/src/table-storage.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'packages/content/src/tree/write.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'packages/db/src/drop-viewer-logins.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'packages/db/src/notify.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'packages/db/src/store-broker.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'packages/db/src/viewer.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'packages/email/src/backfill-rfc-message-id.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'packages/email/src/discover.ts': 'the fallback is a fixed text, not String(err)',
  'packages/embeddings/src/index.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'packages/embeddings/src/provider-outage.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'packages/files/src/ops/files.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'packages/files/src/thumbnail.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'packages/files/src/transcode.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'packages/mcp-core/src/create-home.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'packages/runs/src/boss.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'packages/runs/src/notify.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'packages/runtime/src/agent/conversation.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'packages/runtime/src/assistant/assemble-turn.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'packages/runtime/src/assistant/run-turn.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'packages/runtime/src/heartbeats/fire.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'packages/runtime/src/heartbeats/notify.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'packages/runtime/src/heartbeats/tick.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'packages/share-ui/src/app-sandbox.tsx': 'a published contract package: it takes no dependency',
  'packages/share-ui/src/formula-calculator.tsx':
    'a published contract package: it takes no dependency',
  'packages/std/src/db-watch.ts': '@mantle/std itself: errorMessage is defined here',
  'packages/std/src/egress-test-net.ts': '@mantle/std itself: errorMessage is defined here',
  'packages/std/src/index.ts': '@mantle/std itself: errorMessage is defined here',
  'packages/telegram/src/outbound.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'packages/tools/src/pending-notify.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'packages/tools/src/tool-results.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'packages/turn-stream/src/publish.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'packages/voice/src/adapters/openrouter-tts.ts': 'the fallback is a fixed text, not String(err)',
  'packages/voice/src/adapters/sse.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'server/api/src/agent/extract-queue.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'server/api/src/agent/extract/entities.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'server/api/src/agent/extract/facts.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'server/api/src/agent/extract/gates.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'server/api/src/agent/extract/terminal.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'server/api/src/agent/reflector.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'server/api/src/agent/runtime.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'server/api/src/agent/ticker.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'server/api/src/turn-narration.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'server/api/src/turn-suggestion.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'server/web/app/api/apps/[id]/format/route.ts': 'the fallback is a fixed text, not String(err)',
  'server/web/app/api/mcp-status/route.ts': 'the fallback is a fixed text, not String(err)',
  'server/web/lib/onboarding-steps.ts': 'the fallback is a fixed text, not String(err)',
  'server/web/lib/runners.ts':
    'a local errorMessage of another meaning (the DBOS error shape) shadows the std one',
  'server/web/lib/snapshot-copies.ts': 'the fallback is a fixed text, not String(err)',
  'server/web/lib/system-manifest/reconcile.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'server/web/lib/workspaces-migrate.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
  'server/web/scripts/chunk-windows.ts': 'a repo script, run on its own',
  'server/web/scripts/classify-backfill.ts': 'a repo script, run on its own',
  'server/web/scripts/doc-reindex.ts': 'a repo script, run on its own',
  'server/web/scripts/eval-recall.ts': 'a repo script, run on its own',
  'server/web/scripts/eval-route.ts': 'a repo script, run on its own',
  'server/web/scripts/journal-rules-reconcile.ts': 'a repo script, run on its own',
  'server/web/scripts/ocr-rescan.ts': 'a repo script, run on its own',
  'server/web/scripts/persona-notes-to-journal.ts': 'a repo script, run on its own',
  'server/web/scripts/pgboss-init.ts': 'a repo script, run on its own',
  'server/web/scripts/refold-embeds.ts': 'a repo script, run on its own',
  'server/web/scripts/regenerate-digests.ts': 'a repo script, run on its own',
  'server/web/scripts/snapshot-copies.ts': 'a repo script, run on its own',
  'server/web/scripts/ws-clear-member-ticks.ts': 'a repo script, run on its own',
  'server/web/scripts/ws-team-check.ts': 'a repo script, run on its own',
  'server/web/workers/runs.ts':
    'the fallback is the value itself (a non-Error logs as itself, errorMessage would log String(err))',
};

/** @type {AllowList} */
export const DEDUPE_TAGS_ALLOWED = {
  'packages/content/src/tags.ts': 'dedupeTags itself',
};

/** @type {AllowList} */
export const SIGNAL_HANDLER_ALLOWED = {
  'packages/std/src/shutdown.ts': 'onShutdown itself',
};

/** @type {AllowList} */
export const ADVISORY_LOCK_ALLOWED = {
  'packages/db/src/advisory-lock.ts': 'advisoryXactLock and tryAdvisoryXactLock themselves',
  'packages/db/src/share-lock.ts':
    'the folder-share lock: shared, its key a SQL function the triggers take too',
  'packages/db/src/test-support.ts':
    'a session lock that serialises test processes on one database (and its release)',
};

/** @type {AllowList} */
export const TTL_AGE_CHECK_ALLOWED = {
  'packages/std/src/ttl-cache.ts': 'TtlCache itself',
  'packages/config/src/services.ts':
    'one slot keyed by its directory, in @mantle/config, which takes no @mantle/std dependency',
  'packages/embeddings/src/provider-outage.ts':
    'an alert state read once a minute, on a clock each call passes in',
  'packages/search/src/scope.ts':
    'shared in-flight counts, cleared whole past 500 entries (not least recently used)',
  'packages/tools/src/oauth2-client-credentials.ts':
    "a token held for the provider's own lifetime, on a clock each call passes in",
  'packages/tracing/src/model-context.ts':
    'the one OpenRouter catalog: refreshed past its TTL, the last good rows kept on a failure',
};

/** @type {AllowList} */
export const CACHE_CONTROL_LITERAL_ALLOWED = {};

const UUID_LITERAL =
  /\/\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$\/i?/g;

/** Anchored UUID regex literals in `code`. */
export function uuidCopies(code) {
  return (code.match(UUID_LITERAL) ?? []).length;
}

/** Hand error-to-message ternaries in `code`. */
export function errorIdioms(code) {
  return (code.match(/(\b[\w.]+) instanceof Error\s*\?\s*\1\.message\s*:/g) ?? []).length;
}

/** `function dedupeTags` definitions in `code`. */
export function dedupeTagsCopies(code) {
  return (code.match(/\bfunction\s+dedupeTags\s*\(/g) ?? []).length;
}

/** SIGINT / SIGTERM handlers in `code`. */
export function signalHandlers(code) {
  return (code.match(/\b(?:process|proc)\.(?:on|once)\(\s*(?:['"]SIG[A-Z]+['"]|signal\b)/g) ?? [])
    .length;
}

/** Advisory lock functions called in SQL in `code`. */
export function advisoryLocks(code) {
  return (code.match(/\bpg_(?:try_)?advisory_(?:xact_)?(?:un)?lock(?:_shared|_all)?\(/g) ?? [])
    .length;
}

/** Hand TTL age checks in `code`: an entry's stamp against a constant. */
export function ttlAgeChecks(code) {
  const age =
    /(?:\bDate\.now\(\)|\bnow(?:\(\))?|this\.now\(\))\s*-\s*(?:(?:\w+\.)+(?:at|fetchedAt|cachedAt)|\w*FetchedAt)\b\s*[<>]=?/g;
  const expiry = /\.expiresAt\s*>\s*(?:Date\.now\(\)|now\(\)|now\b)/g;
  return (code.match(age) ?? []).length + (code.match(expiry) ?? []).length;
}

/** Literal Cache-Control values in `code`: a header key with a string. */
export function cacheControlLiterals(code) {
  return (
    code.match(
      /['"]cache-control['"]\s*:\s*['"`]|\.(?:header|set)\(\s*['"]cache-control['"]\s*,\s*['"`]/gi,
    ) ?? []
  ).length;
}

/** Console calls in `code`. */
export function consoleCalls(code) {
  return (code.match(/\bconsole\.(?:log|info|warn|error|debug)\(/g) ?? []).length;
}

/** Hand `archived_at is null` in `code`. */
export function archivedAtIsNull(code) {
  return (code.match(/\barchived_at\s+is\s+null\b/gi) ?? []).length;
}

/** Whether `code` names the Cache-Control header at all. */
export function setsCacheControl(code) {
  return /['"]cache-control['"]/i.test(code) ? 1 : 0;
}

/** A repo script (console is its interface): not in the console count. */
export function isScript(path) {
  return path.startsWith('scripts/') || path.includes('/scripts/');
}

/** Each listed pattern: its counter and its named list. */
export const STD_HELPER_PATTERNS = {
  uuidCopy: { count: uuidCopies, allowed: UUID_COPY_ALLOWED },
  errorIdiom: { count: errorIdioms, allowed: ERROR_IDIOM_ALLOWED },
  dedupeTagsCopy: { count: dedupeTagsCopies, allowed: DEDUPE_TAGS_ALLOWED },
  signalHandler: { count: signalHandlers, allowed: SIGNAL_HANDLER_ALLOWED },
  advisoryLock: { count: advisoryLocks, allowed: ADVISORY_LOCK_ALLOWED },
  ttlAgeCheck: { count: ttlAgeChecks, allowed: TTL_AGE_CHECK_ALLOWED },
  cacheControlLiteral: { count: cacheControlLiterals, allowed: CACHE_CONTROL_LITERAL_ALLOWED },
};

const MESSAGES = {
  uuidCopy: 'Import UUID_RE (or isUuid) from @mantle/std, not a copy of the regex.',
  errorIdiom:
    'Use errorMessage(err) from @mantle/std; a site whose fallback differs is named in eslint-rules/std-helpers.mjs.',
  dedupeTagsCopy: "Import dedupeTags from '@mantle/content/tags'.",
  signalHandler:
    'Install signal handlers with onShutdown (@mantle/std/shutdown): one guard, one exit deadline.',
  advisoryLock:
    'Take an advisory lock with advisoryXactLock / tryAdvisoryXactLock (@mantle/db), naming its hash.',
  ttlAgeCheck: 'Cache with TtlCache (@mantle/std), not a hand age check.',
  cacheControlLiteral:
    'Name the policy from CACHE_CONTROL (server/web/lib/cache-control.ts); /api answers no-store by default.',
};

function ruleFor(key) {
  const { count, allowed } = STD_HELPER_PATTERNS[key];
  return {
    meta: {
      type: 'problem',
      docs: { description: `small helpers copied back (A10 #15): ${key}` },
      messages: { over: MESSAGES[key] },
      schema: [],
    },
    create(context) {
      const path = repoPathOf(context.filename);
      if (!path || Object.hasOwn(allowed, path)) return {};
      return {
        Program(node) {
          if (count(stripComments(context.sourceCode.getText())) > 0) {
            context.report({ node, messageId: 'over' });
          }
        },
      };
    },
  };
}

export const rules = Object.fromEntries(
  Object.keys(STD_HELPER_PATTERNS).map((k) => [k, ruleFor(k)]),
);

export default { rules };
