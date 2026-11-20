/**
 * name-versions-clear on a real, migrated Postgres
 * (lib/maintenance/name-versions-clear.ts): every file the removed name pass
 * marked (reason 'version', superseded by a file in the same folder) gets its
 * mark cleared and salience 1; a 'version' mark of another shape (to a file
 * in another folder, to a page: one set by hand), a 'corrected' or
 * 'migrated' file, a node that is not a file, and an unmarked file are left
 * as they are, and the dry run counts both kinds. The clear keeps updated_at (no edit of the
 * file: a moved stamp would queue a skipped file for a paid read). A second
 * run clears none. A scratch database,
 * dropped after (the clear is box-wide).
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/web/lib/maintenance/name-versions-clear.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = {
  id: string;
  salience: number;
  by: string | null;
  reason: string | null;
  at: string;
};

describe.skipIf(!URL)('name-versions-clear', () => {
  let m: typeof import('@mantle/db');
  let clear: typeof import('./name-versions-clear');
  let scratch: { url: string; drop: () => Promise<void> } | undefined;
  let anchor = '';
  const id = {
    dir: randomUUID(), // the folder the old pass grouped in
    head: randomUUID(), // the newest "version": never marked
    sheet2: randomUUID(), // marked 'version' under the head
    sheet3: randomUUID(), // marked 'version', salience already 1
    corrected: randomUUID(), // a person's correction
    migrated: randomUUID(), // made into a page
    rule: randomUUID(), // not a file: a learned rule (journal) retired as a 'version'
    elsewhere: randomUUID(), // 'version' to a file in another folder: by hand
    page: randomUUID(), // a page a person named the newer version
    byHand: randomUUID(), // 'version' to that page: by hand
  };
  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const su = async (q: ReturnType<typeof sql>) =>
    (await import('@mantle/db/test-support')).superuserExec(scratch!.url, q);

  beforeAll(async () => {
    scratch = await (await import('@mantle/db/test-support')).createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    m = await import('@mantle/db');
    clear = await import('./name-versions-clear');
    const admin = (m.systemDb as unknown as { $client: Parameters<typeof ensureTestAnchor>[0] })
      .$client;
    anchor = await ensureTestAnchor(admin);
    const node = (
      nid: string,
      type: string,
      title: string,
      mark: { by?: string; reason?: string; salience?: number; parent?: string | null } = {},
    ) =>
      su(sql`insert into nodes (id, owner_id, type, title, path, salience,
                                superseded_by, superseded_reason, parent_id)
             values (${nid}, ${anchor}, ${type}, ${title}, 'files',
                     ${mark.salience ?? 1}, ${mark.by ?? null}, ${mark.reason ?? null},
                     ${mark.parent === undefined ? id.dir : mark.parent})`);
    await node(id.dir, 'branch', 'drawings', { parent: null });
    await node(id.head, 'file', '12-62-29-sht-01.dwg');
    await node(id.sheet2, 'file', '12-62-29-sht-02.dwg', {
      by: id.head,
      reason: 'version',
      salience: 0.5,
    });
    await node(id.sheet3, 'file', '12-62-29-sht-03.dwg', { by: id.head, reason: 'version' });
    await node(id.elsewhere, 'file', 'spec-rev-a.pdf', {
      by: id.head,
      reason: 'version',
      salience: 0.5,
      parent: null,
    });
    await node(id.page, 'page', 'spec rev B');
    await node(id.byHand, 'file', 'spec-rev-b.pdf', {
      by: id.page,
      reason: 'version',
      salience: 0.5,
    });
    await node(id.corrected, 'file', 'old-spec.pdf', {
      by: id.head,
      reason: 'corrected',
      salience: 0.25,
    });
    await node(id.migrated, 'file', 'notes.md', { by: id.head, reason: 'migrated', salience: 0.5 });
    await node(id.rule, 'journal', 'a learned rule', {
      by: id.head,
      reason: 'version',
      salience: 0.5,
    });
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  const rows = async () =>
    Object.fromEntries(
      (
        await x<Row>(sql`select id, salience, superseded_by as by, superseded_reason as reason,
                                updated_at::text as at
                           from nodes where owner_id = ${anchor}::uuid`)
      ).map((r) => [r.id, r]),
    );

  it('counts the marked files, then clears exactly them', async () => {
    const before = await rows();
    expect(await clear.countNameVersionMarks()).toEqual({ toClear: 2, left: 2 });
    expect(await clear.clearNameVersionMarks()).toBe(2);
    const r = await rows();
    // No edit of the file: every updated_at is the one it had.
    for (const k of Object.values(id)) expect(r[k]?.at, k).toBe(before[k]?.at);
    for (const k of [id.sheet2, id.sheet3, id.head]) {
      expect(r[k], k).toMatchObject({ salience: 1, by: null, reason: null });
    }
    expect(r[id.corrected]).toMatchObject({ salience: 0.25, by: id.head, reason: 'corrected' });
    expect(r[id.migrated]).toMatchObject({ salience: 0.5, by: id.head, reason: 'migrated' });
    expect(r[id.rule]).toMatchObject({ salience: 0.5, by: id.head, reason: 'version' });
    // A 'version' mark of another shape is a person's: left.
    expect(r[id.elsewhere]).toMatchObject({ salience: 0.5, by: id.head, reason: 'version' });
    expect(r[id.byHand]).toMatchObject({ salience: 0.5, by: id.page, reason: 'version' });
  });

  it('a second run clears none', async () => {
    expect(await clear.countNameVersionMarks()).toEqual({ toClear: 0, left: 2 });
    expect(await clear.clearNameVersionMarks()).toBe(0);
  });
});
