/**
 * circuit_trace on a real migrated Postgres: a workspace scope traces only
 * the DWG tables it reads (row level security on nodes, the table_sql
 * surface), the brain's own work reads both. Two made-up sheets of one
 * made-up circuit; one is granted to the test's workspace, one is not.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/builtins-circuits.viewer.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureTestAnchor, superuserExec } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const CIRCUIT = `90000-${randomUUID().slice(0, 4)}-01`;

describe.skipIf(!URL)('circuit_trace never reads a table the caller cannot', () => {
  type Db = typeof import('@mantle/db');
  type Content = typeof import('@mantle/content');
  let m: Db;
  let c: Content;
  let sqlTag: typeof import('drizzle-orm').sql;
  const tag = `ctrace-${randomUUID().slice(0, 8)}`;
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-ctrace-'));
  let anchor: string;
  const ids: string[] = [];
  const wsId = randomUUID();

  const sheet = async (title: string, x0: number) => {
    const layer = `Circuit ${CIRCUIT}`;
    const grid = (name: string, cols: [string, 'text' | 'number'][], rows: unknown[][]) => ({
      ...c.tableDocFromGrid({
        columns: cols.map(([n, type]) => ({ name: n, type })),
        rows: rows as (string | number)[][],
      }),
      name,
    });
    const t = await c.createTable(anchor, {
      title,
      tags: ['auto-import'],
      sourceFileId: randomUUID(),
      description:
        'AutoCAD DWG model-space registry. Circuits ... within 5 drawing units of it ... (test)',
      tabs: [
        grid(
          'Layers',
          [
            ['Layer', 'text'],
            ['Entities', 'number'],
          ],
          [[layer, 1]],
        ),
        grid(
          'Segments',
          [
            ['Layer', 'text'],
            ['Handle', 'text'],
            ['X1', 'number'],
            ['Y1', 'number'],
            ['X2', 'number'],
            ['Y2', 'number'],
            ['Length', 'number'],
            ['Node 1', 'number'],
            ['Node 2', 'number'],
          ],
          [[layer, `H${x0}`, x0, 0, x0 + 10, 0, 10, 1, 2]],
        ),
        grid(
          'Nodes',
          [
            ['Node', 'number'],
            ['X', 'number'],
            ['Y', 'number'],
            ['Degree', 'number'],
            ['Kind', 'text'],
            ['Block', 'text'],
            ['Block handle', 'text'],
            ['Layers', 'text'],
          ],
          [
            [1, x0, 0, 1, 'end', '', '', layer],
            [2, x0 + 10, 0, 1, 'end', '', '', layer],
          ],
        ),
      ],
    });
    ids.push(t.id);
    return t.id;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.TABLE_DB_DIR = path.join(root, 'table-dbs');
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    m = await import('@mantle/db');
    c = await import('@mantle/content');
    sqlTag = (await import('drizzle-orm')).sql;
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    anchor = await ensureTestAnchor(admin);
    const granted = await sheet(`${tag} PID-OPEN`, 0);
    await sheet(`${tag} PID-HIDDEN`, 100);
    await superuserExec(
      URL!,
      sqlTag`insert into workspaces (id, owner_id, name) values (${wsId}, ${anchor}, ${`${tag} ws`})`,
    );
    await m.withHeads([granted], 'update', (tx) =>
      tx.execute(
        sqlTag`insert into item_grants (node_id, workspace_id) values (${granted}, ${wsId})`,
      ),
    );
  }, 60_000);

  afterAll(async () => {
    for (const id of ids) {
      await m.systemDb.execute(sqlTag`delete from item_grants where node_id = ${id}`);
      await m.systemDb.execute(sqlTag`delete from nodes where id = ${id}`);
    }
    await superuserExec(URL!, sqlTag`delete from workspaces where id = ${wsId}`);
    await m.closeDb();
    rmSync(root, { recursive: true, force: true });
  });

  it('the brain reads both sheets; the workspace scope only its own', async () => {
    const { circuitTraceHandler } = await import('./builtins-circuits');
    // Other test files' DWG tables share this brain (another TABLE_DB_DIR,
    // so their workbooks do not open here): those are skipped and named in
    // limits, and only this file's own sheets, by its random circuit and
    // tag, are asserted on.
    const all = await circuitTraceHandler({ circuit: CIRCUIT }, anchor);
    expect(all.ok).toBe(true);
    const allOut = (all as { output: { sheets: { title: string }[] } }).output;
    expect(allOut.sheets.map((x) => x.title).sort()).toEqual(
      [`${tag} PID-HIDDEN`, `${tag} PID-OPEN`].sort(),
    );

    const scoped = await m.withScope(
      { kind: 'assistant', loginId: null, ws: [wsId], modWs: [] },
      () => circuitTraceHandler({ circuit: CIRCUIT }, anchor),
    );
    expect(scoped.ok).toBe(true);
    const text = JSON.stringify((scoped as { output: unknown }).output);
    expect(text).toContain('PID-OPEN');
    expect(text).not.toContain('PID-HIDDEN');
    expect(text).not.toContain(ids[1]!);
    expect(text).not.toContain('H100');
  });
});
