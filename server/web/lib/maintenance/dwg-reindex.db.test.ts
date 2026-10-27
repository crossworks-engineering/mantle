/**
 * dwg-reindex on a real, migrated Postgres (lib/maintenance/dwg-reindex.ts):
 * the scope (file ids, a folder) and the cap pick exactly the DWG auto-import
 * tables named; a rebuild keeps the SAME table id, its grant and its title,
 * replaces only the tabs and the description and records the version; a
 * table edited after its import is refused, then snapshotted first with
 * keepEdits; a user's own table is never a candidate; a table carrying the
 * image check's Checks tab (an image-check commit, which the real
 * dwgTableEdited does not count as an edit) is rebuilt with that tab and
 * its rows kept, and stamped with the bytes it was rebuilt from; a row
 * circuit_verify filed (checks-store.ts, sealed) comes back from a real
 * rebuild with its seal holding and still applies. The sidecar and the
 * file bytes are stubbed (made-up drawing); no agent runs, no model is
 * reached.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/maintenance/dwg-reindex.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor, superuserExec } from '@mantle/db/test-support';

/** Runs inside the stubbed sidecar pass: a user acting while it runs. */
const midRun = vi.hoisted(() => ({ hook: null as null | (() => Promise<void>) }));

vi.mock('@mantle/files/dwg', async (orig) => ({
  ...(await orig<typeof import('@mantle/files/dwg')>()),
  cadRegistryWorkbook: async () => {
    await midRun.hook?.();
    return {
      grids: {
        sheets: [
          {
            name: 'Layers',
            columns: [{ name: 'Layer', type: 'text' }],
            rows: [['Circuit 90000-001-01']],
          },
          {
            name: 'Segments',
            columns: [
              { name: 'Layer', type: 'text' },
              { name: 'Length', type: 'number' },
            ],
            rows: [['Circuit 90000-001-01', 10]],
          },
        ],
        capped: false,
      },
      description: 'AutoCAD DWG model-space registry. Segments holds every line (rebuilt).',
    };
  },
}));
vi.mock('@mantle/files', async (orig) => ({
  ...(await orig<typeof import('@mantle/files')>()),
  readFileById: async () => ({ bytes: Buffer.from('AC1032 made-up'), row: {}, path: null }),
}));

const URL = process.env.MANTLE_TEST_DATABASE_URL;
type Row = Record<string, unknown>;

describe.skipIf(!URL)('dwg-reindex', () => {
  let m: typeof import('@mantle/db');
  let c: typeof import('@mantle/content');
  let r: typeof import('./dwg-reindex');
  let admin: (strings: TemplateStringsArray, ...v: unknown[]) => Promise<Row[]>;
  let sqlTag: typeof import('drizzle-orm').sql;
  let anchor = '';
  const tag = `dwgre${randomUUID().slice(0, 6)}`;
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-dwgre-'));
  const folder = randomUUID();
  const fileIn = randomUUID();
  const fileOut = randomUUID();
  const fileEdited = randomUUID();
  const fileChecked = randomUUID();
  const fileSealed = randomUUID();
  let tChecked = '';
  /** The made-up bytes the stubbed read returns, and their stamp. */
  const BYTES_SHA = createHash('sha256').update(Buffer.from('AC1032 made-up')).digest('hex');
  const wsId = randomUUID();
  const tableIds: string[] = [];
  let tIn = '';
  let tOut = '';
  let tEdited = '';
  let tUser = '';

  const importTable = async (fileId: string, title: string) => {
    const t = await c.createTable(anchor, {
      title,
      tags: ['auto-import'],
      sourceFileId: fileId,
      description: 'AutoCAD DWG model-space registry. (old, no geometry tabs)',
      tabs: [
        {
          ...c.tableDocFromGrid({
            columns: [{ name: 'Layer', type: 'text' }],
            rows: [['Circuit 90000-001-01']],
          }),
          name: 'Layers',
        },
      ],
    });
    tableIds.push(t.id);
    return t.id;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.TABLE_DB_DIR = path.join(root, 'table-dbs');
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    m = await import('@mantle/db');
    c = await import('@mantle/content');
    r = await import('./dwg-reindex');
    sqlTag = (await import('drizzle-orm')).sql;
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    await m.ensureViewerRoles(admin as never, process.env.MANTLE_MASTER_KEY);
    anchor = await ensureTestAnchor(admin as never);
    const fpath = `files.${tag}`;
    await admin`insert into nodes (id, owner_id, type, title, path, data) values
      (${folder}, ${anchor}, 'branch', ${tag}, ${fpath}, '{}'::jsonb)`;
    const file = (id: string, name: string, p: string) =>
      admin`insert into nodes (id, owner_id, type, title, path, data) values
        (${id}, ${anchor}, 'file', ${name}, ${p}, ${JSON.stringify({ filename: name })}::jsonb)`;
    await file(fileIn, `${tag}-in.dwg`, fpath);
    await file(fileOut, `${tag}-out.dwg`, 'files');
    await file(fileEdited, `${tag}-edited.dxf`, fpath);
    await file(fileChecked, `${tag}-checked.dwg`, 'files');
    await file(fileSealed, `${tag}-sealed.dwg`, 'files');
    tIn = await importTable(fileIn, `${tag} in`);
    tOut = await importTable(fileOut, `${tag} out`);
    tEdited = await importTable(fileEdited, `${tag} edited`);
    tChecked = await importTable(fileChecked, `${tag} checked`);
    // A user's own table that names the file but was not imported by the pass.
    const own = await c.createTable(anchor, {
      title: `${tag} user`,
      sourceFileId: fileIn,
      data: { columns: [{ id: 'a', name: 'A', type: 'text' }], rows: [] },
    });
    tUser = own.id;
    tableIds.push(own.id);
    // The edited table: a commit after the import moves its version on.
    await c.applyTableOps(anchor, tEdited, [{ op: 'row_add', cells: {} }]);
    await c.commitTable(anchor, tEdited);
    // A grant that must survive the rebuild.
    await superuserExec(
      URL!,
      sqlTag`insert into workspaces (id, owner_id, name) values (${wsId}, ${anchor}, ${`${tag} ws`})`,
    );
    await m.withHeads([tIn], 'update', (tx) =>
      tx.execute(sqlTag`insert into item_grants (node_id, workspace_id) values (${tIn}, ${wsId})`),
    );
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    // The crops the sealed-row case filed (linked to its table).
    const crops = await admin`select id from nodes where owner_id = ${anchor}
      and type = 'file' and data->>'sourceTableId' = any(${tableIds}::text[])`;
    await admin`delete from nodes where id = any(${crops.map((x) => String(x.id))}::uuid[])`;
    await admin`delete from item_grants where node_id = any(${tableIds}::uuid[])`;
    await admin`delete from table_snapshots where table_id = any(${tableIds}::uuid[])`.catch(
      () => [],
    );
    await admin`delete from nodes where id = any(${[...tableIds, fileIn, fileOut, fileEdited, fileChecked, fileSealed, folder]}::uuid[])`;
    // The sealed case's Drawing checks folder, by exact path and only once
    // empty: never a folder this file did not make.
    const { autoFiledFolderPath } = await import('@mantle/files');
    const cropPath = autoFiledFolderPath('drawing-checks', { document: { slug: fileSealed } });
    await admin`delete from nodes n where n.owner_id = ${anchor} and n.type = 'branch'
      and n.path::text = ${cropPath}
      and not exists (select 1 from nodes c where c.owner_id = ${anchor}
        and c.path <@ n.path and c.id <> n.id)`;
    await superuserExec(URL!, sqlTag`delete from workspaces where id = ${wsId}`);
    await m.closeDb();
    rmSync(root, { recursive: true, force: true });
  });

  it('scopes by file id and by folder, and never picks a user table', async () => {
    const byFile = await r.findReindexCandidates({ fileIds: [fileIn] }, 10);
    expect(byFile.map((x) => x.tableId)).toEqual([tIn]);
    const byFolder = await r.findReindexCandidates({ folderId: folder }, 10);
    expect(byFolder.map((x) => x.tableId).sort()).toEqual([tIn, tEdited].sort());
    expect(byFolder.map((x) => x.tableId)).not.toContain(tOut);
    expect(byFolder.map((x) => x.tableId)).not.toContain(tUser);
  });

  it('the cap returns one more than the limit so the run can say it was cut', async () => {
    const capped = await r.findReindexCandidates({ folderId: folder }, 1);
    expect(capped).toHaveLength(2);
  });

  it('rebuilds in place: same id, grant and title, new tabs and description', async () => {
    const [cand] = await r.findReindexCandidates({ fileIds: [fileIn] }, 10);
    const out = await r.rebuildOne(cand!, {});
    expect(out).toMatchObject({ tableId: tIn, result: 'rebuilt', tabs: ['Layers', 'Segments'] });
    const t = await c.getTable(anchor, tIn);
    expect(t?.id).toBe(tIn);
    expect(t?.title).toBe(`${tag} in`);
    expect(t?.tabs?.map((x) => x.name)).toEqual(['Layers', 'Segments']);
    expect(t?.description).toMatch(/rebuilt/);
    // Its own workspace's grant (other files' tests share the database).
    const [g] =
      await admin`select count(*)::int as n from item_grants where node_id = ${tIn} and workspace_id = ${wsId}`;
    expect(g!.n).toBe(1);
  });

  it('a rebuilt table is skipped by the next run unless again (quality MED-7)', async () => {
    // A capped re-run reaches the rest of the scope instead of the same tables.
    expect(await r.findReindexCandidates({ fileIds: [fileIn] }, 10)).toEqual([]);
    const byFolder = await r.findReindexCandidates({ folderId: folder }, 10);
    expect(byFolder.map((x) => x.tableId)).toEqual([tEdited]);
    // Asked again, it sees its own version, not an edit.
    const [again] = await r.findReindexCandidates({ fileIds: [fileIn] }, 10, { again: true });
    expect(again?.tableId).toBe(tIn);
    expect(r.decide(again!, {})).toEqual({ action: 'rebuild', snapshotFirst: false });
  });

  it('a draft a user opens during the run is never overwritten (security MED-1)', async () => {
    const [cand] = await r.findReindexCandidates({ fileIds: [fileOut] }, 10);
    expect(cand?.hasDraft).toBe(false);
    midRun.hook = async () => {
      await c.applyTableOps(anchor, tOut, [{ op: 'row_add', cells: {} }]);
    };
    try {
      const out = await r.rebuildOne(cand!, {});
      expect(out).toMatchObject({ tableId: tOut, result: 'refused' });
    } finally {
      midRun.hook = null;
    }
    const now = await r.readFreshState(tOut);
    expect(now).toMatchObject({ hasDraft: true, version: cand!.version });
    const t = await c.getTable(anchor, tOut);
    expect(t?.tabs?.map((x) => x.name) ?? ['Layers']).not.toContain('Segments');
    expect(await c.discardTableDraft(anchor, tOut)).toBe(true);
  });

  it('an edited table is refused, then snapshotted first with keepEdits', async () => {
    const [cand] = await r.findReindexCandidates({ fileIds: [fileEdited] }, 10);
    expect(await r.rebuildOne(cand!, {})).toMatchObject({ result: 'refused' });
    const before = await c.getTable(anchor, tEdited);
    expect(before?.tabs?.map((x) => x.name) ?? ['Layers']).not.toContain('Segments');
    const out = await r.rebuildOne(cand!, { keepEdits: true });
    expect(out).toMatchObject({ result: 'rebuilt' });
    expect((out as { snapshot: string | null }).snapshot).toBeTruthy();
    const after = await c.getTable(anchor, tEdited);
    expect(after?.id).toBe(tEdited);
  });

  it('keeps the Checks tab and its rows; an image-check commit is not an edit; stamps the bytes', async () => {
    const { dwgTableEdited, DWG_CHECKED_VERSION_KEY, DWG_SOURCE_SHA_KEY } =
      await import('@mantle/files/dwg');
    // The image check's commit: a Checks tab with one row, then the mark
    // checks-store.ts writes on an unedited table.
    const tab = randomUUID();
    const [k, a, tg, vd, len, on] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    // Beside the two text columns, the types a value copy used to garble:
    // a multiselect (one item holds a comma), a select with its options, a
    // formatted number, a date (MED-1).
    const tagOptions = [
      { id: 'ok', label: 'ok' },
      { id: 'rv', label: 'reviewed' },
      { id: 'ab', label: 'a, b' },
    ];
    const verdictOptions = [
      { id: 'y', label: 'yes', color: 'green' },
      { id: 'n', label: 'no' },
    ];
    await c.applyTableOps(anchor, tChecked, [
      { op: 'tab_add', tabId: tab, name: 'Checks' },
      { op: 'column_add', tabId: tab, column: { id: k, name: 'Key', type: 'text' } },
      { op: 'column_add', tabId: tab, column: { id: a, name: 'Answer', type: 'text' } },
      {
        op: 'column_add',
        tabId: tab,
        column: { id: tg, name: 'Tags', type: 'multiselect', options: tagOptions },
      },
      {
        op: 'column_add',
        tabId: tab,
        column: { id: vd, name: 'Verdict', type: 'select', options: verdictOptions },
      },
      {
        op: 'column_add',
        tabId: tab,
        column: { id: len, name: 'Length', type: 'number', format: { decimals: 2 } },
      },
      { op: 'column_add', tabId: tab, column: { id: on, name: 'Checked on', type: 'date' } },
      {
        op: 'row_add',
        tabId: tab,
        cells: {
          [k]: 'end:A1@1.0,0.0',
          [a]: 'yes',
          [tg]: ['ok', 'reviewed'],
          [vd]: 'yes',
          [len]: 12.5,
          [on]: '2026-10-25',
        },
      },
      {
        op: 'row_add',
        tabId: tab,
        cells: { [k]: 'join:pGap', [a]: 'no', [tg]: ['a, b'], [vd]: 'no', [len]: 3 },
      },
    ]);
    await c.commitTable(anchor, tChecked, undefined, { noModelPass: true });
    const [v] = await admin`select version from tables where node_id = ${tChecked}`;
    await m.withHeads([tChecked], 'update', (tx) =>
      tx.execute(
        sqlTag`update nodes set data = data || ${JSON.stringify({ [DWG_CHECKED_VERSION_KEY]: Number(v!.version) })}::jsonb where id = ${tChecked}`,
      ),
    );
    const [cand] = await r.findReindexCandidates({ fileIds: [fileChecked] }, 10);
    expect(cand?.checkedVersion).toBe(Number(v!.version));
    expect(dwgTableEdited(cand!)).toBe(false);
    expect(r.decide(cand!, {})).toEqual({ action: 'rebuild', snapshotFirst: false });
    const before = await r.checksTabOf(anchor, tChecked);
    expect(before?.rows).toHaveLength(2);
    const out = await r.rebuildOne(cand!, {});
    expect(out).toMatchObject({ result: 'rebuilt', tabs: ['Layers', 'Segments', 'Checks'] });
    const kept = await r.checksTabOf(anchor, tChecked);
    expect(kept?.columns).toEqual([
      { id: k, name: 'Key', type: 'text' },
      { id: a, name: 'Answer', type: 'text' },
      { id: tg, name: 'Tags', type: 'multiselect', options: tagOptions },
      { id: vd, name: 'Verdict', type: 'select', options: verdictOptions },
      { id: len, name: 'Length', type: 'number', format: { decimals: 2 } },
      { id: on, name: 'Checked on', type: 'date' },
    ]);
    expect(kept?.rows.map((row) => kept.columns.map((col) => row.cells[col.id] ?? null))).toEqual([
      ['end:A1@1.0,0.0', 'yes', ['ok', 'reviewed'], 'yes', 12.5, '2026-10-25'],
      ['join:pGap', 'no', ['a, b'], 'no', 3, null],
    ]);
    // A second rebuild of the rebuilt table gives the same tab, cell for
    // cell: nothing nests or splits again.
    const [again] = await r.findReindexCandidates({ fileIds: [fileChecked] }, 10, { again: true });
    expect(await r.rebuildOne(again!, {})).toMatchObject({ result: 'rebuilt' });
    expect(await r.checksTabOf(anchor, tChecked)).toEqual(kept);
    const [n] = await admin`select data from nodes where id = ${tChecked}`;
    expect((n!.data as Row)[DWG_SOURCE_SHA_KEY]).toBe(
      createHash('sha256').update(Buffer.from('AC1032 made-up')).digest('hex'),
    );
  });

  it('a sealed row filed by circuit_verify survives a real rebuild: the seal holds and it still applies (L6)', async () => {
    const store = await import('../../../../packages/tools/src/circuit-trace/checks-store');
    const check = await import('../../../../packages/tools/src/circuit-trace/check');
    const revision = BYTES_SHA.slice(0, 16);
    const t = await c.createTable(anchor, {
      title: `${tag} sealed`,
      tags: ['auto-import'],
      sourceFileId: fileSealed,
      sourceSha256: BYTES_SHA,
      description: 'AutoCAD DWG model-space registry. (old, no geometry tabs)',
      tabs: [
        {
          ...c.tableDocFromGrid({ columns: [{ name: 'Layer', type: 'text' }], rows: [['L']] }),
          name: 'Layers',
        },
      ],
    });
    tableIds.push(t.id);
    const sheet = {
      tableId: t.id,
      title: `${tag} PID-S`,
      sourceFileId: fileSealed,
      revision,
      sourceSha: BYTES_SHA,
      source: 'current' as const,
      circuitLayers: [],
      circuitRows: [],
      segments: [],
      nodes: [],
      inserts: [],
      texts: [],
      blocks: [],
      near: 1,
      limits: [],
    };
    // The crops go under Auto-filed: the Files root a box has.
    await (await import('@mantle/files')).ensureFilesRootBranch(anchor);
    const key = 'end:A1@1.0,0.0';
    const question = 'Does the pipe end connect to "V-201"?';
    const filed = await store.storeChecks(
      anchor,
      sheet,
      'C-1',
      [
        {
          q: {
            id: 'q1',
            key,
            kind: 'end',
            tableId: t.id,
            sheet: sheet.title,
            sourceFileId: fileSealed,
            node: 2,
            handles: ['A1'],
            guess: 'the pipe end #2 belongs to "V-201"',
            question,
            item: { id: 'q1', kind: 'point', at: [1, 0], pad: 4 },
            pidKey: 'x:2',
            alts: ['break', 'continues', 'open', 'other'],
            altAsk: 'If no, give "alt".',
          },
          verdict: 'yes',
          reason: 'into its nozzle',
          model: 'test/vision-model',
          crops: [{ png: Buffer.from('png-1'), part: 0, of: 1, window: [0, 0, 2, 2], textPx: 14 }],
        },
      ],
      null,
      '2026-10-25T12:00:00.000Z',
    );
    expect(filed).toEqual({ stored: 1 });
    /** The Checks rows as the read maps them (column name to value). */
    const rows = async () => {
      const tab = await r.checksTabOf(anchor, t.id);
      return (tab?.rows ?? []).map((row) =>
        check.storedCheckOf(
          Object.fromEntries(tab!.columns.map((col) => [col.name, row.cells[col.id] ?? null])),
        ),
      );
    };
    const before = await rows();
    expect(before).toHaveLength(1);
    expect(check.sealedRow(t.id, before[0]!)).toBe(true);

    // The check commit is not an edit: a plain rebuild, no --keep-edits.
    const [cand] = await r.findReindexCandidates({ fileIds: [fileSealed] }, 10);
    expect(r.decide(cand!, {})).toEqual({ action: 'rebuild', snapshotFirst: false });
    expect(await r.rebuildOne(cand!, {})).toMatchObject({
      result: 'rebuilt',
      tabs: ['Layers', 'Segments', 'Checks'],
    });

    const after = await rows();
    expect(after).toEqual(before);
    expect(check.sealedRow(t.id, after[0]!)).toBe(true);
    // Same bytes, same revision: the answer still applies to its question.
    const [n] = await admin`select data->>'sourceSha256' as sha from nodes where id = ${t.id}`;
    const now = String(n!.sha).slice(0, 16);
    expect(now).toBe(revision);
    const { byKey, stale, unsealed } = check.latestChecks(t.id, after, now);
    expect({ stale, unsealed }).toEqual({ stale: 0, unsealed: 0 });
    const latest = new Map([[t.id, byKey]]);
    expect(check.currentAnswer(latest, { tableId: t.id, key, question })?.answer).toBe('yes');
  });
});
