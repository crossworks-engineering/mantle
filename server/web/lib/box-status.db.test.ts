/**
 * box_status's collector (lib/box-status.ts) on a real migrated Postgres:
 * one collection is schema 1, holds only numbers, booleans, null and the
 * safe one-word strings (no table, host, agent, model or user name), names
 * only our own probes in `degraded`, and is served from its 30 second cache
 * to the next caller. The services a test box lacks (the parser, the
 * browser, the object store) report down or unknown, never fail the whole.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/box-status.db.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** Every leaf of a value. */
function leaves(v: unknown, out: unknown[] = []): unknown[] {
  if (v !== null && typeof v === 'object') {
    for (const x of Object.values(v as Record<string, unknown>)) leaves(x, out);
  } else out.push(v);
  return out;
}

/** Our probes' fixed names (system-health.ts and box-status.ts). */
const PROBES = new Set([
  'host.cpu',
  'host.mem',
  'host.disk',
  'host.proc',
  'postgres',
  'storage.attachments',
  'storage.objectstore',
  'parser',
  'browser',
  'documents',
  'embedder',
  'network',
  'sandboxes',
  'spend',
  'capacity',
  'extraction',
  'logins',
]);

describe.skipIf(!URL)('box_status: the collector', () => {
  let m: typeof import('@mantle/db');
  let anchor = '';

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    const sql = (m.systemDb as unknown as { $client: Parameters<typeof ensureTestAnchor>[0] })
      .$client;
    anchor = await ensureTestAnchor(sql);
  }, 120_000);

  afterAll(async () => {
    await m.closeDb();
  });

  it('one collection: schema 1, numbers only, our probe names only', async () => {
    const { collectBoxStatus } = await import('./box-status');
    const s = await m.runAsSystem('test:box-status', () => collectBoxStatus(anchor));
    expect(s.schema).toBe(1);
    expect(s.postgres.up).toBe(true);
    expect(s.postgres.dbSizeBytes).toBeGreaterThan(0);
    expect(s.logins?.total).toBeGreaterThanOrEqual(1);
    expect(s.spend?.last24hMicroUsd).toBeGreaterThanOrEqual(0);
    expect(['green', 'watch', 'split']).toContain(s.capacity?.zone);
    expect(s.host.loadAvg).toHaveLength(3);
    for (const name of s.degraded) expect(PROBES.has(name), name).toBe(true);
    for (const leaf of leaves(s)) {
      expect(
        leaf === null ||
          typeof leaf === 'number' ||
          typeof leaf === 'boolean' ||
          (typeof leaf === 'string' && /^[A-Za-z0-9_.:+-]{0,64}$/.test(leaf)),
        String(leaf),
      ).toBe(true);
    }
  }, 60_000);

  it('serves the next caller from the cache', async () => {
    const { boxStatus } = await import('./box-status');
    const a = await m.runAsSystem('test:box-status', () => boxStatus(anchor));
    const b = await m.runAsSystem('test:box-status', () => boxStatus(anchor));
    expect(b).toBe(a);
  }, 60_000);
});
