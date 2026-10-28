/**
 * no-bare-fetch (A10 part 1, docs/egress.md): an outbound fetch of a URL a
 * user, a model, a remote server or a linked peer gave goes through the one
 * egress fetch (`egressFetch` in @mantle/std/egress, or the tools'
 * guardedFetch / safeFetch over it): the address check on every hop, the
 * connection pinned to a checked address, secret headers dropped across
 * origins, a deadline and a streamed byte cap.
 *
 * Swept: all product code under packages/ and server/{web,api,mcp,sandboxd,parser}/
 * (tests and scripts are not product code). The rule flags any use of the
 * platform fetch there: a bare `fetch(`, `fetch` passed or kept as a value
 * (an alias), a global object's `fetch` (`globalThis`, `global`, `window`,
 * `self`; by name, by `['fetch']`, through `(0, globalThis)`, by
 * `Reflect.get(globalThis, 'fetch')` or destructured out of it), called or
 * not. BARE_FETCH_ALLOWED is the inventory of the files that may: each says
 * which kind of host it reaches and why, and no-bare-fetch.test.ts holds the
 * list to exactly the files that do.
 *
 * It flags a raw HTTP client the same way (fix round 2): an import, a
 * require, a dynamic import or a createRequire load of `undici`,
 * `node:http`, `node:https`, `http`, `https`, `axios`, `got` or
 * `node-fetch` (a type-only import is not a use). RAW_HTTP_ALLOWED is that
 * inventory, held to exactly the files that do by the same test.
 * scripts/arch-scoreboard.ts still pins the bare fetch sites of the first
 * three packages swept (bareFetchSites), so that count can only go down.
 */
import { bareFetchSites, repoPathOf, stripComments } from './arch-counts.mjs';

/** The trees swept: product code that could fetch an outside URL. */
export const BARE_FETCH_SWEPT = [
  'packages/',
  'server/web/',
  'server/api/',
  'server/mcp/',
  'server/sandboxd/',
  // The parser fetches nothing (its network has no route out); swept so a
  // fetch added to it is seen.
  'server/parser/',
];

/** The modules that are a raw HTTP client (or the platform fetch's own
 *  engine): a fetch around the egress layer. */
export const RAW_HTTP_MODULES = [
  'undici',
  'node:http',
  'node:https',
  'http',
  'https',
  'axios',
  'got',
  'node-fetch',
];

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
    why: "Microsoft Graph: the host is a constant, and an absolute URL from Graph's own answer (@odata.nextLink, a stored @odata.deltaLink) is followed only on that host (graphFetchRaw refuses any other origin)",
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
  'packages/content/src/livekit.ts': {
    kind: 'owner config',
    why: "the LiveKit health probe (Settings > Services): the stack's own MANTLE_LIVEKIT_URL",
  },
  'packages/files/src/parser-client.ts': {
    kind: 'owner config',
    why: "the parser service, a service of the stack on its internal network: the deployment's PARSER_URL",
  },
  'server/web/lib/render-pdf.ts': {
    kind: 'owner config',
    why: "the browserless health probe: the deployment's BROWSER_WS_ENDPOINT",
  },
  'server/web/lib/push/relay-client.ts': {
    kind: 'owner config',
    why: 'the push relay: the relay URL the deployment configures',
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
  'packages/share-ui/src/canvas-sandbox.tsx': {
    kind: 'same-origin internal',
    why: 'the canvas sandbox default fetcher: the frame ticket, a browser call to the box own route',
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

/**
 * The raw HTTP client inventory: each file that may load one of
 * RAW_HTTP_MODULES, with the kind of host it reaches and why.
 * @type {Record<string, { kind: string; why: string }>}
 */
export const RAW_HTTP_ALLOWED = {
  'packages/std/src/egress.ts': {
    kind: 'fetch layer',
    why: 'the one egress fetch: loads undici for the pinned Agent whose lookup answers only checked addresses',
  },
  'packages/voice/src/adapters/provider-fetch.ts': {
    kind: 'fetch layer',
    why: 'the model-provider HTTP pool: loads undici for the provider Agent (and the tailnet ProxyAgent built on it in tailnet.ts)',
  },
  'server/web/lib/tailscale.ts': {
    kind: 'owner config',
    why: "node:http to the tailscaled LocalAPI over the box's own unix socket",
  },
  'server/sandboxd/src/docker.ts': {
    kind: 'owner config',
    why: "node:http to the Docker Engine API over the stack's own socket",
  },
  'server/sandboxd/src/egress.ts': {
    kind: 'fetch layer',
    why: 'the balanced sandbox egress proxy: node:http forwarding only to its host allow-list',
  },
  'server/sandboxd/src/main.ts': {
    kind: 'owner config',
    why: "sandboxd's own HTTP listener, and its service proxy to a sandbox container at the internal address sandboxd assigned",
  },
  'server/parser/src/main.ts': {
    kind: 'owner config',
    why: "the parser service's own HTTP listener on the stack's internal parser network; it makes no outbound call",
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
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'window', 'self']);

/** Whether `node` is a global object: `globalThis`, or `(0, globalThis)`
 *  (a sequence yields its last value), or one in a TS cast. */
function isGlobalObject(node) {
  let n = node;
  for (;;) {
    if (n.type === 'SequenceExpression') n = n.expressions[n.expressions.length - 1];
    else if (n.type === 'TSAsExpression' || n.type === 'TSNonNullExpression') n = n.expression;
    else break;
  }
  return n.type === 'Identifier' && GLOBAL_OBJECTS.has(n.name);
}

/** Whether `node` is the string `fetch` (a literal or a plain template). */
function isFetchString(node) {
  if (node.type === 'Literal') return node.value === 'fetch';
  return (
    node.type === 'TemplateLiteral' &&
    node.expressions.length === 0 &&
    node.quasis[0]?.value.cooked === 'fetch'
  );
}

/** Whether `node` is `globalThis.fetch`, `global.fetch`, `window.fetch`,
 *  `self.fetch`, `globalThis['fetch']` or `(0, globalThis).fetch`. */
function isGlobalFetchMember(node) {
  if (node.type !== 'MemberExpression') return false;
  if (!isGlobalObject(node.object)) return false;
  if (!node.computed) return node.property.type === 'Identifier' && node.property.name === 'fetch';
  return isFetchString(node.property);
}

/** Whether `node` is `Reflect.get(globalThis, 'fetch')`. */
function isReflectGetFetch(node) {
  const c = node.callee;
  return (
    c.type === 'MemberExpression' &&
    !c.computed &&
    c.object.type === 'Identifier' &&
    c.object.name === 'Reflect' &&
    c.property.type === 'Identifier' &&
    c.property.name === 'get' &&
    node.arguments.length >= 2 &&
    isGlobalObject(node.arguments[0]) &&
    isFetchString(node.arguments[1])
  );
}

/** The `fetch` property of an object pattern (`{ fetch }`, `{ fetch: f }`,
 *  `{ ['fetch']: f }`), or null. */
function fetchPropertyOf(pattern) {
  if (pattern?.type !== 'ObjectPattern') return null;
  for (const p of pattern.properties) {
    if (p.type !== 'Property') continue;
    if (!p.computed && p.key.type === 'Identifier' && p.key.name === 'fetch') return p;
    if (isFetchString(p.key)) return p;
  }
  return null;
}

/** The module a node loads, when it is a string: an import or export
 *  source, `require('x')`, `import('x')`, or `load('x')` where `load` came
 *  from `createRequire(...)`. Type-only imports are not loads. */
function loadedModule(node, sourceCode) {
  const lit = (a) => (a?.type === 'Literal' && typeof a.value === 'string' ? a.value : null);
  switch (node.type) {
    case 'ImportDeclaration':
      if (node.importKind === 'type') return null;
      if (node.specifiers.length > 0 && node.specifiers.every((s) => s.importKind === 'type'))
        return null;
      return lit(node.source);
    case 'ExportNamedDeclaration':
    case 'ExportAllDeclaration':
      return node.exportKind === 'type' ? null : lit(node.source);
    case 'ImportExpression':
      return lit(node.source);
    case 'CallExpression': {
      const c = node.callee;
      if (c.type !== 'Identifier') return null;
      if (c.name === 'require') return lit(node.arguments[0]);
      const scope = sourceCode.getScope ? sourceCode.getScope(node) : null;
      for (let s = scope; s; s = s.upper) {
        const v = s.set.get(c.name);
        if (!v) continue;
        const init = v.defs[0]?.node?.init;
        const callee = init?.type === 'CallExpression' ? init.callee : null;
        const name =
          callee?.type === 'Identifier'
            ? callee.name
            : callee?.type === 'MemberExpression' && callee.property.type === 'Identifier'
              ? callee.property.name
              : null;
        return name === 'createRequire' ? lit(node.arguments[0]) : null;
      }
      return null;
    }
    default:
      return null;
  }
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
  const G = '(?:globalThis|global|window|self)';
  let n = bareFetchSites(text);
  n += [
    ...code.matchAll(
      new RegExp(`\\b${G}\\s*(?:\\.\\s*fetch\\b(?!\\s*\\()|\\[\\s*['"\`]fetch['"\`]\\s*\\])`, 'g'),
    ),
  ].length;
  // A global object's fetch called (bareFetchSites counts globalThis.fetch(
  // only), through a sequence, by Reflect.get, or destructured.
  n += [...code.matchAll(/\b(?:global|window|self)\s*\.\s*fetch\s*\(/g)].length;
  n += [...code.matchAll(new RegExp(`,\\s*${G}\\s*\\)\\s*(?:\\.\\s*fetch\\b|\\[)`, 'g'))].length;
  n += [...code.matchAll(new RegExp(`\\bReflect\\.get\\(\\s*${G}\\s*,\\s*['"\`]fetch`, 'g'))]
    .length;
  n += [...code.matchAll(new RegExp(`\\{[^{}]*\\bfetch\\b[^{}]*\\}\\s*=\\s*${G}\\b`, 'g'))].length;
  n += [...code.matchAll(/(?:[=,(?:]|\?\?|\|\||return)\s*fetch\b(?!\s*[(:<])/g)].length;
  n += [...code.matchAll(/[{,]\s*fetch\s*[,}]/g)].length;
  return n;
}

/**
 * The raw HTTP client loads in `text` (comments exempt), for the inventory
 * test: an import or export from, a require, a dynamic import or a
 * createRequire load (`load('undici')`) of one of RAW_HTTP_MODULES. A
 * type-only import or a type position (`typeof import('undici')`) is not
 * a load. The lint rule is the AST check; this is its text twin.
 */
export function rawHttpClientUses(text) {
  const code = stripComments(text)
    .replace(/\b(?:import|export)\s+type\b[^;]*;/g, ' ')
    .replace(/^\s*(?:export\s+)?type\s+\w+[^;]*;/gm, ' ');
  const mods = RAW_HTTP_MODULES.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(
    `(?:\\bfrom|\\brequire\\s*\\(|(?<!typeof\\s*)\\bimport\\s*\\(|\\bload\\s*\\(|^\\s*import)\\s*['"](?:${mods})['"]`,
    'gm',
  );
  return [...code.matchAll(re)].length;
}

export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Outbound fetches of outside URLs go through the one egress fetch (A10 part 1).',
    },
    messages: {
      bare: 'The platform fetch outside the inventory. Use egressFetch (@mantle/std/egress), or guardedFetch / safeFetch in @mantle/tools; a fixed-host, owner-config or same-origin call is listed in eslint-rules/no-bare-fetch.mjs with its kind and reason (review). See docs/egress.md.',
      client:
        "A raw HTTP client ('{{module}}') outside the inventory. Use egressFetch (@mantle/std/egress), or guardedFetch / safeFetch in @mantle/tools; a file that must reach a socket or a fixed host directly is listed in RAW_HTTP_ALLOWED in eslint-rules/no-bare-fetch.mjs with its kind and reason (review). See docs/egress.md.",
    },
    schema: [],
  },
  create(context) {
    const path = repoPathOf(context.filename);
    if (!bareFetchSwept(path)) return {};
    const fetchAllowed = Object.hasOwn(BARE_FETCH_ALLOWED, path);
    const clientAllowed = Object.hasOwn(RAW_HTTP_ALLOWED, path);
    if (fetchAllowed && clientAllowed) return {};
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    const client = (node) => {
      if (clientAllowed) return;
      const mod = loadedModule(node, sourceCode);
      if (mod !== null && RAW_HTTP_MODULES.includes(mod)) {
        context.report({ node, messageId: 'client', data: { module: mod } });
      }
    };
    const clientVisitors = {
      ImportDeclaration: client,
      ExportNamedDeclaration: client,
      ExportAllDeclaration: client,
      ImportExpression: client,
    };
    if (fetchAllowed) return { ...clientVisitors, CallExpression: client };
    return {
      ...clientVisitors,
      CallExpression(node) {
        client(node);
        if (isReflectGetFetch(node)) context.report({ node, messageId: 'bare' });
      },
      MemberExpression(node) {
        if (isGlobalFetchMember(node) && !inTypePosition(node)) {
          context.report({ node, messageId: 'bare' });
        }
      },
      VariableDeclarator(node) {
        // const { fetch } = globalThis; const { fetch: f } = window
        const p = node.init && isGlobalObject(node.init) ? fetchPropertyOf(node.id) : null;
        if (p) context.report({ node: p, messageId: 'bare' });
      },
      AssignmentExpression(node) {
        // ({ fetch: f } = globalThis)
        const p = isGlobalObject(node.right) ? fetchPropertyOf(node.left) : null;
        if (p) context.report({ node: p, messageId: 'bare' });
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
