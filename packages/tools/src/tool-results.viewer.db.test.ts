/**
 * Spilled tool results carry the level they were written at (client logins
 * audit A27, migration 0189): read_result refuses a spill its reader's level
 * does not cover. An admin turn's spill is never paged back from a client or
 * public turn; a client turn's spill never from a public one (siblings); a
 * team reader covers client and public spills; the admin pool reads all.
 * On a real, migrated Postgres; seeds its own spills on a random owner id
 * and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/tool-results.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('read_result spills carry their level', () => {
  type Db = typeof import('@mantle/db');
  type Admin = Parameters<Db['ensureViewerRoles']>[0];
  let m: Db;
  let tr: typeof import('./tool-results');
  const owner = randomUUID();
  const handles: Record<string, string> = {};
  const LEVELS = ['admin', 'team', 'client', 'public'] as const;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    tr = await import('./tool-results');
    const admin = (m.systemDb as unknown as { $client: Admin }).$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    for (const l of LEVELS) {
      const spill = () =>
        tr.spillToolResult({
          ownerId: owner,
          traceId: null,
          toolSlug: 'search_nodes',
          content: `written at ${l}`,
        });
      handles[l] = (l === 'admin' ? await spill() : await m.withViewer(l, spill)).handle;
    }
  }, 60_000);

  afterAll(async () => {
    const admin = (m.systemDb as unknown as { $client: Admin }).$client;
    await admin`delete from tool_results where owner_id = ${owner}`;
    await m.closeDb();
  });

  const read = async (reader: (typeof LEVELS)[number], written: (typeof LEVELS)[number]) => {
    const page = () => tr.readResultPage(owner, handles[written]!, 1, 1000);
    const res = reader === 'admin' ? await page() : await m.withViewer(reader, page);
    return res.ok ? res.text : null;
  };

  it('records the writer level (null at admin)', async () => {
    const admin = (m.systemDb as unknown as { $client: Admin }).$client;
    const rows = await admin<{ id: string; viewer_level: string | null }[]>`
      select id, viewer_level from tool_results where owner_id = ${owner}`;
    const by = new Map(rows.map((r) => [r.id, r.viewer_level]));
    expect(LEVELS.map((l) => by.get(handles[l]!))).toEqual([null, 'team', 'client', 'public']);
  });

  it('a reader gets only the spills its level covers', async () => {
    const got: Record<string, (string | null)[]> = {};
    for (const reader of LEVELS) {
      got[reader] = [];
      for (const written of LEVELS) got[reader]!.push(await read(reader, written));
    }
    const text = (l: string) => `written at ${l}`;
    expect(got).toEqual({
      admin: LEVELS.map(text),
      team: [null, text('team'), text('client'), text('public')],
      client: [null, null, text('client'), null],
      public: [null, null, null, text('public')],
    });
  });

  it('grep and query refuse the same way', async () => {
    const g = await m.withViewer('client', () => tr.grepResult(owner, handles.admin!, 'written'));
    expect(g).toMatchObject({ ok: false });
  });
});
