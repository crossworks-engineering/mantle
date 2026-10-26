/**
 * no-guard-calls (workspaces arch plan v2, section 11; A0): a route handler
 * reads the caller the pipeline answered (ownerCaller(), memberCaller(), ...;
 * the one list, session-guards.mjs READER_ANSWERS) and calls no session
 * guard (getOwnerOr401 and its variants, the asset guards, the cookie
 * upgrade). A hard ban since A4 exit (A4 hand batch B): every route of the
 * manifest reads the answer of its row's caller kind, the gate answers it
 * once, and nothing outside session.ts (which defines the guards and runs
 * them for the gate, answerRouteCaller) calls one.
 *
 * It runs on every script file under server/web (eslint.config.mjs), tests
 * aside. Reported: a guard imported by name (renamed or not), read off an
 * object (`auth.getLoginOr401`, `auth['getLoginOr401']`) or destructured
 * (`const { getLoginOr401 } = await import(...)`). One exception, named
 * here: the render pages (server/pages/print.ts) are pages, not routes of
 * the manifest, and keep their own redirecting guard
 * (requireOwnerForRender), as A4 step 2 left them.
 *
 * The history of the count it replaced (eslint-rules/arch-lints.test.ts
 * holds the count at 0, scripts/arch-scoreboard.pins.json pins it):
 *
 * 469 -> 468 (task d78e7bde): PUT and DELETE /api/team-admin/hub-app became
 * 410 stubs (`gone('owner')` runs the same guard from lib/gone.ts), and the
 * new GET /api/home adds one call.
 *
 * 468 -> 439 (A4 step 3b part 1, batch 1, the self rows): 29 getOwnerOr401
 * calls in 23 route files became reads of the caller the pipeline answers.
 *
 * 439 -> 382 (A4 step 3b part 2, batch 2, the content reads): 57 GET
 * handlers' getOwnerOr401 calls in 57 route files became reads.
 *
 * 382 -> 285 (A4 step 3b part 3, batch 3, the content writes): 101 write
 * handlers in 81 route files became reads, 98 of them getOwnerOr401 calls
 * (97 counted: server/web/app/api/apps/[id]/build/route.ts sits under a
 * `build/` folder the counts skipped until A4 step 3b part 4, which counts
 * such a route segment; it reads the caller now, so the pin holds) and the
 * 3 getOwnerOr401WithLogin calls of the app brokers and the frame ticket
 * (not counted here).
 *
 * 285 -> 43 (A4 step 3b part 4, batch 4, the Admin area rows): 243
 * handlers in 172 route files became reads, 242 of them getOwnerOr401
 * calls and POST /api/users/:id/password's getOwnerOr401WithSource (not
 * counted here).
 *
 * 43 -> 16 (A4 step 3b part 5, batch 5, the member and chat rows): 27
 * handlers in 24 route files became reads, 10 getMemberOr401 calls (the
 * member list) and 17 getChatLoginOr401 calls (the chat and Telegram chat
 * lists).
 *
 * 16 -> 7 (A4 hand batch A): the five any-login handlers of the four
 * ruleInQuery files, the two turn routes with a flag check first and POST
 * /api/dev-tools/queue-approval, and POST /api/assistant/turn read the
 * caller.
 *
 * 7 -> 0 (A4 hand batch B, A4 exit): the public rows that read the login
 * (whoami, logout, change password, pair and its poll, the OAuth consent)
 * read it at the read (publicLoginItself()), and PATCH /api/pages/:id its
 * owner (ownerCallerAtRead()). The guards the count did not see went too:
 * the asset guards (ownerAssetCaller(), readerAssetCaller(), the member
 * byte stubs' memberAssetCaller()) and the cookie upgrade
 * (cookieUpgradeCaller()). getOwnerOr401 and the guards no one called any
 * more were deleted.
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
