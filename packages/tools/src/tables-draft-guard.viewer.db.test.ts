/**
 * The table tools' draft guard on a real migrated Postgres (audit T1, the
 * tool half of the d549fa73 fix): below admin, windowFile answers the
 * PUBLISHED workbook, never the admin's unsaved draft.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/tables-draft-guard.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('table tools never read a draft below admin', () => {
  type Db = typeof import('@mantle/db');
  type Content = typeof import('@mantle/content');
  type Common = typeof import('./tables/common');
  let m: Db;
  let c: Content;
  let common: Common;
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = `tdguard-${randomUUID().slice(0, 8)}`;
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-tdguard-'));
  let anchor: string;
  let madeAnchor = false;
  let tableId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.TABLE_DB_DIR = path.join(root, 'table-dbs');
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    m = await import('@mantle/db');
    c = await import('@mantle/content');
    common = await import('./tables/common');
    sqlTag = (await import('drizzle-orm')).sql;
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    const found = (
      (await m.systemDb.execute(sqlTag`select mantle_brain_id() as id`)) as unknown as {
        id: string | null;
      }[]
    )[0]?.id;
    if (found) anchor = found;
    else {
      anchor = randomUUID();
      madeAnchor = true;
      await m.systemDb.execute(sqlTag`
        insert into auth.users (id, email, password_hash, is_owner)
        values (${anchor}, ${`${tag}-owner@example.invalid`}, 'x', true)`);
    }
    const col = randomUUID();
    const t = await c.createTable(anchor, {
      title: `${tag} grid`,
      data: {
        columns: [{ id: col, name: 'Name', type: 'text' }],
        rows: [{ id: randomUUID(), cells: { [col]: 'published row' } }],
      },
    });
    tableId = t.id;
    // The Library: a team-level agent may read this table.
    await m.systemDb.execute(sqlTag`update nodes set audience = 'team' where id = ${tableId}`);
    // The admin's unsaved edit: a draft workbook next to the published one.
    const applied = await c.applyTableOps(anchor, tableId, [
      { op: 'row_add', cells: { [col]: 'admin draft secret' } },
    ]);
    expect(applied?.ok).toBe(true);
  });

  afterAll(async () => {
    await m.systemDb.execute(sqlTag`delete from nodes where id = ${tableId}`);
    if (madeAnchor) {
      await m.systemDb.execute(sqlTag`delete from spaces where id = ${anchor}`);
      await m.systemDb.execute(sqlTag`delete from auth.users where id = ${anchor}`);
    }
    await m.closeDb();
    rmSync(root, { recursive: true, force: true });
  });

  it('admin reads the draft; the team level reads the published file only', async () => {
    const { readDocClipped } = await import('@mantle/tabledb');
    const text = (abs: string | null) => JSON.stringify(abs ? readDocClipped(abs, 100).doc : null);

    const adminFile = await common.windowFile(anchor, tableId);
    expect(adminFile).toMatch(/\.draft\.sqlite$/);
    expect(text(adminFile)).toContain('admin draft secret');

    const teamFile = await m.withViewer('team', () => common.windowFile(anchor, tableId));
    expect(teamFile).not.toBeNull();
    expect(teamFile).not.toMatch(/\.draft\.sqlite$/);
    expect(text(teamFile)).toContain('published row');
    expect(text(teamFile)).not.toContain('admin draft secret');
  });
});
