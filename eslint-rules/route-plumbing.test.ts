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
} from './route-plumbing.mjs';

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
    expect(
      Object.values(ERROR_TEXT_ALLOW).every((r) => typeof r === 'string' && r.length > 0),
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
