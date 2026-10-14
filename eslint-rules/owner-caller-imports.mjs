/**
 * owner-caller-imports (workspaces arch A4 step 3b): the caller the HTTP
 * pipeline answers is read only in a route handler, by its reader's own
 * name: every reader of the one list (session-guards.mjs CALLER_READERS),
 * the owner's (ownerCaller and its two projections) and, since part 5, the
 * member's (memberCaller), the any-login's (loginCaller) and the chat
 * login's (chatLoginCaller). The
 * route manifest generator reads each route file to learn which handlers
 * read it (server/web/scripts/route-callers.ts) and the gate answers only
 * those rows; a read it cannot see (a helper of lib, a renamed import, a
 * read off an object) would run on a row the gate did not answer and
 * throw. So, outside session.ts (which defines it) and tests:
 *
 *  - a reader (ownerCaller, memberCaller, ...) is imported only in a route
 *    file under server/web/app/api, from @/lib/auth (or
 *    @/lib/auth/session), and never renamed;
 *  - it is never re-exported, read off an object (`auth.ownerCaller`,
 *    `auth['ownerCaller']`, a template literal key with no expression) or
 *    destructured (`const { ownerCaller } = await import(...)`).
 *
 *
 * A4 hand batch B fix round 1 (L3): a reader answered at the read
 * (READER_ANSWERS `atRead`: publicLoginCaller, cookieUpgradeCaller,
 * ownerCallerAtRead) runs the gate's answer when it is called, so in a
 * route file
 *
 *  - its call is awaited where it is made (`await publicLoginCaller()`): a
 *    promise left unawaited is a login that is always there, and a refusal
 *    no one sees;
 *  - ownerCallerAtRead is never called inside a try block: its refusal is
 *    thrown (RouteRefusal) for the app to answer, and a catch could swallow
 *    it and run the handler with no owner.
 *
 * It runs on every script file under server/web (.ts, .tsx, .mts, .cts,
 * .js, .jsx, .mjs, .cjs; eslint.config.mjs), tests aside.
 *
 * The generator refuses the rest inside a route file (a reference other
 * than a plain call, a read outside a handler, a handler that reads two
 * kinds), and a row whose list no guard of the reader's kind serves fails
 * to build (route-policy.ts buildRouteRow): the reader is read only where
 * the gate answered its kind.
 */
import { CALLER_READERS, READER_ANSWERS } from './session-guards.mjs';

const READERS = new Set(CALLER_READERS);
/** The readers answered at the read: each call is awaited where it is made. */
export const AT_READ_READERS = new Set(
  Object.entries(READER_ANSWERS)
    .filter(([, a]) => a.atRead === true)
    .map(([name]) => name),
);
/** The readers whose refusal is thrown at the read: never inside a try. */
export const THROWING_AT_READ = new Set(['ownerCallerAtRead']);

/** Whether `node` sits in the protected block of a try statement. */
function inTryBlock(node) {
  for (let child = node, n = node.parent; n; child = n, n = n.parent) {
    if (n.type === 'TryStatement' && n.block === child) return true;
  }
  return false;
}
const READER_MODULES = new Set(['@/lib/auth', '@/lib/auth/session']);

/** Whether `filename` is a route file under server/web/app/api. */
export function isApiRouteFile(filename) {
  const f = filename.replace(/\\/g, '/');
  return /(^|\/)server\/web\/app\/api\/(.+\/)?route\.tsx?$/.test(f);
}

/** Whether `filename` is exempt: the definition, tests, and the gone stubs'
 *  handler (server/web/lib/gone.ts `gone()`, A4 hand batch A): the
 *  generator reads `export const GET = gone('owner')` in the route file as
 *  a read of the stub's kind (lib/gone-kinds.ts GONE_KINDS), so the read
 *  it makes is one the generator sees. */
export function isExempt(filename) {
  const f = filename.replace(/\\/g, '/');
  if (/\.test\.[cm]?[jt]sx?$/.test(f)) return true;
  return /(^|\/)server\/web\/lib\/(auth\/session|gone)\.ts$/.test(f);
}

/** The name a key spells: an identifier, a string literal, or a template
 *  literal with no expression in it (`auth[\`ownerCaller\`]`). */
const nameOf = (node) => {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'TemplateLiteral') {
    return node.expressions.length === 0 ? (node.quasis[0]?.value.cooked ?? null) : null;
  }
  return typeof node.value === 'string' ? node.value : null;
};

export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A reader of the caller the pipeline answers (ownerCaller, memberCaller, loginCaller, chatLoginCaller) is imported by its own name, only in an app/api route file (A4 step 3b).',
    },
    messages: {
      notRoute:
        '{{name}} is read only in a route handler under server/web/app/api: the manifest generator reads the route files to learn which rows the gate answers (A4 step 3b). Pass what it reads in from the handler.',
      renamed:
        'Import {{name}} by its own name: the manifest generator reads the route files by it (A4 step 3b).',
      module: 'Import {{name}} from @/lib/auth.',
      reexport:
        '{{name}} is not re-exported: a route handler imports it from @/lib/auth (A4 step 3b).',
      member:
        'Do not read {{name}} off an object: import it by name in the route file and call it (A4 step 3b).',
      notAwaited:
        'Await {{name}}() where it is called: it runs the answer the gate took at the read (A4 hand batch B).',
      inTry:
        '{{name}}() throws its refusal for the app to answer: do not call it inside a try block, where a catch could swallow it (A4 hand batch B).',
    },
    schema: [],
  },
  create(context) {
    const file = context.filename;
    if (isExempt(file)) return {};
    const route = isApiRouteFile(file);
    return {
      CallExpression(node) {
        if (!route || node.callee.type !== 'Identifier') return;
        const name = node.callee.name;
        if (!AT_READ_READERS.has(name)) return;
        if (node.parent.type !== 'AwaitExpression') {
          context.report({ node, messageId: 'notAwaited', data: { name } });
        }
        if (THROWING_AT_READ.has(name) && inTryBlock(node)) {
          context.report({ node, messageId: 'inTry', data: { name } });
        }
      },
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
        if (
          node.computed &&
          node.property.type !== 'Literal' &&
          node.property.type !== 'TemplateLiteral'
        ) {
          return;
        }
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
