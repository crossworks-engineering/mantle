/**
 * Spilled tool results outside a workspace scope (client logins audit A27,
 * migration 0189; workspaces W8c). The level readers are gone: outside a
 * workspace scope the code is system work, which writes no level and reads
 * every spill, whatever level an older row still records. A bound reader
 * still reads only its own trace's spill. A workspace turn's spills are
 * read through the workspace role's rule (the turn-scope tests).
 * On a real, migrated Postgres; seeds its own spills on a random owner id
 * and removes them.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/tool-results.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('read_result spills outside a workspace scope', () => {
  type Db = typeof import('@mantle/db');
  type Admin = Parameters<Db['ensureViewerRoles']>[0];
  let m: Db;
  let admin: Admin;
  let tr: typeof import('./tool-results');
  const owner = randomUUID();
  const handles: Record<string, string> = {};
  const LEVELS = ['admin', 'team', 'client', 'public'] as const;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    tr = await import('./tool-results');
    admin = (m.systemDb as unknown as { $client: Admin }).$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    for (const l of LEVELS) {
      handles[l] = (
        await tr.spillToolResult({
          ownerId: owner,
          traceId: null,
          toolSlug: 'search_nodes',
          content: `written at ${l}`,
        })
      ).handle;
    }
    // Rows written by a level reader before W8c keep their frozen level.
    for (const l of LEVELS.filter((x) => x !== 'admin')) {
      await admin`update tool_results set viewer_level = ${l} where id = ${handles[l]!}`;
    }
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from tool_results where owner_id = ${owner}`;
    await m.closeDb();
  });

  it('system work records no level', async () => {
    const { handle } = await tr.spillToolResult({
      ownerId: owner,
      traceId: null,
      toolSlug: 'search_nodes',
      content: 'system',
    });
    const [row] = await admin<{ viewer_level: string | null }[]>`
      select viewer_level from tool_results where id = ${handle}`;
    expect(row?.viewer_level).toBeNull();
  });

  it('system work reads every spill, whatever level an older row records', async () => {
    const got: (string | null)[] = [];
    for (const l of LEVELS) {
      const res = await tr.readResultPage(owner, handles[l]!, 1, 1000);
      got.push(res.ok ? res.text : null);
    }
    expect(got).toEqual(LEVELS.map((l) => `written at ${l}`));
  });

  it("a bound reader (a member turn) reads only its own trace's spill", async () => {
    const turnA = randomUUID();
    const turnB = randomUUID();
    const mine = await tr.spillToolResult({
      ownerId: owner,
      traceId: turnA,
      toolSlug: 'client_shared_open',
      content: 'turn A text',
    });
    const page = (traceId: string | null) =>
      tr.readResultPage(owner, mine.handle, 1, 1000, { traceId });
    expect(await page(turnA)).toMatchObject({ ok: true, text: 'turn A text' });
    // Another turn, and a reader with no trace: not found.
    expect(await page(turnB)).toMatchObject({ ok: false });
    expect(await page(null)).toMatchObject({ ok: false });
    expect(
      await tr.grepResult(owner, mine.handle, 'turn', undefined, { traceId: turnB }),
    ).toMatchObject({ ok: false });
    // Unbound (an owner path) reads it by handle as before.
    expect(await tr.readResultPage(owner, mine.handle, 1, 1000)).toMatchObject({ ok: true });
  });
});
