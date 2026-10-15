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
    expect(PATTERNS.ttlAgeCheck!.count(at('packages/std/src/ttl-cache.ts'))).toBe(1);
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

  // Fix round 1, L2: the signal, Cache-Control and TTL counts read the
  // syntax tree, so a site respelled (another receiver, a name bound to the
  // value, another way to set the header) is still counted.
  const respelled: Array<[string, string, number]> = [
    ['signalHandler', "process.on('SIGTERM', h)", 1],
    ['signalHandler', "emitter.addListener('SIGINT', h)", 1],
    ['signalHandler', "const S = 'SIGTERM'; p.once(S, h)", 1],
    ['signalHandler', "for (const s of ['SIGINT', 'SIGTERM']) self.on(s, h)", 1],
    ['signalHandler', "['SIGINT', 'SIGTERM'].forEach((sig) => p.prependListener(sig, h))", 1],
    ['signalHandler', "process.on('exit', h); child.kill('SIGTERM')", 0],
    ['cacheControlLiteral', "res.headers.set('Cache-Control', 'no-store')", 1],
    ['cacheControlLiteral', "h.append('cache-control', value)", 1],
    ['cacheControlLiteral', "c.header('Cache-Control', `max-age=${n}`)", 1],
    ['cacheControlLiteral', "res.setHeader('Cache-Control', 'no-store')", 1],
    ['cacheControlLiteral', "const h = { ['cache-control']: x }", 1],
    ['cacheControlLiteral', "new Headers([['Cache-Control', 'no-store']])", 1],
    ['cacheControlLiteral', "headers['Cache-Control'] = 'no-store'", 1],
    ['cacheControlLiteral', "const v = 'no-store'; c.header('Cache-Control', v)", 1],
    ['cacheControlLiteral', "c.header('Cache-Control', CACHE_CONTROL.none)", 0],
    [
      'cacheControlLiteral',
      "const h = { 'Cache-Control': ok ? CACHE_CONTROL.none : CACHE_CONTROL.revalidate }",
      0,
    ],
    ['cacheControlLiteral', "const v = API_CACHE_DEFAULT; h.set('cache-control', v)", 0],
    ['cacheControlLiteral', "const h = new Headers(cacheHeaders('none'))", 0],
    ['ttlAgeCheck', 'if (Date.now() - entry.loadedAt < MAX_AGE) use(entry);', 1],
    ['ttlAgeCheck', 'if (now() - row.stamp >= CACHE_TTL) drop(row);', 1],
    ['ttlAgeCheck', 'if (CACHE_MS > performance.now() - x.when) use(x);', 1],
    ['ttlAgeCheck', 'if (tok.expiresAt > Date.now()) use(tok);', 1],
    ['ttlAgeCheck', 'if (now - at <= ARRIVAL_WINDOW_MS) keep(a);', 0],
  ];
  for (const [key, code, want] of respelled) {
    it(`${key} counts ${want} in: ${code}`, () => {
      expect(PATTERNS[key]!.count(code)).toBe(want);
    });
  }
});
