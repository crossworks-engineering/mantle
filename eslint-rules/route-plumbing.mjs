/**
 * Route plumbing (A10 part 2, A10 #8; docs/request-plumbing.md): what a
 * route file of the HTTP tier (server/web/app/**\/route.ts) does not do
 * itself: read its body, put a caught error's text in a reply, take a rate
 * limit.
 *
 * no-direct-body-reads (fold 1, one body reader): a route reads its body
 * with readBody(req, Schema) or readJson(req) (server/web/lib/read-body.ts),
 * never `req.json()`, `req.text()`, `req.formData()`, `req.arrayBuffer()`,
 * `req.blob()` or the `req.body` stream. The reader gives the one 400 for a
 * body that is not JSON, and the route loader caps every read at the
 * route's ceiling (capRequestBody). Before: 178 route files called
 * `req.json()` with a fallback of their own. The files that read the body
 * another way are named below with the reason (BODY_READ_ALLOW); the
 * scoreboard pins both numbers (arch-counts.mjs).
 *
 * Reported in a route file: a call of one of those readers, or a read of
 * `.body`, on the handler's request: a parameter typed `Request`, or one
 * named req, request or _req.
 */
import { DECLARED_METHODS, ROUTE_POLICY_EXPORT } from '../server/web/lib/auth/route-declaration.ts';

/** The route files that read their body another way, each with why. */
export const BODY_READ_ALLOW = Object.freeze({
  'server/web/app/api/assistant/turn/route.ts':
    'a multipart attachment (formData), read through the route loader at its multipart ceiling (body-limit.ts MULTIPART_CEILINGS); the JSON body goes through readJson',
  'server/web/app/api/assistant/transcribe/route.ts':
    'a multipart audio upload (formData), read through the route loader at its multipart ceiling (body-limit.ts MULTIPART_CEILINGS)',
  'server/web/app/api/tables/[id]/import/route.ts':
    'a multipart spreadsheet upload (formData), read through the route loader at its multipart ceiling (body-limit.ts MULTIPART_CEILINGS)',
  'server/web/app/api/profile/photo/route.ts':
    'a multipart image upload (formData), read through the route loader at its multipart ceiling (body-limit.ts MULTIPART_CEILINGS)',
  'server/web/app/api/profile/logo/route.ts':
    'a multipart image upload (formData), read through the route loader at its multipart ceiling (body-limit.ts MULTIPART_CEILINGS)',
  'server/web/app/api/apps/import-package/route.ts':
    'streams the package (req.body) to disk under its own cap (spoolUpload)',
  'server/web/app/api/oauth/token/route.ts':
    'an OAuth token request is a form post (RFC 6749), answered in its own error shape',
  'server/web/app/api/oauth/authorize/route.ts':
    'the OAuth consent page posts a form, answered as a page',
  'server/web/app/api/v1/pages/[id]/route.ts':
    'reads the raw text to check two fields for an API key, then hands the same bytes to the page route, which reads them with readJson',
});

/**
 * no-error-text-replies (fold 2, one error answer): a route never puts a
 * caught error's text in its reply. It throws, and app.onError answers:
 * a domain error by the one table (@mantle/std domain-errors.ts: its
 * status and public text, the same a tool says), a refusal by the one
 * mapper, anything else with the opaque 500 and a log line. 86 route files
 * did on main; fold 2 moved 58 of them (the first tranche, then the typed
 * catches, the slug-taken catches and the catch-alls). The files that still
 * do are named here, each with its reason: none may be added, and the list
 * only shrinks (eslint-rules/arch-lints.test.ts holds it to the files that
 * still do).
 *
 * Two kinds of reason. PUBLIC: the text is deliberately the reply, because
 * it is the answer of a service the owner set up and came to test or fix
 * (a model provider, a connector's server, the relay, a parser of the
 * owner's own file). NOT_YET: the route answers a dialog in a shape of its
 * own, and the move needs the client (jackdaw) to read the one error
 * answer first (docs/request-plumbing.md, "What stays named").
 */
const MODEL_TEST =
  "PUBLIC: a test of the worker's or agent's model; the provider's own error (a quota, a model id, a key) is what the owner came to see";
const UPSTREAM =
  "PUBLIC: the answer of the connector's own server (a sync, a discovery, a spec fetch), which the owner set up and fixes from this text; also kept on the connector as lastError";
const OK_FALSE =
  'NOT_YET: answers the settings dialog {ok:false, message} with status 200; the move needs the dialog (jackdaw) to read the one error answer first';
export const ERROR_TEXT_ALLOW = Object.freeze({
  'server/web/app/api/agents/[id]/test/chat/route.ts': MODEL_TEST,
  'server/web/app/api/ai-workers/[id]/test/chat/route.ts': MODEL_TEST,
  'server/web/app/api/ai-workers/[id]/test/decision/route.ts': MODEL_TEST,
  'server/web/app/api/ai-workers/[id]/test/document/route.ts': MODEL_TEST,
  'server/web/app/api/ai-workers/[id]/test/image/route.ts': MODEL_TEST,
  'server/web/app/api/ai-workers/[id]/test/stt/route.ts': MODEL_TEST,
  'server/web/app/api/ai-workers/[id]/test/tts/route.ts': MODEL_TEST,
  'server/web/app/api/ai-workers/[id]/test/vision/route.ts': MODEL_TEST,
  'server/web/app/api/studio/sandbox/route.ts': MODEL_TEST,
  'server/web/app/api/embedding/test/route.ts': MODEL_TEST,
  'server/web/app/api/apps/[id]/format/route.ts':
    "PUBLIC: Prettier's syntax error in the owner's own file says where to fix it",
  'server/web/app/api/tables/[id]/import/route.ts':
    "PUBLIC: the spreadsheet parser's text about the owner's own file (parse failed: ...) says what to fix; the import's own errors answer by the table",
  'server/web/app/api/assistant/transcribe/route.ts':
    "PUBLIC: the speech provider's answer (audio too short, a quota) as a 422, so the client says it without a list of its own",
  'server/web/app/api/dev-tools/mcp/route.ts':
    "PUBLIC: the dev console shows the MCP server's own answer",
  'server/web/app/api/dev-tools/proxy/route.ts':
    "PUBLIC: the dev console's request proxy shows the upstream's network error as the response it got",
  'server/web/app/api/mcp-connectors/route.ts':
    "PUBLIC: oauthError, the authorization server's answer when its flow could not start after the create; the create's own refusals answer by the table",
  'server/web/app/api/mcp-connectors/[slug]/sync/route.ts': UPSTREAM,
  'server/web/app/api/mcp-connectors/[slug]/oauth/start/route.ts': UPSTREAM,
  'server/web/app/api/openapi-connectors/[slug]/sync/route.ts': UPSTREAM,
  'server/web/app/api/openapi-connectors/preview/route.ts': UPSTREAM,
  'server/web/app/api/mcp-connectors/oauth/callback/route.ts':
    "PUBLIC: the authorization server's answer (a refused grant, a failed token exchange, the tool listing after it) on the page the owner's browser lands on, which the owner set up and fixes from this text",
  'server/web/app/api/apps/import/route.ts':
    "PUBLIC: SQLite's text about the owner's own schema script (bad(...)), which says where to fix it",
  'server/web/app/api/network/key/route.ts': OK_FALSE,
  'server/web/app/api/mcp-status/route.ts':
    "PUBLIC: the health check reports why the box's own public MCP URL could not be reached (the proxy, TLS, DNS)",
  'server/web/app/api/push/reset/route.ts':
    "PUBLIC: the push relay's answer when the instance token could not be rolled (relay_unreachable)",
  'server/web/app/api/assistant/turn/route.ts':
    "NOT_YET: a failed chat turn's text is the chat's error line (the provider's answer); the move needs the chat (jackdaw) to word a failed turn itself",
  'server/web/app/api/embedding/route.ts': OK_FALSE,
  'server/web/app/api/embedding/rebuild/route.ts': OK_FALSE,
});

/**
 * no-route-rate-limits (A10 #8, rate limits on the ROUTE_POLICY row): a
 * route file takes no rate limit and answers no cross-site refusal of its
 * own. A limit is a row's (server/web/lib/route-limits.ts: a named limit in
 * RATE_LIMITS, the row's entry in ROUTE_GATES), taken by the gate once the
 * caller is answered and answered with the one 429; the cross-site refusal
 * of a public auth post is the row's `crossSite`, answered by the gate
 * before any limit. Before: 38 limits, 32 calls in 26 route files and more
 * in the helpers their handlers called first, each with its own max,
 * window and 429. The files that still take one are named here with the
 * reason: a budget around a check inside the handler, not a gate on the
 * request. The rule and the count read every server/web file, not only
 * route files (A10 #8 low round, L2: a limiter in a helper the handler calls
 * first was invisible), so the gate itself and the key budgets are named
 * too. The scoreboard pins both numbers (arch-counts.mjs).
 */
export const RATE_LIMIT_ALLOW = Object.freeze({
  'server/web/lib/route-limits.ts':
    "the gate itself: it takes each row's named limits (RATE_LIMITS, ROUTE_GATES) and answers the one 429",
  'server/web/lib/access-keys.ts':
    "the API key budgets (rateLimitAccessKey: a key's and its login's; rateLimitKeySearch) and the failed-key counters, taken once the key is resolved (by the key gate and the MCP route): a budget per key, which the row cannot know",
  'server/web/server/middleware/access-key-gate.ts':
    "the /api/v1 key gate takes the key's budget (rateLimitAccessKey) once it has resolved the key: a budget per key, not per row",
  'server/web/lib/workspace-turn.ts':
    "the chat turn budget of a login that is not an Admin user (6 a minute), counted per queued turn so a retry with the same Idempotency-Key, answered from the turn route's cache, spends nothing (docs/request-plumbing.md, Rate limits)",
  'server/web/app/api/access-keys/route.ts':
    'a failure budget around the password check (taken before it, given back on a right password: M2 audit N2) and the keys made an hour, counted only once the password passed; neither is a gate on the request',
  'server/web/app/api/oauth/authorize/route.ts':
    'the consent password failure budget, taken around the password check and given back on a right one; its 429 is the consent page again, a page and not the one JSON 429',
  'server/web/app/api/mcp/route.ts':
    "each MCP caller's own budget (an API key's, a peer's, a login's), keyed by the bearer the route resolves itself after its own switch check; the per-address limit before it is the row's",
});

/** The limiter calls no file outside RATE_LIMIT_ALLOW makes
 *  (lib/rate-limit.ts and the key budgets of lib/access-keys.ts). */
const LIMITERS = [
  'rateLimit',
  'rateLimitPeek',
  'rateLimitRefund',
  'rateLimitLogin',
  'rateLimitLoginRefund',
  'rateLimitFlood',
  'rateLimitFloodPeek',
  'rateLimitAccessKey',
  'rateLimitKeySearch',
];
const LIMITER_SET = new Set(LIMITERS);
/** The refusal the gate answers from the row (ROUTE_GATES crossSite). */
const ROW_REFUSALS = new Set(['refuseCrossSiteAuthPost']);

/** A text heuristic of the same check, for the counts (comments already
 *  stripped): the limiter calls in `code`. */
export function rateLimitCalls(code) {
  // Not a definition (`function rateLimit(`): lib/rate-limit.ts names them.
  const re = new RegExp(`(?<![\\w$]|\\bfunction\\s+)(?:${LIMITERS.join('|')})\\s*\\(`, 'g');
  return (code.match(re) ?? []).length;
}

const READERS = new Set(['json', 'text', 'formData', 'arrayBuffer', 'blob']);

/** The repo-relative path of `filename` under server/web, or null. */
function webPath(filename) {
  const f = filename.replace(/\\/g, '/');
  const at = f.lastIndexOf('server/web/');
  return at < 0 ? null : f.slice(at);
}

/** Whether `filename` is a route file of the HTTP tier (tests aside). */
export function isRoutePath(filename) {
  const path = webPath(filename);
  return !!path && /^server\/web\/app\/.*\/route\.ts$/.test(path);
}

/** A text heuristic of the same check, for the counts (comments already
 *  stripped): a reader called on, or `.body` read off, req, request or
 *  _req. */
export function directBodyReads(code) {
  const re = /\b_?req(?:uest)?\.(?:(?:json|text|formData|arrayBuffer|blob)\s*\(|body\b)/g;
  return (code.match(re) ?? []).length;
}

/** The catch blocks of `code` (comments stripped): the caught name and
 *  the block's text. */
function catchBlocks(code) {
  const out = [];
  const re = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*(?::[^)]*)?\)\s*\{/g;
  let m;
  while ((m = re.exec(code))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < code.length && depth; i++) {
      if (code[i] === '{') depth += 1;
      else if (code[i] === '}') depth -= 1;
    }
    out.push({ name: m[1], body: code.slice(re.lastIndex, i - 1) });
  }
  return out;
}

/**
 * The catch blocks of `code` (comments stripped) that put the caught
 * error's text in a reply (fold 2): a statement that builds a reply (a
 * `json(` or `.json(`, a `Response`, a redirect, a `body:`, a `return` of
 * anything, such as a route's own `bad(...)` or HTML page helper, or an
 * `error:` or `message:` field, such as an item of a `failed` list the
 * reply carries; fix round 1, L5) and carries the error's message
 * (`err.message`, `errorMessage(err)`, `String(err)`, `${err}`) or a name
 * made of it. A text heuristic, for the counts; logging is not a reply.
 */
export function errorTextReplies(code) {
  let n = 0;
  for (const { name, body } of catchBlocks(code)) {
    const b = body.replace(/console\.\w+\([^;]*\);/g, '');
    const v = name.replace(/\$/g, '\\$');
    const msg = new RegExp(
      `(\\b${v}\\.message\\b|errorMessage\\(\\s*${v}\\s*\\)|String\\(\\s*${v}\\s*\\)|\\(\\s*${v}\\s+as\\s+[^)]*\\)\\.message|\\$\\{\\s*${v}\\s*\\})`,
    );
    const made = [
      ...b.matchAll(
        new RegExp(`(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*[^;]*?${msg.source}`, 'g'),
      ),
    ].map((x) => x[1]);
    const reply =
      /(\bjson\(|new Response\(|[Rr]edirect\w*\(|\bbody\s*:|\breturn\b|\b(?:error|message)\s*:)/;
    const statements = b.split(/(?<=;)/);
    const carries = (s) => msg.test(s) || made.some((x) => new RegExp(`\\b${x}\\b`).test(s));
    if (statements.some((s) => reply.test(s) && carries(s))) n += 1;
  }
  return n;
}

/** Whether the parameter `p` is a handler's request. */
function isRequestParam(p) {
  const id = p.type === 'AssignmentPattern' ? p.left : p;
  if (id.type !== 'Identifier') return false;
  if (/^_?req(uest)?$/.test(id.name)) return true;
  const t = id.typeAnnotation?.typeAnnotation;
  return t?.type === 'TSTypeReference' && t.typeName?.name === 'Request';
}

export const noDirectBodyReads = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A route reads its body with readBody(req, Schema) or readJson(req), never req.json() and the like (A10 part 2).',
    },
    messages: {
      read: '{{what}} reads the request body directly: use readBody(req, Schema) or readJson(req) from @/lib/read-body (the one 400, the ceiling). A file that must read it another way is named with its reason in eslint-rules/route-plumbing.mjs BODY_READ_ALLOW.',
    },
    schema: [],
  },
  create(context) {
    const file = context.filename;
    if (!isRoutePath(file) || /\.test\.[cm]?[jt]sx?$/.test(file)) return {};
    if (BODY_READ_ALLOW[webPath(file)]) return {};
    const requests = new Set();
    const noteParams = (fn) => {
      for (const p of fn.params ?? []) {
        if (isRequestParam(p)) requests.add(p.type === 'AssignmentPattern' ? p.left.name : p.name);
      }
    };
    const isRequest = (node) =>
      node?.type === 'Identifier' && (requests.has(node.name) || /^_?req(uest)?$/.test(node.name));
    return {
      FunctionDeclaration: noteParams,
      FunctionExpression: noteParams,
      ArrowFunctionExpression: noteParams,
      MemberExpression(node) {
        if (!isRequest(node.object) || node.computed) return;
        const name = node.property.name;
        if (name === 'body') {
          context.report({ node, messageId: 'read', data: { what: `${node.object.name}.body` } });
          return;
        }
        if (
          READERS.has(name) &&
          node.parent.type === 'CallExpression' &&
          node.parent.callee === node
        ) {
          context.report({
            node,
            messageId: 'read',
            data: { what: `${node.object.name}.${name}()` },
          });
        }
      },
    };
  },
};

export const noErrorTextReplies = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "A route never puts a caught error's text in its reply: it throws, and app.onError answers (A10 part 2).",
    },
    messages: {
      text: "This catch puts the caught error's text in a reply. Throw it: app.onError answers a domain error by the one table (@mantle/std domain-errors.ts) and anything else with the opaque 500. A message that is deliberately public is named with its reason in eslint-rules/route-plumbing.mjs ERROR_TEXT_ALLOW.",
    },
    schema: [],
  },
  create(context) {
    const file = context.filename;
    if (!isRoutePath(file) || /\.test\.[cm]?[jt]sx?$/.test(file)) return {};
    if (ERROR_TEXT_ALLOW[webPath(file)]) return {};
    const source = context.sourceCode ?? context.getSourceCode();
    return {
      CatchClause(node) {
        if (errorTextReplies(source.getText(node))) {
          context.report({ node, messageId: 'text' });
        }
      },
    };
  },
};

export const noRouteRateLimits = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "A route takes no rate limit and answers no cross-site refusal of its own: both are its ROUTE_POLICY row's, answered by the gate (A10 #8).",
    },
    messages: {
      limit:
        "{{what}}(): a rate limit is the row's. Name it in server/web/lib/route-limits.ts (RATE_LIMITS) and give the row it in ROUTE_GATES; the gate takes it and answers the one 429. A budget that is not a gate on the request is named with its reason in eslint-rules/route-plumbing.mjs RATE_LIMIT_ALLOW.",
      crossSite:
        "{{what}}() in a route file: the cross-site refusal is the row's (ROUTE_GATES crossSite, server/web/lib/route-limits.ts), answered by the gate before any limit.",
    },
    schema: [],
  },
  create(context) {
    const file = context.filename;
    const path = webPath(file);
    if (!path || /\.test\.[cm]?[jt]sx?$/.test(file)) return {};
    // Any server/web file: a limiter in a helper is a limit too (A10 #8 low
    // round, L2). The cross-site refusal is a route file's question only.
    const route = isRoutePath(file);
    const allowed = Object.hasOwn(RATE_LIMIT_ALLOW, path);
    return {
      CallExpression(node) {
        const callee = node.callee;
        const name =
          callee.type === 'Identifier'
            ? callee.name
            : callee.type === 'MemberExpression' && !callee.computed
              ? callee.property.name
              : null;
        if (!name) return;
        if (ROW_REFUSALS.has(name) && route) {
          context.report({ node, messageId: 'crossSite', data: { what: name } });
        } else if (LIMITER_SET.has(name) && !allowed) {
          context.report({ node, messageId: 'limit', data: { what: name } });
        }
      },
    };
  },
};

/** The HTTP methods a route file exports and the name of its policy
 *  export: the declaration's own (route-declaration.ts, the one shape
 *  source; Node loads the TypeScript file as it is). */
const HTTP_METHODS = new Set(DECLARED_METHODS);
export { ROUTE_POLICY_EXPORT };

/**
 * route-policy-declared (the route declarations, plan v3.2): every route file declares its
 * policy beside its handlers, `export const policy = routePolicy({ ... })`
 * (server/web/lib/auth/route-declaration.ts), naming each method it exports
 * and no other (a HEAD the GET handler answers takes its GET's). The boot
 * refuses the same (route-policy.ts requireRouteDeclarations, in
 * registerRoutes); this says it at the line. 'error' since part 1's codemod
 * wrote every declaration (eslint.config.mjs).
 */
export const routePolicyDeclared = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A route file declares its policy (export const policy = routePolicy({ ... })) for each method it exports (the route declarations, plan v3.2).',
    },
    messages: {
      missing:
        'This route file exports {{methods}} and declares no policy: export const policy = routePolicy({ ... }) beside its handlers (server/web/lib/auth/route-declaration.ts; scripts/route-policy-codemod.ts writes it from the lists).',
      undeclared:
        "The policy names no {{method}}, which this file exports: declare each method's policy.",
      stray: 'The policy names {{method}}, which this file does not export.',
      notLiteral:
        'Write the policy out where it is exported: export const policy = routePolicy({ ... }) with the object literal (the generator reads it as data and refuses a name, a call, a spread or a re-export).',
    },
    schema: [],
  },
  create(context) {
    const file = context.filename;
    if (!isRoutePath(file)) return {};
    const exported = new Set();
    /** The declaration's object literal, or null when it is not one. */
    let declared = null;
    let declaredNode = null;
    return {
      ExportNamedDeclaration(node) {
        const d = node.declaration;
        if (d?.type === 'FunctionDeclaration' && d.id && HTTP_METHODS.has(d.id.name)) {
          exported.add(d.id.name);
        } else if (d?.type === 'VariableDeclaration') {
          for (const v of d.declarations) {
            if (v.id.type !== 'Identifier') continue;
            if (HTTP_METHODS.has(v.id.name)) exported.add(v.id.name);
            if (v.id.name !== ROUTE_POLICY_EXPORT) continue;
            declaredNode = v;
            const init = v.init;
            const arg =
              init?.type === 'CallExpression' && init.arguments.length === 1
                ? init.arguments[0]
                : null;
            declared = arg?.type === 'ObjectExpression' ? arg : null;
          }
        }
        // A type-only export is no handler (scripts/route-callers.ts
        // exportedMethods, the generator's reader, skips it too).
        if (node.exportKind === 'type') return;
        for (const sp of node.specifiers ?? []) {
          if (sp.exportKind === 'type') continue;
          const name = sp.exported.type === 'Identifier' ? sp.exported.name : sp.exported.value;
          if (HTTP_METHODS.has(name)) exported.add(name);
          if (name === ROUTE_POLICY_EXPORT) declaredNode = sp;
        }
      },
      'Program:exit'(program) {
        if (exported.size === 0) return;
        if (!declaredNode) {
          context.report({
            node: program,
            messageId: 'missing',
            data: { methods: [...exported].sort().join(', ') },
          });
          return;
        }
        // A declaration not written out (an export clause, a name, another
        // call): the generator refuses it at build; said here at the line.
        if (!declared) {
          context.report({ node: declaredNode, messageId: 'notLiteral' });
          return;
        }
        const named = new Set();
        for (const p of declared.properties) {
          if (p.type !== 'Property' || p.computed) continue;
          const key = p.key.type === 'Identifier' ? p.key.name : String(p.key.value);
          named.add(key);
          if (!exported.has(key)) {
            context.report({ node: p, messageId: 'stray', data: { method: key } });
          }
        }
        for (const m of exported) {
          if (!named.has(m)) {
            context.report({ node: declaredNode, messageId: 'undeclared', data: { method: m } });
          }
        }
      },
    };
  },
};

export default {
  rules: {
    'no-direct-body-reads': noDirectBodyReads,
    'no-error-text-replies': noErrorTextReplies,
    'no-route-rate-limits': noRouteRateLimits,
    'route-policy-declared': routePolicyDeclared,
  },
};
