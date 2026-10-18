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
  RAW_HTTP_ALLOWED,
  rawHttpClientUses,
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
// Measured once at load, as the other scoreboard tests do: the full measure()
// takes longer than one test's time limit.
const got = measure(ROOT) as { perFile: { bareFetch: Record<string, number> } };
const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });
const ALLOWED = BARE_FETCH_ALLOWED as Record<string, { kind: string; why: string }>;
const CLIENT_ALLOWED = RAW_HTTP_ALLOWED as Record<string, { kind: string; why: string }>;

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

  it('the files that load a raw HTTP client are exactly that inventory', () => {
    const files = (countedFiles(ROOT) as string[]).filter((f) => bareFetchSwept(f));
    const using = files.filter((f) => rawHttpClientUses(readFileSync(join(ROOT, f), 'utf8')) > 0);
    expect(using.sort()).toEqual(Object.keys(CLIENT_ALLOWED).sort());
    for (const [f, e] of Object.entries(CLIENT_ALLOWED)) {
      expect(existsSync(join(ROOT, f)), f).toBe(true);
      expect(BARE_FETCH_KINDS, f).toContain(e.kind);
      expect(e.why.length, f).toBeGreaterThan(10);
    }
  });

  it('the scoreboard count over tools, calendar and content is the listed files there', () => {
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
    expect(bareFetchSwept('server/mcp/src/x.ts')).toBe(true);
    expect(bareFetchSwept('server/sandboxd/src/x.ts')).toBe(true);
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
    // Fix round 2: other global objects and other ways to reach the global.
    expect(platformFetchUses('const r = await global.fetch(u);')).toBeGreaterThan(0);
    expect(platformFetchUses('const r = await window.fetch(u);')).toBeGreaterThan(0);
    expect(platformFetchUses('const { fetch: f } = globalThis;')).toBeGreaterThan(0);
    expect(platformFetchUses("const f = Reflect.get(globalThis, 'fetch');")).toBeGreaterThan(0);
    expect(platformFetchUses('const r = await (0, globalThis).fetch(u);')).toBeGreaterThan(0);
  });

  it('counts raw HTTP client loads in text, not type-only imports or comments', () => {
    expect(rawHttpClientUses("import { fetch } from 'undici';")).toBe(1);
    expect(rawHttpClientUses("import { request } from 'undici';")).toBe(1);
    expect(rawHttpClientUses("import https from 'node:https';")).toBe(1);
    expect(rawHttpClientUses("import http from 'http';")).toBe(1);
    expect(rawHttpClientUses("import axios from 'axios';")).toBe(1);
    expect(rawHttpClientUses("import got from 'got';")).toBe(1);
    expect(rawHttpClientUses("import nodeFetch from 'node-fetch';")).toBe(1);
    expect(rawHttpClientUses("const u = require('undici');")).toBe(1);
    expect(rawHttpClientUses("const h = await import('node:https');")).toBe(1);
    expect(rawHttpClientUses("const u = load('undici');")).toBe(1);
    expect(rawHttpClientUses("import type { Agent } from 'undici';")).toBe(0);
    expect(rawHttpClientUses("type U = typeof import('undici');")).toBe(0);
    expect(rawHttpClientUses("// import http from 'node:http'")).toBe(0);
    expect(rawHttpClientUses("import net from 'node:net';")).toBe(0);
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
        // Fix round 2: other ways to reach the global fetch.
        {
          code: 'const r = await global.fetch(u);',
          filename: '/r/packages/tools/src/x.ts',
          errors: [{ messageId: 'bare' }],
        },
        {
          code: 'const { fetch: f } = globalThis;',
          filename: '/r/packages/tools/src/x.ts',
          errors: [{ messageId: 'bare' }],
        },
        {
          code: 'const { fetch } = window;',
          filename: '/r/server/web/components/x.tsx',
          errors: [{ messageId: 'bare' }],
        },
        {
          code: "let f; ({ ['fetch']: f } = self);",
          filename: '/r/packages/tools/src/x.ts',
          errors: [{ messageId: 'bare' }],
        },
        {
          code: "const f = Reflect.get(globalThis, 'fetch');",
          filename: '/r/packages/tools/src/x.ts',
          errors: [{ messageId: 'bare' }],
        },
        {
          code: 'const r = await (0, globalThis).fetch(u);',
          filename: '/r/packages/tools/src/x.ts',
          errors: [{ messageId: 'bare' }],
        },
        {
          code: 'const r = await fetch(u);',
          filename: '/r/server/mcp/src/x.ts',
          errors: [{ messageId: 'bare' }],
        },
      ],
    });
  });

  it('flags a raw HTTP client outside its inventory; passes types and listed files', () => {
    tester.run('no-bare-fetch', rule, {
      valid: [
        { code: "import type { Agent } from 'undici';", filename: '/r/packages/tools/src/x.ts' },
        {
          code: "type U = typeof import('undici');",
          filename: '/r/packages/tools/src/x.ts',
        },
        { code: "import net from 'node:net';", filename: '/r/packages/tools/src/x.ts' },
        { code: "const m = load('undici');", filename: '/r/packages/tools/src/x.ts' },
        { code: "import http from 'node:http';", filename: '/r/server/web/lib/tailscale.ts' },
        {
          code: "import http from 'node:http';",
          filename: '/r/server/sandboxd/src/docker.ts',
        },
        {
          code: "const load = createRequire(import.meta.url); const u = load('undici');",
          filename: '/r/packages/std/src/egress.ts',
        },
        { code: "import http from 'node:http';", filename: '/r/packages/tools/src/x.test.ts' },
      ],
      invalid: [
        ["import { fetch } from 'undici';", 'undici'],
        ["import { request } from 'undici'; request(u);", 'undici'],
        ["import https from 'node:https'; https.get(u);", 'node:https'],
        ["import http from 'node:http';", 'node:http'],
        ["import * as https from 'https';", 'https'],
        ["import http from 'http';", 'http'],
        ["import axios from 'axios';", 'axios'],
        ["import got from 'got';", 'got'],
        ["import nodeFetch from 'node-fetch';", 'node-fetch'],
        ["export { request } from 'undici';", 'undici'],
        ["const u = require('undici');", 'undici'],
        ["const h = await import('node:https');", 'node:https'],
        [
          "const load = process.getBuiltinModule('node:module').createRequire(import.meta.url); const u = load('undici');",
          'undici',
        ],
        [
          "import { createRequire } from 'node:module'; const r = createRequire(x); r('got');",
          'got',
        ],
      ].map(([code, mod]) => ({
        code: code!,
        filename: '/r/server/sandboxd/src/x.ts',
        errors: [{ messageId: 'client', data: { module: mod } }],
      })),
    });
  });
});
