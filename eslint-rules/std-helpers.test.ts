import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain-JS module, no types shipped.
import { measure, stripComments } from './arch-counts.mjs';
// @ts-expect-error: plain-JS module, no types shipped.
import { STD_HELPER_PATTERNS, rules } from './std-helpers.mjs';

/**
 * Small helpers and process plumbing copied back (A10 #15): outside its
 * named list each pattern counts 0, and each list holds exactly the files
 * that still have it, each with a reason.
 */
const ROOT = join(__dirname, '..');
type Pattern = { count: (code: string) => number; allowed: Record<string, string> };
const PATTERNS = STD_HELPER_PATTERNS as Record<string, Pattern>;

describe('small helpers copied back (A10 #15)', () => {
  const got = measure(ROOT) as {
    perFile: {
      stdHelpers: Record<
        string,
        { outside: Record<string, number>; allowed: Record<string, number> }
      >;
    };
  };

  for (const [key, { allowed }] of Object.entries(PATTERNS)) {
    it(`${key}: none outside the list, and the list is exactly the files that have it`, () => {
      const seen = got.perFile.stdHelpers[key]!;
      expect(seen.outside).toEqual({});
      expect(Object.keys(seen.allowed).sort()).toEqual(Object.keys(allowed).sort());
      for (const [f, why] of Object.entries(allowed)) {
        expect(existsSync(join(ROOT, f)), f).toBe(true);
        expect(why.length, f).toBeGreaterThan(10);
      }
    });
  }

  it('reads each helper as the one place its pattern lives', () => {
    const at = (f: string) => stripComments(readFileSync(join(ROOT, f), 'utf8'));
    expect(PATTERNS.uuidCopy!.count(at('packages/std/src/index.ts'))).toBe(1);
    expect(PATTERNS.dedupeTagsCopy!.count(at('packages/content/src/tags.ts'))).toBe(1);
    expect(PATTERNS.signalHandler!.count(at('packages/std/src/shutdown.ts'))).toBe(1);
    expect(PATTERNS.advisoryLock!.count(at('packages/db/src/advisory-lock.ts'))).toBe(2);
    expect(PATTERNS.ttlAgeCheck!.count(at('packages/std/src/ttl-cache.ts'))).toBe(2);
  });

  const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });
  const cases: Array<[string, string]> = [
    ['uuidCopy', 'const R = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;'],
    ['errorIdiom', 'const m = err instanceof Error ? err.message : String(err);'],
    ['dedupeTagsCopy', 'function dedupeTags(tags) { return tags; }'],
    ['signalHandler', "process.on('SIGTERM', () => process.exit(0));"],
    ['advisoryLock', "const q = 'select pg_advisory_xact_lock(hashtext($1))';"],
    ['ttlAgeCheck', 'if (hit && Date.now() - hit.at < TTL_MS) use(hit);'],
    ['cacheControlLiteral', "const h = { 'Cache-Control': 'no-store' };"],
  ];
  for (const [key, code] of cases) {
    it(`the ${key} rule flags a file outside its list`, () => {
      tester.run(key, (rules as Record<string, never>)[key], {
        valid: [{ code: 'const ok = 1;', filename: join(ROOT, 'packages/x/src/a.ts') }],
        invalid: [
          {
            code,
            filename: join(ROOT, 'packages/x/src/a.ts'),
            errors: [{ messageId: 'over' }],
          },
        ],
      });
    });
  }
});
