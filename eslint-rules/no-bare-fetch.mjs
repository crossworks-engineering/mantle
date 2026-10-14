/**
 * no-bare-fetch (A10 part 1, docs/egress.md): in the packages that fetch a
 * URL a user, a model, a remote server or a linked peer gave (@mantle/tools,
 * @mantle/calendar, @mantle/content), every outbound fetch goes through the
 * one egress fetch (`egressFetch` in @mantle/std/egress, or the tools'
 * guardedFetch / safeFetch over it): the address check on every hop, secret
 * headers dropped across origins, a deadline and a streamed byte cap.
 *
 * The rule flags a bare `fetch(` (or `globalThis.fetch(`) in those packages
 * outside BARE_FETCH_ALLOWED: the files whose fetch goes to a host the code
 * fixes (a provider's API, a service of the stack). Each entry says why.
 * Tests are not product code. scripts/arch-scoreboard.ts pins the number of
 * bare fetch sites in the swept packages (bareFetchSites), so it can only go
 * down.
 */
import { repoPathOf } from './arch-counts.mjs';

/** The packages swept: their fetches take outside URLs. */
export const BARE_FETCH_SWEPT = [
  'packages/tools/src/',
  'packages/calendar/src/',
  'packages/content/src/',
];

/** @type {Record<string, string>} files whose fetch goes to a fixed host */
export const BARE_FETCH_ALLOWED = {
  'packages/tools/src/builtins-locations.ts':
    'Mapbox static images: the host is a constant (STATIC_MAP_BASE)',
  'packages/tools/src/builtins-curation.ts':
    'the OpenRouter Data API: the host is a constant (OR_BASE)',
  'packages/tools/src/sandbox/common.ts':
    "sandboxd's control API: the host is the stack's own SANDBOXD_URL",
};

/** Whether `path` (repo-relative) is swept. */
export function bareFetchSwept(path) {
  if (!path || !/\.(ts|tsx|mjs|js)$/.test(path)) return false;
  if (/\.test\.tsx?$/.test(path) || path.endsWith('.d.ts')) return false;
  return BARE_FETCH_SWEPT.some((p) => path.startsWith(p));
}

/** Whether a call's callee is the platform fetch. */
function isBareFetch(callee) {
  if (callee.type === 'Identifier') return callee.name === 'fetch';
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'globalThis' &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'fetch'
  );
}

export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Outbound fetches of outside URLs go through the one egress fetch (A10 part 1).',
    },
    messages: {
      bare: 'A bare fetch( in a package that fetches outside URLs. Use egressFetch (@mantle/std/egress), or guardedFetch / safeFetch in @mantle/tools; a fixed-host provider call is listed in eslint-rules/no-bare-fetch.mjs with its reason (review). See docs/egress.md.',
    },
    schema: [],
  },
  create(context) {
    const path = repoPathOf(context.filename);
    if (!bareFetchSwept(path) || Object.hasOwn(BARE_FETCH_ALLOWED, path)) return {};
    return {
      CallExpression(node) {
        if (isBareFetch(node.callee)) context.report({ node, messageId: 'bare' });
      },
    };
  },
};

export default { rules: { 'no-bare-fetch': rule } };
