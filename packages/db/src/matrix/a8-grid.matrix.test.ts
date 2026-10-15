/**
 * The A8 grid at SQL level (workspaces arch plan v2, section 12 A8): 6
 * logins (and the actor kinds that answer none) x every workspace kind x 3
 * placements (in a folder, not in one, a snapshot copy) x 13 actions x every
 * actor kind, against the oracle written from the guide (./guide-oracle.ts).
 * The fixture and one cell's run: ./test-support/a8-grid.ts.
 *
 * Each cell is one transaction, rolled back. A cell passes only on the right
 * row effect; a cell the oracle does not cover is counted and named, and a
 * 500 or a generic error is a failure, never a deny. Cells that fail today
 * and are the owner's to decide are listed in KNOWN_FAILURES by name: the
 * test fails on any other failure, and on a known one that passes (so the
 * list only shrinks).
 *
 * The workers: the cells split by kind over MANTLE_MATRIX_WORKERS (default
 * 4) workers, each on its own system and write-role connection, over one
 * fixture seeded once. `pnpm test:matrix`; the summary prints the counts.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test:matrix
 */
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ITEM_KINDS, ITEM_KIND_NAMES } from '@mantle/client-types/kinds';
import { ACCEPTED_KINDS } from '@mantle/client-types/kind-lists';
import { createMigratedScratchDatabase } from '../test-support';
import { viewerDatabaseUrl, viewerRolePassword } from '../viewer';
import {
  a8Cells,
  answerOf,
  buildA8Fixture,
  cellName,
  installProbe,
  runA8Cell,
  type A8Cell,
  type A8Fixture,
} from './test-support/a8-grid';
import { GUIDE_SNAPSHOT_KINDS, GUIDE_WORKSPACE_KINDS } from './guide-oracle';
import { KNOWN_FAILURES } from './a8-known-failures';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const WORKERS = Math.max(1, Number(process.env.MANTLE_MATRIX_WORKERS ?? '4') || 4);

describe.skipIf(!URL)('A8 grid at SQL level', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let sql: ReturnType<typeof postgres>;
  let fx: A8Fixture;
  const pools: ReturnType<typeof postgres>[] = [];
  const testKey = process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';
  /** Actor misses the item tables' write triggers reported. */
  const misses: string[] = [];
  const onnotice = (n: { message?: string }) => {
    if (String(n.message ?? '').startsWith('mantle actor miss: ')) misses.push(String(n.message));
  };

  const kinds = ITEM_KIND_NAMES.filter((t) => ITEM_KINDS[t].class === 'workspace');
  const rootOf = (kind: string): string => {
    if (kind === 'branch') return 'notes';
    const tree = (ITEM_KINDS as Record<string, { tree: { root: string } | null }>)[kind]!.tree;
    if (!tree) throw new Error(`no tree root for ${kind}`);
    return tree.root;
  };

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice });
    fx = await buildA8Fixture(sql, kinds, rootOf);
    await installProbe(sql);
    // Both checks on, as a box that runs them (the test's own scratch
    // database; no switch in production code).
    await sql`select mantle_set_edit_check('on')`;
    await sql`select mantle_set_actor_check('on')`;
    misses.length = 0;
  }, 300_000);

  afterAll(async () => {
    for (const p of pools) await p.end();
    await sql?.end();
    await scratch?.drop();
  });

  it("the registry's workspace class and accepted kinds are the guide's lists", () => {
    expect([...kinds].sort()).toEqual([...GUIDE_WORKSPACE_KINDS].sort());
    expect([...ACCEPTED_KINDS].sort()).toEqual([...GUIDE_SNAPSHOT_KINDS].sort());
  });

  it('the fixture: each item is homed and granted as the oracle says', async () => {
    for (const kind of kinds) {
      for (const placement of ['root', 'folder', 'snapshot'] as const) {
        const item = fx.items[kind]![placement];
        if (!item) continue;
        const [r] = await sql<{ home: string; read: string[]; write: string[]; copy: boolean }[]>`
          select home_ws::text as home, read_ws::text[] as read, write_ws::text[] as write,
                 data ? 'snapshot_of' as copy
            from nodes where id = ${item.id}`;
        if (placement === 'snapshot') {
          expect(r!.home, kind).toBe(fx.privateWs.writeGrant);
          expect(r!.read, kind).toEqual([fx.privateWs.writeGrant]);
          expect(r!.copy, kind).toBe(true);
        } else {
          expect(r!.home, kind).toBe(fx.ws.H);
          expect([...r!.read].sort(), kind).toEqual([fx.ws.H, fx.ws.W, fx.ws.R].sort());
          expect(r!.write, kind).toContain(fx.ws.W);
          expect(r!.write, kind).not.toContain(fx.ws.R);
        }
      }
    }
  });

  it('every cell matches the oracle (row effects; a 500 or a generic error fails)', async () => {
    const started = Date.now();
    const cells = a8Cells(kinds);
    const na: Record<string, number> = {};
    const run: A8Cell[] = [];
    let allowed = 0;
    let denied = 0;
    for (const c of cells) {
      const want = answerOf(c);
      if ('na' in want) na[want.na] = (na[want.na] ?? 0) + 1;
      else {
        run.push(c);
        if (want.allow) allowed++;
        else denied++;
      }
    }
    // Split by kind: a worker holds the heads of its own kinds' items only.
    const lanes: A8Cell[][] = Array.from({ length: WORKERS }, () => []);
    kinds.forEach((kind, i) => lanes[i % WORKERS]!.push(...run.filter((c) => c.kind === kind)));
    const failures = new Map<string, string>();
    await Promise.all(
      lanes.map(async (lane) => {
        const sys = postgres(scratch!.url, { max: 1, prepare: false, onnotice });
        const w = postgres(
          viewerDatabaseUrl(scratch!.url, 'write', viewerRolePassword(testKey, 'write')),
          { max: 1, prepare: false, onnotice },
        );
        pools.push(sys, w);
        for (const c of lane) {
          const r = await runA8Cell({ sys, w }, fx, c);
          if (r) failures.set(cellName(c), r);
        }
      }),
    );
    // The grid's own names (a surface cell's name starts with its surface).
    const known = new Set(
      Object.keys(KNOWN_FAILURES).filter((n) => n.split(' ')[0]!.includes('/')),
    );
    const unexpected = [...failures].filter(([n]) => !known.has(n)).map(([n, r]) => `${n}: ${r}`);
    const fixed = [...known].filter((n) => !failures.has(n));
    const naTotal = Object.values(na).reduce((a, b) => a + b, 0);
    console.log(
      [
        `A8 grid: ${cells.length} cells in ${((Date.now() - started) / 1000).toFixed(1)} s ` +
          `(${WORKERS} workers): ${run.length} run (${allowed} allow, ${denied} deny), ` +
          `${run.length - failures.size} pass, ${failures.size} fail ` +
          `(${failures.size - unexpected.length} known), ${naTotal} not applicable`,
        ...Object.entries(na).map(([why, n]) => `  n/a ${n}: ${why}`),
        ...[...failures].map(([n, r]) => `  FAIL ${n}: ${r}`),
      ].join('\n'),
    );
    expect(unexpected, 'cells that fail and are not known failures').toEqual([]);
    expect(fixed, 'known failures that pass now: take them off the list').toEqual([]);
    // Every write ran with its actor and both checks on: no miss.
    expect(misses).toEqual([]);
    expect(naTotal + run.length).toBe(cells.length);
  }, 600_000);
});
