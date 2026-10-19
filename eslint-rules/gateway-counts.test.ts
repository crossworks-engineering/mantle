import { describe, expect, it } from 'vitest';
import { stripComments } from './arch-counts.mjs';
import {
  GATEWAY_MAX_LINES,
  gatewayCounts,
  gatewayCycleModules,
  globalKeySites,
} from './gateway-counts.mjs';

const f = (path: string, text: string) => ({ path, text });

/** As the scoreboard passes them: its comment stripper and the package's
 *  exports (a part of packages/db/package.json's). */
const opts = {
  strip: stripComments,
  exports: {
    '.': './src/index.ts',
    './client': './src/client.ts',
    './viewer': './src/viewer.ts',
  },
};

describe('gateway-counts', () => {
  it('a layered gateway has no cycle', () => {
    const files = [
      f(
        'packages/db/src/client.ts',
        "import { a } from './gateway/pools';\nexport { b } from './gateway/b';\n",
      ),
      f(
        'packages/db/src/gateway/pools.ts',
        "import { b } from './b';\nimport { x } from '../actor';\n",
      ),
      f('packages/db/src/gateway/b.ts', "import type postgres from 'postgres';\n"),
      f('packages/db/src/actor.ts', ''),
    ];
    expect(gatewayCycleModules(files, opts)).toEqual([]);
  });

  it('finds a cycle through client.ts, a type import and a re-export', () => {
    const files = [
      f('packages/db/src/client.ts', "export { p } from './gateway/pools';\n"),
      f('packages/db/src/gateway/pools.ts', "import { b } from './b';\n"),
      f('packages/db/src/gateway/b.ts', "import type { Db } from '../client';\n"),
      f('packages/db/src/gateway/c.ts', "import { p } from './pools';\n"),
    ];
    expect(gatewayCycleModules(files, opts)).toEqual([
      'packages/db/src/gateway/b.ts',
      'packages/db/src/gateway/pools.ts',
    ]);
  });

  it('finds a cycle through another file of packages/db/src', () => {
    const files = [
      f('packages/db/src/gateway/a.ts', "import { v } from '../viewer';\n"),
      f('packages/db/src/viewer.ts', "import { a } from './gateway/a';\n"),
    ];
    expect(gatewayCycleModules(files, opts)).toEqual(['packages/db/src/gateway/a.ts']);
  });

  it('reads a .js specifier as its .ts file', () => {
    const files = [
      f('packages/db/src/client.ts', "import { a } from './gateway/a.js';\n"),
      f('packages/db/src/gateway/a.ts', "import { c } from '../client.js';\n"),
    ];
    expect(gatewayCycleModules(files, opts)).toEqual(['packages/db/src/gateway/a.ts']);
  });

  it("resolves the package's own name through its exports", () => {
    for (const spec of ['@mantle/db', '@mantle/db/client', '@mantle/db/viewer']) {
      const files = [
        f('packages/db/src/index.ts', "export * from './client';\n"),
        f('packages/db/src/client.ts', "import { a } from './gateway/a';\n"),
        f('packages/db/src/viewer.ts', "import { a } from './gateway/a';\n"),
        f('packages/db/src/gateway/a.ts', `import { x } from '${spec}';\n`),
      ];
      expect(gatewayCycleModules(files, opts), spec).toEqual(['packages/db/src/gateway/a.ts']);
    }
    // A subpath the exports do not name resolves to nothing.
    const none = [
      f('packages/db/src/client.ts', "import { a } from './gateway/a';\n"),
      f('packages/db/src/gateway/a.ts', "import { x } from '@mantle/db/nowhere';\n"),
    ];
    expect(gatewayCycleModules(none, opts)).toEqual([]);
  });

  it('reads an import whose braces hold a comment, and not one in a comment', () => {
    const files = [
      f('packages/db/src/client.ts', "import { a } from './gateway/a';\n"),
      f(
        'packages/db/src/gateway/a.ts',
        "import {\n  x, // the client's x\n  /* and y */ y,\n} from '../client';\n",
      ),
    ];
    expect(gatewayCycleModules(files, opts)).toEqual(['packages/db/src/gateway/a.ts']);
    const commented = [
      f('packages/db/src/client.ts', "import { a } from './gateway/a';\n"),
      f('packages/db/src/gateway/a.ts', "// import { x } from '../client';\n"),
    ];
    expect(gatewayCycleModules(commented, opts)).toEqual([]);
  });

  it('pins the limit, and the longest module when one is over it', () => {
    const short = f('packages/db/src/gateway/a.ts', 'x\n'.repeat(10));
    expect(gatewayCounts([short], opts).numbers).toEqual({
      dbGatewayMaxLines: GATEWAY_MAX_LINES,
      dbGatewayImportCycles: 0,
      dbGlobalKeyWrites: 0,
      dbGlobalKeyReads: 0,
    });
    const long = f('packages/db/src/gateway/b.ts', 'x\n'.repeat(GATEWAY_MAX_LINES + 5));
    const r = gatewayCounts([short, long], opts);
    expect(r.numbers.dbGatewayMaxLines).toBe(GATEWAY_MAX_LINES + 5);
    expect(r.detail.overLimit).toEqual([`packages/db/src/gateway/b.ts: ${GATEWAY_MAX_LINES + 5}`]);
  });

  it('counts the global keys written or read outside pools.ts', () => {
    const files = [
      f(
        'packages/db/src/gateway/pools.ts',
        'globalThis.__mantleSql = sql;\nconst p = (globalThis.__mantleViewerDbs ??= new Map());\n',
      ),
      f(
        'packages/db/src/client.ts',
        [
          'globalThis.__mantleDb = undefined;',
          '(globalThis as { __mantleX?: number }).__mantleX ||= 1;',
          'delete globalThis.__mantleTurnDb;',
          'const open = globalThis.__mantleSql === base;',
          '// globalThis.__mantleSql = commented;',
        ].join('\n'),
      ),
      f('server/web/lib/realtime.ts', 'globalThis.__mantleRealtime = r;\n'),
    ];
    expect(globalKeySites(files, opts)).toEqual({
      writes: [
        'packages/db/src/client.ts:1 __mantleDb',
        'packages/db/src/client.ts:2 __mantleX',
        'packages/db/src/client.ts:3 __mantleTurnDb',
      ],
      reads: ['packages/db/src/client.ts:4 __mantleSql'],
    });
  });
});
