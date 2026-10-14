/**
 * no-bare-fetch (A10 part 1, docs/egress.md): an outbound fetch of a URL a
 * user, a model, a remote server or a linked peer gave goes through the one
 * egress fetch (`egressFetch` in @mantle/std/egress, or the tools'
 * guardedFetch / safeFetch over it): the address check on every hop, the
 * connection pinned to a checked address, secret headers dropped across
 * origins, a deadline and a streamed byte cap.
 *
 * Swept: all product code under packages/ and server/{web,api}/ (tests and
 * scripts are not product code). The rule flags any use of the platform
 * fetch there: a bare `fetch(`, `fetch` passed or kept as a value (an
 * alias), and `globalThis.fetch`, `window.fetch`, `self.fetch` or
 * `globalThis['fetch']`, called or not. BARE_FETCH_ALLOWED is the inventory
 * of the files that may: each says which kind of host it reaches and why,
 * and no-bare-fetch.test.ts holds the list to exactly the files that do.
 * scripts/arch-scoreboard.ts still pins the bare fetch sites of the first
 * three packages swept (bareFetchSites), so that count can only go down.
 */
import { bareFetchSites, repoPathOf, stripComments } from './arch-counts.mjs';

/** The trees swept: product code that could fetch an outside URL. */
export const BARE_FETCH_SWEPT = ['packages/', 'server/web/', 'server/api/'];

/** The kinds of host an allowed file reaches. */
export const BARE_FETCH_KINDS = [
  // A host the code fixes: a provider's API or a public service.
  'fixed provider host',
  // A URL the owner or an admin configured (a service of the stack, a
  // relay, a local model): trusted config, not an outside URL.
  'owner config',
  // The box's own origin (a browser call to /api or /s, the box's own
  // public URL).
  'same-origin internal',
  // A URL a fixed provider returned in its own answer.
  'provider-returned',
  // The egress layer and the provider pool themselves.
  'fetch layer',
];

/**
 * The inventory: each file that may use the platform fetch, with the kind
 * of host it reaches and why.
 * @type {Record<string, { kind: string; why: string }>}
 */
export const BARE_FETCH_ALLOWED = {
  'packages/std/src/egress.ts': {
    kind: 'fetch layer',
    why: 'the one egress fetch: the platform fetch behind its checks and the pinned dispatcher',
  },
  'packages/voice/src/adapters/provider-fetch.ts': {
    kind: 'fetch layer',
    why: 'the model-provider HTTP pool (fetchVia): provider hosts and the owner-configured local model base URLs',
  },
  'packages/tools/src/builtins-locations.ts': {
    kind: 'fixed provider host',
    why: 'Mapbox static images: the host is a constant (STATIC_MAP_BASE)',
  },
  'packages/tools/src/builtins-curation.ts': {
    kind: 'fixed provider host',
    why: 'the OpenRouter Data API: the host is a constant (OR_BASE)',
  },
  'packages/tracing/src/model-context.ts': {
    kind: 'fixed provider host',
    why: 'the OpenRouter models list: the host is a constant (OPENROUTER_MODELS_URL)',
  },
  'packages/microsoft/src/client.ts': {
    kind: 'fixed provider host',
    why: 'Microsoft Graph: the host is a constant',
  },
  'packages/microsoft/src/oauth.ts': {
    kind: 'fixed provider host',
    why: 'the Microsoft identity platform token endpoint and Graph /me: constant hosts',
  },
  'packages/microsoft/src/drives/sync.ts': {
    kind: 'provider-returned',
    why: "the pre-authenticated download URL in Graph's own drive item answer",
  },
  'packages/telegram/src/outbound.ts': {
    kind: 'fixed provider host',
    why: 'the Telegram file CDN: the host is a constant (api.telegram.org)',
  },
  'server/web/lib/agent-telegram.ts': {
    kind: 'fixed provider host',
    why: 'the Telegram Bot API getMe: the host is a constant',
  },
  'server/web/lib/maintenance/curate-pools-run.ts': {
    kind: 'fixed provider host',
    why: 'the OpenRouter Data API: the host is a constant (OR_BASE)',
  },
  'server/web/lib/maintenance/deps-drift.ts': {
    kind: 'fixed provider host',
    why: 'the npm registry: the host is a constant',
  },
  'server/web/lib/updates.ts': {
    kind: 'fixed provider host',
    why: 'the GitHub releases API: the host is a constant',
  },
  'server/web/lib/model-explorer.ts': {
    kind: 'fixed provider host',
    why: 'the provider model catalogues: hosts from the fixed provider table',
  },
  'server/api/src/bench/run.ts': {
    kind: 'fixed provider host',
    why: 'the memory benchmark datasets: URLs from the fixed DATA_SOURCES table',
  },
  'packages/tools/src/sandbox/common.ts': {
    kind: 'owner config',
    why: "sandboxd's control API: the stack's own SANDBOXD_URL",
  },
  'server/web/lib/sandboxd.ts': {
    kind: 'owner config',
    why: "sandboxd's control API: the stack's own SANDBOXD_URL",
  },
  'packages/files/src/tika.ts': {
    kind: 'owner config',
    why: "Tika, a service of the stack: the deployment's TIKA_URL",
  },
  'packages/files/src/media-sidecar.ts': {
    kind: 'owner config',
    why: "the media sidecar, a service of the stack: the deployment's URL",
  },
  'server/web/lib/render-pdf.ts': {
    kind: 'owner config',
    why: "the browserless health probe: the deployment's BROWSER_WS_ENDPOINT",
  },
  'server/web/lib/push/relay-client.ts': {
    kind: 'owner config',
    why: 'the push relay: the relay URL the deployment configures',
  },
  'server/web/lib/services.ts': {
    kind: 'owner config',
    why: 'the bundled embedder probe: the stack own embedder URL',
  },
  'server/web/lib/system-health.ts': {
    kind: 'owner config',
    why: 'the local model and embedder probes: owner-configured base URLs (LAN or tailnet on purpose)',
  },
  'server/web/lib/sanity/checks.ts': {
    kind: 'owner config',
    why: 'the local model probe: an owner-configured base URL',
  },
  'server/web/lib/integrity/capabilities.ts': {
    kind: 'owner config',
    why: 'the embedder probe: the owner-configured embedding base URL',
  },
  'server/web/lib/onboarding-steps.ts': {
    kind: 'owner config',
    why: "the onboarding probes: the box's own public URL and the Azure base URL the owner types in",
  },
  'server/web/app/api/mcp-status/route.ts': {
    kind: 'same-origin internal',
    why: "the box's own public MCP connector URL (a loopback handshake through the proxy)",
  },
  'server/web/components/share/contact-code-prompt.tsx': {
    kind: 'same-origin internal',
    why: 'a browser call to the share page own /s route',
  },
  'server/web/server/islands/draw-render.ts': {
    kind: 'same-origin internal',
    why: 'a browser call to the box own /api/files route',
  },
  'packages/share-ui/src/app-sandbox.tsx': {
    kind: 'same-origin internal',
    why: 'the app sandbox default fetcher: browser calls to the box own routes',
  },
  'packages/share-ui/src/formula-calculator.tsx': {
    kind: 'same-origin internal',
    why: 'a browser call to the share page own /s route',
  },
  'packages/share-ui/src/table-presenter.tsx': {
    kind: 'same-origin internal',
    why: 'browser calls to the share page own /s routes',
  },
};

/** Whether `path` (repo-relative) is swept. */
export function bareFetchSwept(path) {
  if (!path || !/\.(ts|tsx|mts|mjs|js)$/.test(path)) return false;
  if (/\.(test|spec)\.tsx?$/.test(path) || path.endsWith('.d.ts')) return false;
  if (/(^|\/)scripts\//.test(path)) return false;
  if (/(^|\/)(node_modules|\.next|e2e|__tests__)\//.test(path)) return false;
  return BARE_FETCH_SWEPT.some((p) => path.startsWith(p));
}

/** The global objects whose `fetch` is the platform fetch. */
const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self']);

/** Whether `node` is `globalThis.fetch`, `window.fetch`, `self.fetch` or
 *  `globalThis['fetch']`. */
function isGlobalFetchMember(node) {
  if (node.type !== 'MemberExpression') return false;
  if (node.object.type !== 'Identifier' || !GLOBAL_OBJECTS.has(node.object.name)) return false;
  if (!node.computed) return node.property.type === 'Identifier' && node.property.name === 'fetch';
  return node.property.type === 'Literal' && node.property.value === 'fetch';
}

/** Whether `node` sits in a type position (`typeof fetch`). */
function inTypePosition(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === 'TSTypeQuery') return true;
    if (!p.type.startsWith('TS') && p.type !== 'MemberExpression') return false;
  }
  return false;
}

/**
 * The platform fetch uses in `text` (comments and strings exempt), for the
 * inventory test: bare `fetch(` calls (arch-counts' bareFetchSites), a
 * global object's `fetch`, and `fetch` kept or passed as a value. The lint
 * rule is the AST check; this is its text twin over the whole tree.
 */
export function platformFetchUses(text) {
  const code = stripComments(text);
  let n = bareFetchSites(text);
  n += [
    ...code.matchAll(
      /\b(?:globalThis|window|self)\s*(?:\.\s*fetch\b(?!\s*\()|\[\s*['"`]fetch['"`]\s*\])/g,
    ),
  ].length;
  n += [...code.matchAll(/(?:[=,(?:]|\?\?|\|\||return)\s*fetch\b(?!\s*[(:<])/g)].length;
  n += [...code.matchAll(/[{,]\s*fetch\s*[,}]/g)].length;
  return n;
}

export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Outbound fetches of outside URLs go through the one egress fetch (A10 part 1).',
    },
    messages: {
      bare: 'The platform fetch outside the inventory. Use egressFetch (@mantle/std/egress), or guardedFetch / safeFetch in @mantle/tools; a fixed-host, owner-config or same-origin call is listed in eslint-rules/no-bare-fetch.mjs with its kind and reason (review). See docs/egress.md.',
    },
    schema: [],
  },
  create(context) {
    const path = repoPathOf(context.filename);
    if (!bareFetchSwept(path) || Object.hasOwn(BARE_FETCH_ALLOWED, path)) return {};
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    return {
      MemberExpression(node) {
        if (isGlobalFetchMember(node) && !inTypePosition(node)) {
          context.report({ node, messageId: 'bare' });
        }
      },
      'Program:exit'(program) {
        // `fetch` that resolves to no local binding: the global, called or
        // kept as a value (an alias). `typeof fetch` in a type is not a use.
        // A configured global resolves in the global scope; an undeclared
        // one passes through it.
        const scope = sourceCode.getScope ? sourceCode.getScope(program) : context.getScope();
        const refs = [
          ...scope.through.filter((r) => r.identifier.name === 'fetch'),
          ...(scope.set.get('fetch')?.references ?? []),
        ];
        const seen = new Set();
        for (const ref of refs) {
          const id = ref.identifier;
          if (seen.has(id) || inTypePosition(id)) continue;
          if (ref.isTypeReference && !ref.isValueReference) continue;
          seen.add(id);
          context.report({ node: id, messageId: 'bare' });
        }
      },
    };
  },
};

export default { rules: { 'no-bare-fetch': rule } };
