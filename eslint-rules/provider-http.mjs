/**
 * Provider HTTP plumbing (docs/provider-http.md "Timeouts, retries
 * and health"): one deadline helper, one attempt loop, one Retry-After
 * reader, all in @mantle/std http.ts. Each pattern below is counted, and
 * outside its named list the count is 0:
 *
 *  - an inline `AbortSignal.timeout(`: a deadline names a table
 *    entry (PROVIDER_TIMEOUTS / NET_TIMEOUTS) and goes through
 *    `timeoutSignal`, or through a fetch wrapper's `timeoutMs`;
 *  - a hand abort timer, `setTimeout(() => x.abort(...))`: the
 *    same, except a headers-only deadline that is cleared when the headers
 *    arrive (a stream), which `timeoutSignal` cannot express;
 *  - a private `function withTimeout`: `withTimeout` from std;
 *  - a Retry-After header read (or Telegram's body field):
 *    `parseRetryAfterMs` from std;
 *  - a sleeping `for (let attempt ...)` retry loop (the HTTP ones folded into
 *    std `withRetry`): the database retry loops stay, named below, because
 *    they retry a transaction, not a provider call.
 *
 * scripts/arch-scoreboard.ts pins each number; provider-http.test.ts holds
 * each list to exactly the files that still have the pattern. The rule is
 * the editor's early warning: it flags a file outside a list.
 */
import { repoPathOf, stripComments } from './arch-counts.mjs';

/** @typedef {Record<string, string>} AllowList file -> why */

/** @type {AllowList} */
export const INLINE_TIMEOUT_ALLOWED = {
  'packages/std/src/http.ts': 'timeoutSignal itself: the one place the platform deadline is made',
  'scripts/status.mjs':
    'a dependency-free CLI the operator runs from a bare checkout; it cannot import the workspace packages',
  'packages/share-ui/src/canvas-sandbox.tsx':
    'a published browser package that may depend only on client-types and content-core: the deadline of a forwarded canvas data call, named there (CANVAS_DATA_CALL_TIMEOUT_MS)',
};

/** @type {AllowList} */
export const HAND_TIMER_ALLOWED = {
  'packages/std/src/egress.ts': 'the egress fetch deadline (EgressOptions.timeoutMs) itself',
  'packages/std/src/egress-test-net.ts': 'the egress test network deadline, a copy of the above',
  'packages/voice/src/adapters/provider-fetch.ts':
    'the provider pool deadline (ProviderFetchOptions.timeoutMs) itself: cleared at the headers of a stream',
  'packages/voice/src/adapters/sse.ts':
    'a stream connect deadline, cleared when the headers arrive',
  'packages/tools/src/mcp-client.ts':
    'an MCP SSE stream headers deadline, cleared when the headers arrive',
};

/** @type {AllowList} */
export const WITH_TIMEOUT_ALLOWED = {
  'packages/std/src/http.ts': 'withTimeout itself',
};

/** @type {AllowList} */
export const RETRY_AFTER_ALLOWED = {
  'packages/std/src/http.ts': 'parseRetryAfterMs itself',
};

/** @type {AllowList} */
export const BACKOFF_LOOP_ALLOWED = {
  'packages/std/src/http.ts': 'withRetry itself',
  'packages/db/src/access-matrix.ts':
    'a database role sync retried on a serialization failure, not a provider call',
  'packages/db/src/gateway/heads.ts':
    'a transaction retried on a serialization failure or deadlock',
  'packages/db/src/viewer-roles.ts': 'a database role create retried on a concurrent create',
  'packages/db/src/test-support.ts':
    'a test helper retrying CREATE DATABASE while template1 is busy',
  'server/api/src/bench/run.ts':
    'the memory benchmark retrying CREATE DATABASE while its template is busy',
  'server/web/scripts/extract-images-backfill.ts':
    'a one-shot backfill script retrying a database delete on a concurrent change',
};

/** Inline `AbortSignal.timeout(` sites in `code` (comments blanked). */
export function inlineTimeouts(code) {
  return (code.match(/\bAbortSignal\.timeout\(/g) ?? []).length;
}

/** Hand abort timers: `setTimeout(() => x.abort(` in `code`. */
export function handAbortTimers(code) {
  return (code.match(/setTimeout\(\s*\(\)\s*=>\s*[\w.]+\.abort\(/g) ?? []).length;
}

/** Private `function withTimeout` definitions in `code`. */
export function withTimeoutCopies(code) {
  return (code.match(/\bfunction\s+withTimeout\s*[<(]/g) ?? []).length;
}

/** Retry-After header reads (`.get('retry-after')`, any case) in `code`. */
export function retryAfterReads(code) {
  return (code.match(/\.get\??\.?\(\s*['"`]retry-after['"`]\s*\)/gi) ?? []).length;
}

/** Sleeping retry loops: `for (let attempt` in a file that also waits
 *  (`await sleep(` or a `setTimeout(r, ...)` promise). */
export function backoffLoops(code) {
  if (!/await\s+sleep\(|setTimeout\(\s*(?:r|resolve)\s*,/.test(code)) return 0;
  return (code.match(/\bfor\s*\(\s*let\s+attempt\b/g) ?? []).length;
}

/** Each pattern: its counter and its named list. */
export const PROVIDER_HTTP_PATTERNS = {
  inlineTimeout: { count: inlineTimeouts, allowed: INLINE_TIMEOUT_ALLOWED },
  handAbortTimer: { count: handAbortTimers, allowed: HAND_TIMER_ALLOWED },
  withTimeoutCopy: { count: withTimeoutCopies, allowed: WITH_TIMEOUT_ALLOWED },
  retryAfterRead: { count: retryAfterReads, allowed: RETRY_AFTER_ALLOWED },
  backoffLoop: { count: backoffLoops, allowed: BACKOFF_LOOP_ALLOWED },
};

const MESSAGES = {
  inlineTimeout:
    'Name the deadline in PROVIDER_TIMEOUTS / NET_TIMEOUTS (@mantle/std) and use timeoutSignal(ms), or the fetch wrapper option (providerFetch / egressFetch timeoutMs), not an inline AbortSignal.timeout().',
  handAbortTimer:
    'Use timeoutSignal(ms) from @mantle/std for a deadline; a headers-only deadline is named in eslint-rules/provider-http.mjs.',
  withTimeoutCopy: 'Use withTimeout(promise, ms, label) from @mantle/std.',
  retryAfterRead: 'Read Retry-After with parseRetryAfterMs from @mantle/std.',
  backoffLoop:
    'Retry with withRetry (and backoffMs) from @mantle/std, stating the attempt budget and delays as options.',
};

function ruleFor(key) {
  const { count, allowed } = PROVIDER_HTTP_PATTERNS[key];
  return {
    meta: {
      type: 'problem',
      docs: { description: `provider HTTP plumbing (A10 #10): ${key}` },
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
  Object.keys(PROVIDER_HTTP_PATTERNS).map((k) => [k, ruleFor(k)]),
);

export default { rules };
