/**
 * Small helpers and process plumbing copied back (docs/std-helpers.md).
 * Each helper has one home, and each hand copy is counted; outside its
 * named list the count is 0:
 *
 *  - uuidCopy: an anchored UUID regex literal, inline ones too; UUID_RE is
 *    @mantle/std's;
 *  - errorIdiom: `err instanceof Error ? err.message : …` by hand;
 *    errorMessage(err) (@mantle/std) where the fallback is String(err).
 *    The files below keep one whose fallback differs (the value itself, a
 *    fixed text), or cannot import std;
 *  - dedupeTagsCopy: a `function dedupeTags`: @mantle/content
 *    tags.ts;
 *  - signalHandler: a SIGINT or SIGTERM listener on any receiver, the
 *    event a string or a name bound to one (read from the syntax tree):
 *    onShutdown (@mantle/std/shutdown), with its exit deadline;
 *  - advisoryLock: an advisory lock in SQL: advisoryXactLock and
 *    tryAdvisoryXactLock (@mantle/db advisory-lock.ts);
 *  - ttlAgeCheck: a hand TTL cache's age check (`<clock> - <stamp>` against
 *    a TTL-ish bound or with a cache stamp, an `expiresAt` against the
 *    clock; read from the syntax tree): TtlCache (@mantle/std);
 *  - cacheControlLiteral: a Cache-Control value not from CACHE_CONTROL
 *    (server/web/lib/cache-control.ts), however the header is set (a call,
 *    an object key, a [name, value] pair, an index assignment; read from the
 *    syntax tree); no-store is the /api default.
 *
 * Three counts have no list: they are pinned and may only go down
 * (scripts/arch-scoreboard.pins.json): console calls outside scripts (moved
 * to log(scope) file by file as files are touched), a live workspace
 * spelled by hand (`archived_at is null` in SQL, `isNull(workspaces.
 * archivedAt)` in drizzle: liveWorkspace and its twins, @mantle/db), and the
 * files that set Cache-Control at all.
 *
 * std-helpers.test.ts holds each list to exactly the files that still have
 * the pattern, each with a reason. The rules are the editor's early warning:
 * a file outside a list is flagged.
 */
import ts from 'typescript';
import { repoPathOf, stripComments } from './arch-counts.mjs';

/** @typedef {Record<string, string>} AllowList file -> why */

/** @type {AllowList} */
export const UUID_COPY_ALLOWED = {
  'packages/std/src/index.ts': 'UUID_RE itself',
  'packages/content-core/src/uuid.ts':
    'a published contract package: it takes no dependency (its one copy, read by app-nav, profile-projections and canvas-data)',
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
  'packages/content/src/app-broker.ts':
    "a restore marker file's age on disk (its mtime), shared by every process: not an in-process cache",
  'packages/files/src/thumbnail.ts':
    "a failure marker file's age on disk (its mtime), shared by every process: not an in-process cache",
  'server/web/lib/updates.ts':
    "one slot whose age runs from the check's own stamp (taken before the fetch, and served to the page), its TTL chosen by the answer",
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

// ── the AST counts: a respelling does not hide a site ───────────────────

/** @param {string} code @param {string} [path] */
function parse(code, path = 'x.ts') {
  return ts.createSourceFile(
    path,
    code,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') || path.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** Each node of `sf`, depth first. */
function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** Through parentheses, `as`, `satisfies` and `!`. */
function unwrap(node) {
  let n = node;
  while (
    n &&
    (ts.isParenthesizedExpression(n) ||
      ts.isAsExpression(n) ||
      ts.isSatisfiesExpression(n) ||
      ts.isNonNullExpression(n) ||
      ts.isTypeAssertionExpression(n))
  ) {
    n = n.expression;
  }
  return n;
}

/** The text of a string literal (or a template with no substitution). */
function literalText(node) {
  const n = unwrap(node);
  return n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;
}

/** Every binding of a name in the file to the expression it is bound from:
 *  a variable's initializer, a for-of's iterable, and a callback parameter's
 *  array (`[...].forEach((x) => ...)`). */
function bindingsOf(sf) {
  /** @type {Map<string, import('typescript').Node[]>} */
  const out = new Map();
  const add = (name, from) => {
    if (!from) return;
    const list = out.get(name) ?? [];
    list.push(from);
    out.set(name, list);
  };
  walk(sf, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      const loop = n.parent?.parent;
      if (loop && ts.isForOfStatement(loop)) add(n.name.text, loop.expression);
      else add(n.name.text, n.initializer);
    }
    if (ts.isParameter(n) && ts.isIdentifier(n.name)) {
      const fn = n.parent;
      const call = fn?.parent;
      if (
        call &&
        ts.isCallExpression(call) &&
        ts.isPropertyAccessExpression(call.expression) &&
        call.arguments.includes(fn)
      ) {
        add(n.name.text, call.expression.expression);
      }
    }
  });
  return out;
}

const SIGNAL = /^SIG(?:INT|TERM)$/;
const LISTEN = new Set(['on', 'once', 'addListener', 'prependListener', 'prependOnceListener']);

/** Whether `node` (or what a name in it is bound from, a level or two deep)
 *  holds a SIGINT or SIGTERM string. */
function namesSignal(node, bindings, depth = 0) {
  let found = false;
  const look = (n) => {
    if (found) return;
    const text = literalText(n);
    if (text !== null && SIGNAL.test(text)) {
      found = true;
      return;
    }
    if (ts.isIdentifier(n) && depth < 3) {
      for (const from of bindings.get(n.text) ?? []) {
        if (namesSignal(from, bindings, depth + 1)) {
          found = true;
          return;
        }
      }
    }
    ts.forEachChild(n, look);
  };
  look(node);
  return found;
}

/** SIGINT / SIGTERM handlers in `code`: a listener (`on`, `once`,
 *  `addListener`, `prepend…`) on any receiver whose event is SIGINT or
 *  SIGTERM, spelled as a string or through a name bound to one (a const, a
 *  for-of over a list, a forEach callback's parameter). */
export function signalHandlers(code, path) {
  if (!/SIG(?:INT|TERM)/.test(code)) return 0;
  const sf = parse(code, path);
  const bindings = bindingsOf(sf);
  let n = 0;
  walk(sf, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    if (!LISTEN.has(node.expression.name.text)) return;
    const event = node.arguments[0];
    if (event && namesSignal(event, bindings)) n += 1;
  });
  return n;
}

/** Advisory lock functions called in SQL in `code`. */
export function advisoryLocks(code) {
  return (code.match(/\bpg_(?:try_)?advisory_(?:xact_)?(?:un)?lock(?:_shared|_all)?\(/g) ?? [])
    .length;
}

const COMPARE = new Set([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);
/** A TTL-ish bound: the constant a cache's age is held to. */
const TTL_BOUND = /ttl|max_?age|stale|fresh|cache|backoff|expir|lifetime/i;
/** A cache entry's stamp. */
const STAMP =
  /(?:\.at|(?:^|\.)(?:fetched|cached|stored|loaded|checked)At|(?:^|\.)\w+(?:Fetched|Cached|Stored|Loaded|Checked)At)$/;

/** A clock read: Date.now(), now(), this.now(), performance.now(), `now`. */
function isNow(node) {
  const n = unwrap(node);
  if (!n) return false;
  if (ts.isIdentifier(n)) return n.text === 'now';
  if (!ts.isCallExpression(n) || n.arguments.length) return false;
  const callee = n.expression;
  if (ts.isIdentifier(callee)) return callee.text === 'now';
  return ts.isPropertyAccessExpression(callee) && callee.name.text === 'now';
}

/** Hand TTL age checks in `code`: an age (`<clock> - <stamp>`) compared with
 *  a TTL-ish bound (a name with ttl, max age, stale, fresh, cache, backoff,
 *  expiry or lifetime in it) or a cache entry's stamp (`.at`, `fetchedAt`,
 *  `cachedAt`, ...) against any bound; and an `expiresAt` against the
 *  clock. Not seen (the limit): an age kept in a variable first and
 *  compared later, a stamp and a bound both named otherwise. */
export function ttlAgeChecks(code, path) {
  if (!/now/.test(code)) return 0;
  const sf = parse(code, path);
  let n = 0;
  walk(sf, (node) => {
    if (!ts.isBinaryExpression(node) || !COMPARE.has(node.operatorToken.kind)) return;
    const left = unwrap(node.left);
    const right = unwrap(node.right);
    for (const [age, bound] of [
      [left, right],
      [right, left],
    ]) {
      if (
        ts.isBinaryExpression(age) &&
        age.operatorToken.kind === ts.SyntaxKind.MinusToken &&
        isNow(age.left)
      ) {
        const stamp = unwrap(age.right).getText(sf);
        if (STAMP.test(stamp) || TTL_BOUND.test(bound.getText(sf))) {
          n += 1;
          return;
        }
      }
      if (/(?:^|\.)expiresAt$/.test(age.getText(sf)) && isNow(bound)) {
        n += 1;
        return;
      }
    }
  });
  return n;
}

const SET_HEADER = new Set(['set', 'append', 'header', 'setHeader']);

/** Whether `node` is a Cache-Control value from the one table: a
 *  CACHE_CONTROL member, API_CACHE_DEFAULT, a cacheHeaders() call, a choice
 *  between such, or a name bound to one. */
function fromTable(node, bindings, depth = 0) {
  const n = unwrap(node);
  if (!n) return false;
  if (
    (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) &&
    ts.isIdentifier(n.expression) &&
    n.expression.text === 'CACHE_CONTROL'
  ) {
    return true;
  }
  if (ts.isIdentifier(n)) {
    if (n.text === 'API_CACHE_DEFAULT') return true;
    const from = bindings.get(n.text) ?? [];
    return depth < 3 && from.length > 0 && from.every((f) => fromTable(f, bindings, depth + 1));
  }
  if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
    return n.expression.text === 'cacheHeaders';
  }
  if (ts.isConditionalExpression(n)) {
    return fromTable(n.whenTrue, bindings, depth) && fromTable(n.whenFalse, bindings, depth);
  }
  return false;
}

const isCacheControl = (node) => literalText(node)?.toLowerCase() === 'cache-control';

/** Cache-Control values in `code` that are not from CACHE_CONTROL: the header
 *  set through a call (`headers.set`, `append`, Hono's `c.header`, node's
 *  `setHeader`), an object literal key, a `[name, value]` pair (new
 *  Headers([...]), a list of entries) or an index assignment, whose value is
 *  anything else (a literal, a parameter, a template). */
export function cacheControlLiterals(code, path) {
  if (!/cache-control/i.test(code)) return 0;
  const sf = parse(code, path);
  const bindings = bindingsOf(sf);
  let n = 0;
  const check = (value) => {
    if (value && !fromTable(value, bindings)) n += 1;
  };
  walk(sf, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      SET_HEADER.has(node.expression.name.text) &&
      node.arguments.length >= 2 &&
      isCacheControl(node.arguments[0])
    ) {
      check(node.arguments[1]);
    } else if (ts.isPropertyAssignment(node)) {
      const key = ts.isComputedPropertyName(node.name) ? node.name.expression : node.name;
      if (isCacheControl(key)) check(node.initializer);
    } else if (
      ts.isArrayLiteralExpression(node) &&
      node.elements.length === 2 &&
      isCacheControl(node.elements[0])
    ) {
      check(node.elements[1]);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(unwrap(node.left)) &&
      isCacheControl(unwrap(node.left).argumentExpression)
    ) {
      check(node.right);
    }
  });
  return n;
}

/** Console calls in `code`. */
export function consoleCalls(code) {
  return (code.match(/\bconsole\.(?:log|info|warn|error|debug)\(/g) ?? []).length;
}

/** A live workspace spelled by hand in `code`: `archived_at is null` in SQL
 *  (quoted or not, any case) and `isNull(workspaces.archivedAt)` in a
 *  drizzle where clause (liveWorkspace, liveWorkspaceSql, liveWorkspaceText). */
export function archivedAtIsNull(code) {
  const inSql = code.match(/(?:\b|")archived_at"?\s+is\s+null\b/gi) ?? [];
  const inDrizzle = code.match(/\bisNull\(\s*(?:\w+\.)?workspaces\.archivedAt\s*\)/g) ?? [];
  return inSql.length + inDrizzle.length;
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
          if (count(stripComments(context.sourceCode.getText()), path) > 0) {
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
