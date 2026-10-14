import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain-JS rule module, no types shipped.
import {
  BODY_READ_ALLOW,
  directBodyReads,
  isRoutePath,
  noDirectBodyReads,
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
