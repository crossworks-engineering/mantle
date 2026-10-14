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

export default { rules: { 'no-direct-body-reads': noDirectBodyReads } };
