import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain-JS module, no types shipped.
import { measure } from './arch-counts.mjs';
// @ts-expect-error: plain-JS module, no types shipped.
import { BARE_FETCH_ALLOWED, bareFetchSwept, rule } from './no-bare-fetch.mjs';

/**
 * One egress fetch (A10 part 1, docs/egress.md): the bare fetch sites left
 * in the swept packages are exactly the listed fixed-host files, and the
 * rule flags any other.
 */
const ROOT = join(__dirname, '..');
const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });

describe('no-bare-fetch', () => {
  it('the bare fetch sites in tools, calendar and content are the listed fixed-host files', () => {
    const got = measure(ROOT) as { perFile: { bareFetch: Record<string, number> } };
    expect(Object.keys(got.perFile.bareFetch).sort()).toEqual(
      Object.keys(BARE_FETCH_ALLOWED).sort(),
    );
    for (const f of Object.keys(BARE_FETCH_ALLOWED))
      expect(existsSync(join(ROOT, f)), f).toBe(true);
  });

  it('sweeps the three packages, not tests or other packages', () => {
    expect(bareFetchSwept('packages/tools/src/x.ts')).toBe(true);
    expect(bareFetchSwept('packages/calendar/src/providers/x.ts')).toBe(true);
    expect(bareFetchSwept('packages/content/src/x.ts')).toBe(true);
    expect(bareFetchSwept('packages/tools/src/x.test.ts')).toBe(false);
    expect(bareFetchSwept('packages/voice/src/x.ts')).toBe(false);
    expect(bareFetchSwept('packages/std/src/egress.ts')).toBe(false);
  });

  it('flags fetch( and globalThis.fetch( outside the list; passes the egress fetch and listed files', () => {
    tester.run('no-bare-fetch', rule, {
      valid: [
        {
          code: 'const r = await egressFetch(url, {}, { maxBytes: 1 });',
          filename: '/r/packages/calendar/src/providers/ics.ts',
        },
        {
          code: 'const r = await fetch(url);',
          filename: '/r/packages/tools/src/builtins-locations.ts',
        },
        { code: 'const r = await fetch(url);', filename: '/r/packages/tools/src/x.test.ts' },
        { code: 'const r = await fetch(url);', filename: '/r/packages/voice/src/x.ts' },
        { code: 'const r = await client.fetch(url);', filename: '/r/packages/tools/src/x.ts' },
        { code: 'const f: typeof fetch = egress;', filename: '/r/packages/tools/src/x.ts' },
      ],
      invalid: [
        {
          code: 'const r = await fetch(url);',
          filename: '/r/packages/content/src/peers-client.ts',
          errors: [{ messageId: 'bare' }],
        },
        {
          code: 'const r = await globalThis.fetch(url);',
          filename: '/r/packages/tools/src/x.ts',
          errors: [{ messageId: 'bare' }],
        },
      ],
    });
  });
});
