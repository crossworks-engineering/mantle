import { describe, expect, it } from 'vitest';
import { GATEWAY_MAX_LINES, gatewayCounts, gatewayCycleModules } from './gateway-counts.mjs';

const f = (path: string, text: string) => ({ path, text });

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
    expect(gatewayCycleModules(files)).toEqual([]);
  });

  it('finds a cycle through client.ts, a type import and a re-export', () => {
    const files = [
      f('packages/db/src/client.ts', "export { p } from './gateway/pools';\n"),
      f('packages/db/src/gateway/pools.ts', "import { b } from './b';\n"),
      f('packages/db/src/gateway/b.ts', "import type { Db } from '../client';\n"),
      f('packages/db/src/gateway/c.ts', "import { p } from './pools';\n"),
    ];
    expect(gatewayCycleModules(files)).toEqual([
      'packages/db/src/gateway/b.ts',
      'packages/db/src/gateway/pools.ts',
    ]);
  });

  it('finds a cycle through another file of packages/db/src', () => {
    const files = [
      f('packages/db/src/gateway/a.ts', "import { v } from '../viewer';\n"),
      f('packages/db/src/viewer.ts', "import { a } from './gateway/a';\n"),
    ];
    expect(gatewayCycleModules(files)).toEqual(['packages/db/src/gateway/a.ts']);
  });

  it('pins the limit, and the longest module when one is over it', () => {
    const short = f('packages/db/src/gateway/a.ts', 'x\n'.repeat(10));
    expect(gatewayCounts([short]).numbers).toEqual({
      dbGatewayMaxLines: GATEWAY_MAX_LINES,
      dbGatewayImportCycles: 0,
    });
    const long = f('packages/db/src/gateway/b.ts', 'x\n'.repeat(GATEWAY_MAX_LINES + 5));
    const r = gatewayCounts([short, long]);
    expect(r.numbers.dbGatewayMaxLines).toBe(GATEWAY_MAX_LINES + 5);
    expect(r.detail.overLimit).toEqual([`packages/db/src/gateway/b.ts: ${GATEWAY_MAX_LINES + 5}`]);
  });
});
