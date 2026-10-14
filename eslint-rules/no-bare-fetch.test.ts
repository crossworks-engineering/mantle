import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain-JS module, no types shipped.
import { countedFiles, measure } from './arch-counts.mjs';
import {
  BARE_FETCH_ALLOWED,
  BARE_FETCH_KINDS,
  bareFetchSwept,
  platformFetchUses,
  rule,
  // @ts-expect-error: plain-JS module, no types shipped.
} from './no-bare-fetch.mjs';

/**
 * One egress fetch (A10 part 1, docs/egress.md): the files under packages/
 * and server/{web,api}/ that use the platform fetch are exactly the
 * inventory (BARE_FETCH_ALLOWED), each with a kind and a reason, and the
 * rule flags any other use, aliases included.
 */
const ROOT = join(__dirname, '..');
const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });
const ALLOWED = BARE_FETCH_ALLOWED as Record<string, { kind: string; why: string }>;

describe('no-bare-fetch', () => {
  it('the files that use the platform fetch are exactly the inventory', () => {
    const files = (countedFiles(ROOT) as string[]).filter((f) => bareFetchSwept(f));
    const using = files.filter((f) => platformFetchUses(readFileSync(join(ROOT, f), 'utf8')) > 0);
    expect(using.sort()).toEqual(Object.keys(ALLOWED).sort());
    for (const [f, e] of Object.entries(ALLOWED)) {
      expect(existsSync(join(ROOT, f)), f).toBe(true);
      expect(BARE_FETCH_KINDS, f).toContain(e.kind);
      expect(e.why.length, f).toBeGreaterThan(10);
    }
  });

  it('the scoreboard count over tools, calendar and content is the listed files there', () => {
    const got = measure(ROOT) as { perFile: { bareFetch: Record<string, number> } };
    expect(Object.keys(got.perFile.bareFetch).sort()).toEqual(
      Object.keys(ALLOWED)
        .filter((f) => /^packages\/(tools|calendar|content)\/src\//.test(f))
        .sort(),
    );
  });

  it('sweeps product code under packages and server, not tests or scripts', () => {
    expect(bareFetchSwept('packages/tools/src/x.ts')).toBe(true);
    expect(bareFetchSwept('packages/voice/src/x.ts')).toBe(true);
    expect(bareFetchSwept('packages/std/src/egress.ts')).toBe(true);
    expect(bareFetchSwept('server/web/lib/x.ts')).toBe(true);
    expect(bareFetchSwept('server/api/src/x.ts')).toBe(true);
    expect(bareFetchSwept('server/web/components/x.tsx')).toBe(true);
    expect(bareFetchSwept('packages/tools/src/x.test.ts')).toBe(false);
    expect(bareFetchSwept('server/web/scripts/x.ts')).toBe(false);
    expect(bareFetchSwept('scripts/x.ts')).toBe(false);
    expect(bareFetchSwept('server/mcp/src/x.ts')).toBe(false);
  });

  it('counts calls, aliases and global members in text, not types or comments', () => {
    expect(platformFetchUses('const r = await fetch(u);')).toBe(1);
    expect(platformFetchUses('const f = fetch;')).toBe(1);
    expect(platformFetchUses('const f = globalThis.fetch;')).toBe(1);
    expect(platformFetchUses("const f = globalThis['fetch'];")).toBe(1);
    expect(platformFetchUses('call({ fetch });')).toBe(1);
    expect(platformFetchUses('const f: typeof fetch = egress;')).toBe(0);
    expect(platformFetchUses('// fetch(u)\nconst r = egressFetch(u);')).toBe(0);
    expect(platformFetchUses('const r = await client.fetch(u);')).toBe(0);
  });

  it('flags the platform fetch outside the inventory; passes the egress fetch and listed files', () => {
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
        { code: 'const r = await fetch(url);', filename: '/r/scripts/x.ts' },
        {
          code: 'const fetch = make(); const r = await fetch(url);',
          filename: '/r/packages/voice/src/x.ts',
        },
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
        {
          code: 'const r = await fetch(url);',
          filename: '/r/server/web/lib/x.ts',
          errors: [{ messageId: 'bare' }],
        },
        {
          code: 'const f = fetch;',
          filename: '/r/server/api/src/x.ts',
          errors: [{ messageId: 'bare' }],
        },
        {
          code: "const f = globalThis['fetch'];",
          filename: '/r/packages/voice/src/x.ts',
          errors: [{ messageId: 'bare' }],
        },
        {
          code: 'const f = window.fetch;',
          filename: '/r/server/web/components/x.tsx',
          errors: [{ messageId: 'bare' }],
        },
        {
          code: 'const t = new Transport(u, { fetch });',
          filename: '/r/packages/tools/src/x.ts',
          errors: [{ messageId: 'bare' }],
        },
      ],
    });
  });
});
