/**
 * no-guard-calls: a route handler reads the caller the pipeline answered
 * (ownerCaller(), memberCaller(), ...; the one list, session-guards.mjs
 * READER_ANSWERS) and calls no session guard (the login guards, the asset
 * guards, the cookie upgrade). A hard ban: every route of the manifest
 * reads the answer of its row's caller kind, the gate answers it once, and
 * nothing outside session.ts (which defines the guards and runs them for
 * the gate, answerRouteCaller) calls one. eslint-rules/arch-lints.test.ts
 * holds the count at 0.
 *
 * It runs on every script file under server/web (eslint.config.mjs), tests
 * aside. Reported: a guard imported by name (renamed or not), read off an
 * object (`auth.getLoginOr401`, `auth['getLoginOr401']`) or destructured
 * (`const { getLoginOr401 } = await import(...)`). One exception, named
 * here: the render pages (server/pages/print.ts) are pages, not routes of
 * the manifest, and keep their own redirecting guard
 * (requireOwnerForRender).
 */
import { SESSION_GUARDS } from './session-guards.mjs';

const GUARDS = new Set(SESSION_GUARDS);

/** The one exception: each file to the guards it may still name. */
export const GUARD_EXCEPTIONS = Object.freeze({
  // The render pages (/print/pages, /print/draws, /render/draws): pages of
  // server/pages, not routes of the manifest; their guard redirects.
  'server/web/server/pages/print.ts': Object.freeze(['requireOwnerForRender']),
});

/** The repo-relative path of `filename` under server/web, or null. */
function webPath(filename) {
  const f = filename.replace(/\\/g, '/');
  const at = f.lastIndexOf('server/web/');
  return at < 0 ? null : f.slice(at);
}

/** Whether `filename` is exempt: the definition (session.ts, which runs the
 *  guards for the gate) and tests. */
export function isExempt(filename) {
  const f = filename.replace(/\\/g, '/');
  if (/\.test\.[cm]?[jt]sx?$/.test(f)) return true;
  return /(^|\/)server\/web\/lib\/auth\/session\.ts$/.test(f);
}

/** Whether `filename` may name `guard` (GUARD_EXCEPTIONS). */
export function mayName(filename, guard) {
  const path = webPath(filename);
  return !!path && (GUARD_EXCEPTIONS[path] ?? []).includes(guard);
}

/** The name a key spells: an identifier, a string literal, or a template
 *  literal with no expression in it. */
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
        'No session guard is called outside session.ts: a route reads the caller the pipeline answered (A4 exit).',
    },
    messages: {
      guard:
        '{{name}} is a session guard: read the caller the pipeline answered instead (ownerCaller(), memberCaller(), anyLoginCaller(), ...; eslint-rules/session-guards.mjs READER_ANSWERS). The gate runs the guard of the row, once (A4 exit).',
    },
    schema: [],
  },
  create(context) {
    const file = context.filename;
    if (isExempt(file)) return {};
    const report = (node, name) => {
      if (GUARDS.has(name) && !mayName(file, name)) {
        context.report({ node, messageId: 'guard', data: { name } });
      }
    };
    return {
      ImportSpecifier(node) {
        report(node, nameOf(node.imported));
      },
      ExportSpecifier(node) {
        const name = [nameOf(node.local), nameOf(node.exported)].find((n) => GUARDS.has(n));
        if (name) report(node, name);
      },
      MemberExpression(node) {
        if (
          node.computed &&
          node.property.type !== 'Literal' &&
          node.property.type !== 'TemplateLiteral'
        ) {
          return;
        }
        report(node, nameOf(node.property));
      },
      Property(node) {
        if (node.parent.type !== 'ObjectPattern') return;
        report(node, nameOf(node.key));
      },
    };
  },
};

export default { rules: { 'no-guard-calls': rule } };
