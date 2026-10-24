import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain-JS rule module, no types shipped.
import {
  BODY_READ_ALLOW,
  ERROR_TEXT_ALLOW,
  directBodyReads,
  errorTextReplies,
  isRoutePath,
  noDirectBodyReads,
  noErrorTextReplies,
  ROUTE_POLICY_EXPORT,
  routePolicyDeclared,
} from './route-plumbing.mjs';
import { ROUTE_POLICY_EXPORT as DECLARED_EXPORT } from '../server/web/lib/auth/route-declaration';

/**
 * no-direct-body-reads (A10 part 2, fold 1): a route reads its body with
 * readBody(req, Schema) or readJson(req), never req.json() and the like;
 * the files that read it another way are named with their reason.
 */
describe('no-direct-body-reads', () => {
  it('knows the route files and the named ones', () => {
    expect(isRoutePath('/r/server/web/app/api/notes/route.ts')).toBe(true);
    expect(isRoutePath('/r/server/web/lib/read-body.ts')).toBe(false);
    expect(BODY_READ_ALLOW['server/web/app/api/oauth/token/route.ts']).toMatch(/form post/);
    expect(directBodyReads('await req.json(); request.text(); _req.formData(); req.body')).toBe(4);
    expect(directBodyReads('await res.json(); readJson(req); req.headers.get("x")')).toBe(0);
  });

  const tester = new RuleTester({
    languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' },
  });
  const route = '/r/server/web/app/api/notes/route.ts';

  it('allows the one reader, a response read and a named file; refuses a direct read', () => {
    tester.run('no-direct-body-reads', noDirectBodyReads, {
      valid: [
        {
          code: 'export async function POST(req: Request) { const b = await readBody(req, Body); }',
          filename: route,
        },
        {
          code: 'export async function POST(req: Request) { const r = await fetch(u); await r.json(); }',
          filename: route,
        },
        {
          code: 'export async function POST(req: Request) { await req.formData(); }',
          filename: '/r/server/web/app/api/oauth/token/route.ts',
        },
        {
          code: 'export async function POST(req: Request) { await req.json(); }',
          filename: '/r/server/web/app/api/notes/notes.test.ts',
        },
        {
          code: 'export async function POST(req: Request) { await req.json(); }',
          filename: '/r/server/web/lib/x.ts',
        },
      ],
      invalid: [
        {
          code: 'export async function POST(req: Request) { await req.json().catch(() => ({})); }',
          filename: route,
          errors: [{ messageId: 'read' }],
        },
        {
          code: 'export async function PUT(r: Request) { await r.text(); }',
          filename: route,
          errors: [{ messageId: 'read' }],
        },
        {
          code: 'export const POST = async (request: Request) => request.formData();',
          filename: route,
          errors: [{ messageId: 'read' }],
        },
        {
          code: 'export async function POST(req: Request) { return req.body; }',
          filename: route,
          errors: [{ messageId: 'read' }],
        },
      ],
    });
  });
});

/**
 * no-error-text-replies (A10 part 2, fold 2): a route never puts a caught
 * error's text in its reply; it throws and app.onError answers. The files
 * fold 2 has not moved yet are named.
 */
describe('no-error-text-replies', () => {
  it('counts a catch that replies with the error text, not one that logs it', () => {
    expect(
      errorTextReplies(
        'try { a(); } catch (err) { return NextResponse.json({ error: (err as Error).message }, { status: 400 }); }',
      ),
    ).toBe(1);
    expect(
      errorTextReplies(
        'try { a(); } catch (e) { const msg = errorMessage(e); return NextResponse.json({ error: msg }); }',
      ),
    ).toBe(1);
    expect(
      errorTextReplies(
        'try { a(); } catch (e) { return settingsRedirect(req, { error: (e as Error).message.slice(0, 200) }); }',
      ),
    ).toBe(1);
    expect(
      errorTextReplies(
        "try { a(); } catch (err) { console.error('[x]', errorMessage(err)); return NextResponse.json({ error: 'failed' }, { status: 500 }); }",
      ),
    ).toBe(0);
    expect(errorTextReplies('try { a(); } catch (err) { throw err; }')).toBe(0);
    // Fix round 1 (L5): the shapes the first heuristic missed. A route's own
    // json() helper, a bad(...) reply helper, an HTML page, an `error:` in a
    // list the reply carries.
    expect(
      errorTextReplies(
        'try { a(); } catch (err) { return json({ ok: false, message: errorMessage(err) }); }',
      ),
    ).toBe(1);
    expect(errorTextReplies('try { a(); } catch (err) { return bad(errorMessage(err)); }')).toBe(1);
    expect(
      errorTextReplies(
        'try { a(); } catch (err) { const msg = errorMessage(err); return htmlPage(t, esc(msg), false); }',
      ),
    ).toBe(1);
    expect(
      errorTextReplies(
        "try { a(); } catch (err) { failed.push({ id, error: err instanceof Error ? err.message : 'x' }); }",
      ),
    ).toBe(1);
    // The one helper for a failed item is not the error's text.
    expect(
      errorTextReplies(
        "try { a(); } catch (err) { failed.push({ id, error: itemErrorText(err, 'w', 'failed') }); }",
      ),
    ).toBe(0);
    // Every named file says why: public by design, or waiting on the client.
    expect(
      Object.values(ERROR_TEXT_ALLOW).every(
        (r) => typeof r === 'string' && /^(PUBLIC|NOT_YET): \S/.test(r),
      ),
    ).toBe(true);
  });

  const tester = new RuleTester({
    languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' },
  });
  const route = '/r/server/web/app/api/notes/route.ts';

  it('allows a throw and a fixed reply; refuses the error text in a reply', () => {
    tester.run('no-error-text-replies', noErrorTextReplies, {
      valid: [
        { code: 'try { await a(); } catch (err) { throw err; }', filename: route },
        {
          code: "try { await a(); } catch (err) { console.error(err); return NextResponse.json({ error: 'failed' }); }",
          filename: route,
        },
        {
          code: 'try { await a(); } catch (err) { return NextResponse.json({ error: errorMessage(err) }); }',
          filename: '/r/server/web/lib/x.ts',
        },
      ],
      invalid: [
        {
          code: 'try { await a(); } catch (err) { return NextResponse.json({ error: errorMessage(err) }, { status: 400 }); }',
          filename: route,
          errors: [{ messageId: 'text' }],
        },
      ],
    });
  });
});

/**
 * route-policy-declared (plan v3.2 S9): a route file declares its policy
 * for each method it exports, and no other. Off in eslint.config.mjs until
 * the codemod writes the declarations (part 1).
 */
describe('route-policy-declared', () => {
  const tester = new RuleTester({
    languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' },
  });
  const route = '/r/server/web/app/api/notes/route.ts';
  const decl = (body: string) => `export const policy = routePolicy({ ${body} });`;

  it('names the export the declarations module names', () => {
    expect(ROUTE_POLICY_EXPORT).toBe(DECLARED_EXPORT);
  });

  it('wants a declaration naming each exported method, and only those', () => {
    tester.run('route-policy-declared', routePolicyDeclared, {
      valid: [
        {
          code: `export async function GET() {}\nexport async function POST() {}\n${decl("GET: { class: 'content' }, POST: { class: 'content', item: { none: 'x' } }")}`,
          filename: route,
        },
        {
          code: `export { GET } from '../../notes/route';\n${decl("GET: { class: 'content' }")}`,
          filename: route,
        },
        // `as`, `satisfies` and `!` unwrapped, as the generator reads them
        // (S9 part 3 round 2, the flip audit).
        {
          code: `export async function GET() {}\nexport const policy = routePolicy({ GET: { class: 'content' } }) as const;`,
          filename: route,
        },
        {
          code: `export async function GET() {}\nexport const policy = routePolicy({ GET: { class: 'content' } } satisfies P);`,
          filename: route,
        },
        {
          code: `export async function GET() {}\nexport const policy = routePolicy({ GET: { class: 'content' } })!;`,
          filename: route,
        },
        // Not a route file.
        { code: 'export async function GET() {}', filename: '/r/server/web/lib/notes.ts' },
        // A route file that exports no handler.
        { code: 'export const x = 1;', filename: route },
      ],
      invalid: [
        {
          code: 'export async function GET() {}\nexport const DELETE = handler;',
          filename: route,
          errors: [{ messageId: 'missing' }],
        },
        {
          code: `export async function GET() {}\nexport async function POST() {}\n${decl("GET: { class: 'content' }")}`,
          filename: route,
          errors: [{ messageId: 'undeclared' }],
        },
        {
          code: `export async function GET() {}\n${decl("GET: { class: 'content' }, PUT: { class: 'content', item: { none: 'x' } }")}`,
          filename: route,
          errors: [{ messageId: 'stray' }],
        },
        // Not written out where it is exported (the S9 part 1 audit, L3):
        // a name, another call's argument, an export clause, a re-export.
        {
          code: 'export async function GET() {}\nexport const policy = shared;',
          filename: route,
          errors: [{ messageId: 'notLiteral' }],
        },
        {
          code: 'export async function GET() {}\nexport const policy = routePolicy(base);',
          filename: route,
          errors: [{ messageId: 'notLiteral' }],
        },
        {
          code: `export async function GET() {}\nconst p = routePolicy({ GET: { class: 'content' } });\nexport { p as policy };`,
          filename: route,
          errors: [{ messageId: 'notLiteral' }],
        },
        {
          code: "export async function GET() {}\nexport { policy } from '../../notes/route';",
          filename: route,
          errors: [{ messageId: 'notLiteral' }],
        },
        // The callee is routePolicy by its own name; a spread or a
        // computed key at the top is reported (the flip audit).
        {
          code: `export async function GET() {}\nexport const policy = declare({ GET: { class: 'content' } });`,
          filename: route,
          errors: [{ messageId: 'notLiteral' }],
        },
        {
          code: `export async function GET() {}\nexport const policy = lib.routePolicy({ GET: { class: 'content' } });`,
          filename: route,
          errors: [{ messageId: 'notLiteral' }],
        },
        {
          code: `export async function GET() {}\nexport const policy = routePolicy({ ...shared, GET: { class: 'content' } });`,
          filename: route,
          errors: [{ messageId: 'notWrittenOut' }],
        },
        {
          code: `export async function GET() {}\nexport const policy = routePolicy({ ...shared });`,
          filename: route,
          errors: [{ messageId: 'undeclared' }, { messageId: 'notWrittenOut' }],
        },
        {
          code: `export async function GET() {}\nexport const policy = routePolicy({ [m]: { class: 'content' }, GET: { class: 'content' } });`,
          filename: route,
          errors: [{ messageId: 'notWrittenOut' }],
        },
      ],
    });
  });

  it("reads the methods the generator's one reader reads (scripts/route-callers.ts exportedMethods)", async () => {
    const { exportedMethods } = await import('../server/web/scripts/route-callers');
    const forms = [
      'export async function POST() {}',
      'export const PATCH = async () => null;',
      'const handler = async () => null;\nexport { handler as DELETE };',
      "export { GET } from '../../notes/route';",
      "import { GET as base } from '../../notes/route';\nexport { base as HEAD };",
      "export type { PUT } from './types';",
      'function OPTIONS() {}',
    ];
    const all = [...forms, forms.join('\n')];
    const read = (code: string) => exportedMethods(code, 'app/api/notes/route.ts');
    expect(read(all.at(-1)!)).toEqual(['GET', 'POST', 'PATCH', 'DELETE', 'HEAD']);
    // The lint's 'missing' names the methods it read: each form's must be
    // the generator's, and a form that exports none is not asked.
    tester.run('route-policy-declared', routePolicyDeclared, {
      valid: all.filter((c) => read(c).length === 0).map((code) => ({ code, filename: route })),
      invalid: all
        .filter((c) => read(c).length > 0)
        .map((code) => ({
          code,
          filename: route,
          errors: [{ messageId: 'missing', data: { methods: [...read(code)].sort().join(', ') } }],
        })),
    });
  });
});
