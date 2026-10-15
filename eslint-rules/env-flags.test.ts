import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain-JS module, no types shipped.
import { measure } from './arch-counts.mjs';
// @ts-expect-error: plain-JS module, no types shipped.
import { ENV_PATTERNS, PROFILE_FLAG_KEYS, allowedBy, rules } from './env-flags.mjs';

/**
 * Flags and env from one place (A10 #11): outside its named list each
 * pattern counts 0, and each list names exactly the files and folders that
 * still have it, each with a reason.
 */
const ROOT = join(__dirname, '..');
type Pattern = { count: (code: string) => number; allowed: Record<string, string> };
const PATTERNS = ENV_PATTERNS as Record<string, Pattern>;
const allowed = allowedBy as (list: Record<string, string>, path: string) => string | null;

describe('flags and env from one place', () => {
  const got = measure(ROOT) as {
    perFile: {
      envFlags: Record<
        string,
        { outside: Record<string, number>; allowed: Record<string, number> }
      >;
    };
  };

  for (const [key, { allowed: list }] of Object.entries(PATTERNS)) {
    it(`${key}: none outside the list, and every list entry still has it`, () => {
      const seen = got.perFile.envFlags[key]!;
      expect(seen.outside).toEqual({});
      const used = new Set(Object.keys(seen.allowed).map((f) => allowed(list, f)));
      expect([...used].sort()).toEqual(Object.keys(list).sort());
      for (const [f, why] of Object.entries(list)) {
        expect(existsSync(join(ROOT, f)), f).toBe(true);
        expect(why.length, f).toBeGreaterThan(10);
      }
    });
  }

  it('reads the profile flag keys from PROFILE_FLAGS', () => {
    expect(PROFILE_FLAG_KEYS).toContain('shareNeat');
    expect(PROFILE_FLAG_KEYS).toContain('teamPrivateReads');
    expect((PROFILE_FLAG_KEYS as string[]).length).toBe(7);
  });

  const count = (key: string, code: string) => PATTERNS[key]!.count(code);
  it('counts each hand parse shape the survey found', () => {
    for (const code of [
      "const n = Number(env('X') ?? 8);",
      "const n = Number.parseInt(env('X') ?? '', 10);",
      'const n = Number(process.env.PORT || 3000);',
      'const n = parseInt(envDynamic(name), 10);',
      "const on = env('X') === '1';",
      "const on = env('X') !== '0';",
      "const on = !/^(0|false|off|no)$/i.test(env('X') ?? '');",
      "const v = env('X')?.trim().toLowerCase();",
      "const raw = env('X');\nconst n = Number(raw);",
    ]) {
      expect(count('handParse', code), code).toBe(1);
    }
    for (const code of [
      "const n = envNum('X');",
      "const on = feature('runs');",
      "const mode = env('NODE_ENV') === 'production';",
      "const url = env('X')?.trim() || 'http://a';",
    ]) {
      expect(count('handParse', code), code).toBe(0);
    }
  });

  it('counts raw reads, isXEnabled definitions and hand profile defaults', () => {
    expect(count('rawRead', 'const a = process.env.X;')).toBe(1);
    expect(count('rawRead', "const a = process.env['X'];")).toBe(1);
    expect(count('rawRead', "define: { 'process.env.NODE_ENV': '\"production\"' }")).toBe(0);
    expect(count('rawRead', 'spawn(cmd, { env: process.env });')).toBe(0);
    expect(count('isEnabledDef', 'export function isFooEnabled() {}')).toBe(1);
    expect(count('isEnabledDef', 'const isFooEnabled = () => true;')).toBe(1);
    expect(count('isEnabledDef', "if (feature('foo')) {}")).toBe(0);
    expect(count('prefDefault', 'const on = prefs.shareNeat !== false;')).toBe(1);
    expect(count('prefDefault', 'const on = merged.remoteMcpEnabled === true;')).toBe(1);
    expect(count('prefDefault', "const on = profileFlag(prefs, 'shareNeat');")).toBe(0);
  });

  const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });
  const cases: Array<[string, string, string]> = [
    ['rawRead', 'const a = process.env.X;', 'packages/config/src/index.ts'],
    ['handParse', "const n = Number(env('X'));", 'server/sandboxd/src/main.ts'],
    [
      'isEnabledDef',
      'export function isFooEnabled() { return true; }',
      'server/web/lib/mcp-oauth.ts',
    ],
    ['prefDefault', 'const on = prefs.shareNeat !== false;', ''],
  ];
  for (const [key, code, named] of cases) {
    it(`${key}: flags a product file${named ? ', passes a named one' : ''}`, () => {
      tester.run(key, (rules as Record<string, never>)[key]!, {
        valid: [
          ...(named ? [{ code, filename: join(ROOT, named) }] : []),
          { code: '// nothing here\nconst x = 1;', filename: join(ROOT, 'packages/x/src/a.ts') },
        ],
        invalid: [
          { code, filename: join(ROOT, 'packages/x/src/a.ts'), errors: [{ messageId: 'over' }] },
        ],
      });
    });
  }
});
