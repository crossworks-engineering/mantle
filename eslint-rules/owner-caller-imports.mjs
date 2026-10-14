/**
 * owner-caller-imports (workspaces arch A4 step 3b): the caller the HTTP
 * pipeline answers is read only in a route handler, by its own name. The
 * route manifest generator reads each route file to learn which handlers
 * read it (server/web/scripts/route-callers.ts) and the gate answers only
 * those rows; a read it cannot see (a helper of lib, a renamed import, a
 * read off an object) would run on a row the gate did not answer and
 * throw. So, outside session.ts (which defines it) and tests:
 *
 *  - a reader (ownerCaller, session-guards.mjs) is imported only in a route
 *    file under server/web/app/api, from @/lib/auth (or
 *    @/lib/auth/session), and never renamed;
 *  - it is never re-exported, read off an object (`auth.ownerCaller`,
 *    `auth['ownerCaller']`) or destructured (`const { ownerCaller } =
 *    await import(...)`).
 *
 * The generator refuses the rest inside a route file (a reference other
 * than a plain call, a read outside a handler).
 */
import { CALLER_READERS } from './session-guards.mjs';

const READERS = new Set(CALLER_READERS);
const READER_MODULES = new Set(['@/lib/auth', '@/lib/auth/session']);

/** Whether `filename` is a route file under server/web/app/api. */
export function isApiRouteFile(filename) {
  const f = filename.replace(/\\/g, '/');
  return /(^|\/)server\/web\/app\/api\/(.+\/)?route\.tsx?$/.test(f);
}

/** Whether `filename` is exempt: the definition, and tests. */
export function isExempt(filename) {
  const f = filename.replace(/\\/g, '/');
  if (/\.test\.tsx?$/.test(f)) return true;
  return /(^|\/)server\/web\/lib\/auth\/session\.ts$/.test(f);
}

const nameOf = (node) =>
  node
    ? node.type === 'Identifier'
      ? node.name
      : typeof node.value === 'string'
        ? node.value
        : null
    : null;

export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'ownerCaller is imported by its own name, only in an app/api route file (A4 step 3b).',
    },
    messages: {
      notRoute:
        '{{name}} is read only in a route handler under server/web/app/api: the manifest generator reads the route files to learn which rows the gate answers (A4 step 3b). Pass the owner in from the handler.',
      renamed:
        'Import {{name}} by its own name: the manifest generator reads the route files by it (A4 step 3b).',
      module: 'Import {{name}} from @/lib/auth.',
      reexport:
        '{{name}} is not re-exported: a route handler imports it from @/lib/auth (A4 step 3b).',
      member:
        'Do not read {{name}} off an object: import it by name in the route file and call it (A4 step 3b).',
    },
    schema: [],
  },
  create(context) {
    const file = context.filename;
    if (isExempt(file)) return {};
    const route = isApiRouteFile(file);
    return {
      ImportSpecifier(node) {
        const name = nameOf(node.imported);
        if (!READERS.has(name)) return;
        if (!route) context.report({ node, messageId: 'notRoute', data: { name } });
        else if (node.local.name !== name)
          context.report({ node, messageId: 'renamed', data: { name } });
        else if (!READER_MODULES.has(node.parent.source.value)) {
          context.report({ node, messageId: 'module', data: { name } });
        }
      },
      ExportSpecifier(node) {
        const name = [nameOf(node.local), nameOf(node.exported)].find((n) => READERS.has(n));
        if (name) context.report({ node, messageId: 'reexport', data: { name } });
      },
      MemberExpression(node) {
        if (node.computed && node.property.type !== 'Literal') return;
        const name = nameOf(node.property);
        if (READERS.has(name)) context.report({ node, messageId: 'member', data: { name } });
      },
      Property(node) {
        if (node.parent.type !== 'ObjectPattern') return;
        const name = nameOf(node.key);
        if (READERS.has(name)) context.report({ node, messageId: 'member', data: { name } });
      },
    };
  },
};

export default { rules: { 'owner-caller-imports': rule } };
