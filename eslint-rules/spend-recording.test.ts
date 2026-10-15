import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain-JS module, no types shipped.
import { measure, stripComments } from './arch-counts.mjs';
// @ts-expect-error: plain-JS module, no types shipped.
import { SPEND_PATTERNS, rules } from './spend-recording.mjs';

/**
 * Spend recording (A10 #5): outside its named list each pattern counts 0,
 * and each list holds exactly the files that still have it, each with a
 * reason.
 */
const ROOT = join(__dirname, '..');
type Pattern = { count: (code: string) => number; allowed: Record<string, string> };
const PATTERNS = SPEND_PATTERNS as Record<string, Pattern>;

describe('spend recording', () => {
  const got = measure(ROOT) as {
    perFile: {
      spend: Record<string, { outside: Record<string, number>; allowed: Record<string, number> }>;
    };
  };

  for (const [key, { allowed }] of Object.entries(PATTERNS)) {
    it(`${key}: none outside the list, and the list is exactly the files that have it`, () => {
      const seen = got.perFile.spend[key]!;
      expect(seen.outside).toEqual({});
      expect(Object.keys(seen.allowed).sort()).toEqual(Object.keys(allowed).sort());
      for (const [f, why] of Object.entries(allowed)) {
        expect(existsSync(join(ROOT, f)), f).toBe(true);
        expect(why.length, f).toBeGreaterThan(10);
      }
    });
  }

  it('@mantle/voice exports no raw built-in adapter object', () => {
    // A raw adapter's call records nothing: only the wrapped lookups leave
    // the package (A10 #5 fix round 1).
    const barrel = stripComments(
      readFileSync(join(ROOT, 'packages/voice/src/adapters/index.ts'), 'utf8'),
    ) as string;
    const exported = [...barrel.matchAll(/export\s*\{([^}]*)\}/g)].flatMap((m) =>
      m[1]!.split(',').map((n) => n.trim().replace(/^type\s+/, '')),
    );
    const raw = exported.filter((n) =>
      /^(?!get|register|list)[a-z]\w*(?:ChatAdapter|DecisionAdapter|VisionAdapter|ImageAdapter|TtsAdapter|SttAdapter|Embedding)$/.test(
        n,
      ),
    );
    expect(raw).toEqual([]);
  });

  it('the registry wraps every lookup the contract package exports', () => {
    // A lookup added to @mantle/voice-client without a recording twin in
    // @mantle/voice would hand out an adapter that records nothing.
    const read = (p: string) => stripComments(readFileSync(join(ROOT, p), 'utf8')) as string;
    const lookups = (code: string) =>
      [...code.matchAll(/export function ((?:get|list)\w+Adapters?|registeredChatAdapter)\(/g)].map(
        (m) => m[1]!,
      );
    const contract = lookups(read('packages/voice-client/src/adapters/registry.ts'));
    const wrapped = new Set(lookups(read('packages/voice/src/adapters/registry.ts')));
    // registeredChatAdapter is the unwrapped chat lookup; getChatAdapter wraps it.
    const missing = contract.filter((n) => n !== 'registeredChatAdapter' && !wrapped.has(n));
    expect(missing).toEqual([]);
    expect(wrapped.has('getChatAdapter')).toBe(true);
  });

  const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });
  const cases: Array<[string, string]> = [
    ['handSpend', 'trace.costMicroUsd += 5;'],
    ['handSpend', "recordUsage({ capability: 'chat', provider: 'p', model: 'm' });"],
    ['providerBypass', "import { getTtsAdapter } from '@mantle/voice-client/adapters/registry';"],
    ['providerBypass', 'const c = new OpenRouter({ apiKey });'],
    // A10 #5 fix round 1: a suffixed registry path, a raw adapter object's
    // call, a hand addition to the embedding total.
    [
      'providerBypass',
      "import { getTtsAdapter } from '@mantle/voice-client/adapters/registry.ts';",
    ],
    ['providerBypass', "import { x } from '@mantle/voice-client/src/adapters/registry.js';"],
    ['providerBypass', 'await openrouterChatAdapter.chat(opts);'],
    ['providerBypass', 'await openrouterDecisionAdapter.decide(opts);'],
    ['providerBypass', 'await openaiEmbedding.embed(req);'],
    ['handSpend', 'ctx.tokens.embed += 5;'],
  ];
  for (const [key, code] of cases) {
    it(`${key}: flags a product file, passes a named one (${code.slice(0, 30)})`, () => {
      const allowed = Object.keys(PATTERNS[key]!.allowed)[0]!;
      tester.run(key, (rules as Record<string, never>)[key]!, {
        valid: [
          { code, filename: join(ROOT, allowed) },
          {
            code: '// recordUsage(x)\nconst x = 1;',
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
