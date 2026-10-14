/**
 * Route plumbing (A10 part 2; docs/request-plumbing.md): what a route file
 * of the HTTP tier (server/web/app/**\/route.ts) does not do itself.
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

/** The route files that read their body another way, each with why. */
export const BODY_READ_ALLOW = Object.freeze({
  'server/web/app/api/assistant/turn/route.ts':
    'a multipart attachment (formData) on an upload path with its own cap; the JSON body goes through readJson',
  'server/web/app/api/assistant/transcribe/route.ts':
    'a multipart audio upload (formData) on an upload path with its own cap',
  'server/web/app/api/tables/[id]/import/route.ts':
    'a multipart spreadsheet upload (formData) on an upload path with its own cap',
  'server/web/app/api/profile/photo/route.ts':
    'a multipart image upload (formData) on an upload path with its own cap',
  'server/web/app/api/profile/logo/route.ts':
    'a multipart image upload (formData) on an upload path with its own cap',
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
 * did on main; fold 2 moved the first tranche (the named examples, the
 * isScopeWriteRefusal re-throws, the treeErrorResponse catches). The files
 * still doing it are named here: none may be added, and the list only
 * shrinks (eslint-rules/arch-lints.test.ts holds it to the files that
 * still do). A message that is deliberately public gets its own reason.
 */
const NOT_YET = 'not yet moved: fold 2 continues (docs/request-plumbing.md)';
export const ERROR_TEXT_ALLOW = Object.freeze({
  'server/web/app/api/agents/[id]/telegram/chats/route.ts': NOT_YET,
  'server/web/app/api/agents/[id]/telegram/route.ts': NOT_YET,
  'server/web/app/api/agents/[id]/test/chat/route.ts': NOT_YET,
  'server/web/app/api/agents/route.ts': NOT_YET,
  'server/web/app/api/ai-workers/[id]/test/chat/route.ts': NOT_YET,
  'server/web/app/api/ai-workers/[id]/test/decision/route.ts': NOT_YET,
  'server/web/app/api/ai-workers/[id]/test/document/route.ts': NOT_YET,
  'server/web/app/api/ai-workers/[id]/test/image/route.ts': NOT_YET,
  'server/web/app/api/ai-workers/[id]/test/stt/route.ts': NOT_YET,
  'server/web/app/api/ai-workers/[id]/test/tts/route.ts': NOT_YET,
  'server/web/app/api/ai-workers/[id]/test/vision/route.ts': NOT_YET,
  'server/web/app/api/ai-workers/route.ts': NOT_YET,
  'server/web/app/api/apps/[id]/draft/route.ts': NOT_YET,
  'server/web/app/api/apps/[id]/duplicate/route.ts': NOT_YET,
  'server/web/app/api/apps/[id]/export/route.ts': NOT_YET,
  'server/web/app/api/apps/[id]/format/route.ts': NOT_YET,
  'server/web/app/api/apps/[id]/publish/route.ts': NOT_YET,
  'server/web/app/api/apps/[id]/snapshots/[sid]/restore/route.ts': NOT_YET,
  'server/web/app/api/apps/[id]/snapshots/[sid]/route.ts': NOT_YET,
  'server/web/app/api/apps/[id]/snapshots/route.ts': NOT_YET,
  'server/web/app/api/apps/deleted/[id]/restore/route.ts': NOT_YET,
  'server/web/app/api/apps/import-package/route.ts': NOT_YET,
  'server/web/app/api/assistant/transcribe/route.ts': NOT_YET,
  'server/web/app/api/assistant/turn/route.ts': NOT_YET,
  'server/web/app/api/config/adopt-all/route.ts': NOT_YET,
  'server/web/app/api/config/adopt/route.ts': NOT_YET,
  'server/web/app/api/dev-tools/mcp/route.ts': NOT_YET,
  'server/web/app/api/dev-tools/proxy/route.ts': NOT_YET,
  'server/web/app/api/docs/collections/[id]/route.ts': NOT_YET,
  'server/web/app/api/docs/collections/all/route.ts': NOT_YET,
  'server/web/app/api/docs/collections/route.ts': NOT_YET,
  'server/web/app/api/embedding/rebuild/route.ts': NOT_YET,
  'server/web/app/api/embedding/route.ts': NOT_YET,
  'server/web/app/api/embedding/test/route.ts': NOT_YET,
  'server/web/app/api/export/[id]/route.ts': NOT_YET,
  'server/web/app/api/files/files/route.ts': NOT_YET,
  'server/web/app/api/formulas/[id]/evaluate/route.ts': NOT_YET,
  'server/web/app/api/heartbeats/[id]/fire/route.ts': NOT_YET,
  'server/web/app/api/heartbeats/[id]/route.ts': NOT_YET,
  'server/web/app/api/heartbeats/route.ts': NOT_YET,
  'server/web/app/api/keys/route.ts': NOT_YET,
  'server/web/app/api/mcp-connectors/[slug]/oauth/start/route.ts': NOT_YET,
  'server/web/app/api/mcp-connectors/[slug]/sync/route.ts': NOT_YET,
  'server/web/app/api/mcp-connectors/route.ts': NOT_YET,
  'server/web/app/api/mcp-status/route.ts': NOT_YET,
  'server/web/app/api/model-pools/route.ts': NOT_YET,
  'server/web/app/api/openapi-connectors/[slug]/sync/route.ts': NOT_YET,
  'server/web/app/api/openapi-connectors/preview/route.ts': NOT_YET,
  'server/web/app/api/openapi-connectors/route.ts': NOT_YET,
  'server/web/app/api/pdf-passwords/route.ts': NOT_YET,
  'server/web/app/api/peers/route.ts': NOT_YET,
  'server/web/app/api/pending/[id]/route.ts': NOT_YET,
  'server/web/app/api/profile/route.ts': NOT_YET,
  'server/web/app/api/push/reset/route.ts': NOT_YET,
  'server/web/app/api/runners/[id]/route.ts': NOT_YET,
  'server/web/app/api/settings/worker-groups/route.ts': NOT_YET,
  'server/web/app/api/shares/contacts/route.ts': NOT_YET,
  'server/web/app/api/skills/route.ts': NOT_YET,
  'server/web/app/api/studio/prose/route.ts': NOT_YET,
  'server/web/app/api/studio/reset/route.ts': NOT_YET,
  'server/web/app/api/studio/sandbox/route.ts': NOT_YET,
  'server/web/app/api/tables/[id]/draft-ops/route.ts': NOT_YET,
  'server/web/app/api/tables/[id]/draft/route.ts': NOT_YET,
  'server/web/app/api/tables/[id]/export/route.ts': NOT_YET,
  'server/web/app/api/tables/[id]/history/[sid]/restore/route.ts': NOT_YET,
  'server/web/app/api/tables/[id]/history/route.ts': NOT_YET,
  'server/web/app/api/tables/[id]/import/route.ts': NOT_YET,
  'server/web/app/api/tables/[id]/rows/route.ts': NOT_YET,
  'server/web/app/api/tool-groups/route.ts': NOT_YET,
  'server/web/app/api/tools/[id]/route.ts': NOT_YET,
  'server/web/app/api/tools/route.ts': NOT_YET,
  'server/web/app/api/users/[id]/agent/route.ts': NOT_YET,
});

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
 * `.json(`, a `Response`, a redirect, a `body:`) and carries the error's
 * message (`err.message`, `errorMessage(err)`, `String(err)`, `${err}`) or
 * a name made of it. A text heuristic, for the counts; logging is not a
 * reply.
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
    const reply = /(\.json\(|new Response\(|Response\.json\(|[Rr]edirect\w*\(|body\s*:)/;
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

export default {
  rules: {
    'no-direct-body-reads': noDirectBodyReads,
    'no-error-text-replies': noErrorTextReplies,
  },
};
