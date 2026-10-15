import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain-JS module, no types shipped.
import { measure, stripComments } from './arch-counts.mjs';
// @ts-expect-error: plain-JS module, no types shipped.
import { PROVIDER_HTTP_PATTERNS, rules } from './provider-http.mjs';

/**
 * Provider HTTP plumbing (A10 #10): outside its named list each pattern
 * counts 0, and each list holds exactly the files that still have it, each
 * with a reason.
 */
const ROOT = join(__dirname, '..');
type Pattern = { count: (code: string) => number; allowed: Record<string, string> };
const PATTERNS = PROVIDER_HTTP_PATTERNS as Record<string, Pattern>;

describe('provider HTTP plumbing', () => {
  const got = measure(ROOT) as {
    perFile: {
      providerHttp: Record<
        string,
        { outside: Record<string, number>; allowed: Record<string, number> }
      >;
    };
  };

  for (const [key, { allowed }] of Object.entries(PATTERNS)) {
    it(`${key}: none outside the list, and the list is exactly the files that have it`, () => {
      const seen = got.perFile.providerHttp[key]!;
      expect(seen.outside).toEqual({});
      expect(Object.keys(seen.allowed).sort()).toEqual(Object.keys(allowed).sort());
      for (const [f, why] of Object.entries(allowed)) {
        expect(existsSync(join(ROOT, f)), f).toBe(true);
        expect(why.length, f).toBeGreaterThan(10);
      }
    });
  }

  it('reads the std helpers as the one place each pattern lives', () => {
    const http = stripComments(readFileSync(join(ROOT, 'packages/std/src/http.ts'), 'utf8'));
    for (const key of ['inlineTimeout', 'withTimeoutCopy', 'retryAfterRead', 'backoffLoop']) {
      expect(PATTERNS[key]!.count(http), key).toBeGreaterThan(0);
    }
  });

  const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });
  const cases: Array<[string, string]> = [
    ['inlineTimeout', 'fetch(u, { signal: AbortSignal.timeout(5000) });'],
    ['handAbortTimer', 'const t = setTimeout(() => ctrl.abort(), 10);'],
    ['withTimeoutCopy', 'function withTimeout(p, ms) { return p; }'],
    ['retryAfterRead', "const s = res.headers.get('Retry-After');"],
    [
      'backoffLoop',
      'async function f() { for (let attempt = 0; ; attempt++) { await sleep(10); } }',
    ],
  ];
  for (const [key, code] of cases) {
    it(`${key}: flags a product file, passes a named one`, () => {
      const allowed = Object.keys(PATTERNS[key]!.allowed)[0]!;
      tester.run(key, (rules as Record<string, never>)[key]!, {
        valid: [
          { code, filename: join(ROOT, allowed) },
          {
            code: '// AbortSignal.timeout(1)\nconst x = 1;',
            filename: join(ROOT, 'packages/x/src/a.ts'),
          },
        ],
        invalid: [
          { code, filename: join(ROOT, 'packages/x/src/a.ts'), errors: [{ messageId: 'over' }] },
        ],
      });
    });
  }
});
