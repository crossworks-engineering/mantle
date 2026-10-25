/**
 * The image check's store on a real, migrated Postgres (checks-store.ts):
 * storeChecks writes the Checks tab through applyTableOps and a commit,
 * saves the crops as name-only image files linked to the drawing and the
 * table, seals each row and marks the commit as not an edit
 * (dwgCheckedVersion); storeRefusal refuses before any spend a table with
 * a draft, a read-only snapshot copy and a workspace that only reads the
 * table; a user who writes to the draft between the Checks write and its
 * commit keeps their draft, and nothing is published; the revision read
 * (read.ts dwgTables) is the table's stamp, and a file replaced in place
 * reads as stale, its subquery comparing the outer table's own column.
 * Made-up drawing, no model is reached.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/circuit-trace/checks-store.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor, superuserExec } from '@mantle/db/test-support';

/** Runs between the Checks write and its commit: a user acting meanwhile. */
const midStore = vi.hoisted(() => ({ hook: null as null | (() => Promise<void>) }));

vi.mock('@mantle/content', async (orig) => {
  const real = await orig<typeof import('@mantle/content')>();
  return {
    ...real,
    commitTable: async (...a: Parameters<typeof real.commitTable>) => {
      await midStore.hook?.();
      return real.commitTable(...a);
    },
  };
});

const URL = process.env.MANTLE_TEST_DATABASE_URL;
type Row = Record<string, unknown>;
const BYTES = Buffer.from('AC1032 made-up drawing');
const SHA = createHash('sha256').update(BYTES).digest('hex');

describe.skipIf(!URL)('the image check store', () => {
  let m: typeof import('@mantle/db');
  let c: typeof import('@mantle/content');
  let s: typeof import('./checks-store');
  let readMod: typeof import('./read');
  let check: typeof import('./check');
  let admin: (strings: TemplateStringsArray, ...v: unknown[]) => Promise<Row[]>;
  let sqlTag: typeof import('drizzle-orm').sql;
  let anchor = '';
  const tag = `ckst${randomUUID().slice(0, 6)}`;
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-ckst-'));
  let fileId = '';
  const wsId = randomUUID();
  const ids: string[] = [];

  const sheetOf = (tableId: string) => ({
    tableId,
    title: `${tag} PID-1`,
    sourceFileId: fileId,
    revision: SHA.slice(0, 16),
    sourceSha: SHA,
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
  });

  const answerOf = (key: string) => ({
    q: {
      id: 'q1',
      key,
      kind: 'end' as const,
      tableId: '',
      sheet: `${tag} PID-1`,
      sourceFileId: fileId,
      node: 2,
      handles: ['A1'],
      guess: 'the pipe end #2 belongs to "V-201"',
      question: 'Does the pipe end connect to "V-201"?',
      item: { id: 'q1', kind: 'point' as const, at: [1, 0] as [number, number], pad: 4 },
      pidKey: 'x:2',
    },
    verdict: 'yes' as const,
    reason: 'into its nozzle',
    model: 'test/vision-model',
    crops: [{ png: Buffer.from('png-1'), part: 0, of: 1, window: [0, 0, 2, 2], textPx: 14 }],
  });

  const makeTable = async (title: string) => {
    const t = await c.createTable(anchor, {
      title,
      tags: ['auto-import'],
      sourceFileId: fileId,
      sourceSha256: SHA,
      description: 'AutoCAD DWG model-space registry. ... within 2 drawing units of it ... (test)',
      tabs: [
        {
          ...c.tableDocFromGrid({ columns: [{ name: 'Layer', type: 'text' }], rows: [['L']] }),
          name: 'Layers',
        },
      ],
    });
    ids.push(t.id);
    return t.id;
  };

  const checksRows = async (tableId: string) => {
    const { tableSqlSurface } = await import('@mantle/content/table-storage');
    const { runTableSql } = await import('@mantle/tabledb');
    const surface = await tableSqlSurface(anchor, tableId);
    const tab = surface?.tabs.find((t) => t.name === 'Checks');
    if (!surface || !tab) return [];
    const r = await runTableSql(surface.abs, `SELECT * FROM "${tab.viewName}"`, { cap: 100 });
    return r.rows.map((row) => Object.fromEntries(r.columns.map((k, i) => [k, row[i]])));
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.TABLE_DB_DIR = path.join(root, 'table-dbs');
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    m = await import('@mantle/db');
    c = await import('@mantle/content');
    s = await import('./checks-store');
    readMod = await import('./read');
    check = await import('./check');
    sqlTag = (await import('drizzle-orm')).sql;
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    await m.ensureViewerRoles(admin as never, process.env.MANTLE_MASTER_KEY);
    anchor = await ensureTestAnchor(admin as never);
    // The drawing as an ordinary upload: a file the caller reads, its
    // sha256 the stamp (a raw insert left it out of the caller's scope,
    // so its hash read null).
    const files = await import('@mantle/files');
    fileId = (
      await files.upsertFile({
        ownerId: anchor,
        parentPath: 'files',
        filename: `${tag}.dwg`,
        bytes: BYTES,
        overwrite: false,
      })
    ).id;
    const [f] = await admin`select data->>'sha256' as sha from nodes where id = ${fileId}`;
    expect(f!.sha).toBe(SHA);
    await superuserExec(
      URL!,
      sqlTag`insert into workspaces (id, owner_id, name) values (${wsId}, ${anchor}, ${`${tag} ws`})`,
    );
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    const crops = await admin`select id from nodes where owner_id = ${anchor}
      and type = 'file' and data->>'sourceTableId' = any(${ids}::text[])`;
    const all = [...ids, ...crops.map((r) => String(r.id)), fileId];
    await admin`delete from item_grants where node_id = any(${all}::uuid[])`;
    await admin`delete from nodes where id = any(${all}::uuid[])`;
    await superuserExec(URL!, sqlTag`delete from workspaces where id = ${wsId}`);
    await m.closeDb();
    rmSync(root, { recursive: true, force: true });
  });

  it('files the answers: a sealed Checks row, linked crops, a commit that is not an edit', async () => {
    const t = await makeTable(`${tag} store`);
    const sheet = sheetOf(t);
    expect(await s.storeRefusal(anchor, sheet)).toBeNull();
    const before = await s.tableState(t);
    const at = '2026-10-25T12:00:00.000Z';
    const r = await s.storeChecks(anchor, sheet, 'C-1', [answerOf('end:A1@1.0,0.0')], null, at);
    expect(r).toEqual({ stored: 1 });
    const rows = await checksRows(t);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      Key: 'end:A1@1.0,0.0',
      Answer: 'yes',
      Trust: 'CHECKED BY IMAGE',
      Model: 'test/vision-model',
      Revision: SHA.slice(0, 16),
      File: fileId,
    });
    // The row as the read maps it holds its seal (every field it covers).
    expect(check.sealedRow(t, check.storedCheckOf(row))).toBe(true);
    expect(check.sealedRow(t, check.storedCheckOf({ ...row, Reason: 'typed' }))).toBe(false);
    const cropIds = String(row.Crops).split(' ');
    const crops = await admin`select data from nodes where id = any(${cropIds}::uuid[])`;
    expect(crops).toHaveLength(1);
    expect(crops[0]!.data).toMatchObject({
      indexing: 'metadata',
      sourceFileId: fileId,
      sourceTableId: t,
      revision: SHA.slice(0, 16),
    });
    const after = await s.tableState(t);
    expect(after).toMatchObject({ version: before!.version + 1, hasDraft: false });
    expect(after!.checkedVersion).toBe(after!.version);
    // No model pass asked: the table was unsummarised, so no index work.
    const [n] = await admin`select data from nodes where id = ${t}`;
    expect((n!.data as Row).summary ?? null).toBeNull();
  });

  it('a table with a draft open is refused before any spend', async () => {
    const t = await makeTable(`${tag} draft`);
    await c.applyTableOps(anchor, t, [{ op: 'row_add', cells: {} }]);
    expect(await s.storeRefusal(anchor, sheetOf(t))).toMatch(/unsaved draft/);
    const r = await s.storeChecks(anchor, sheetOf(t), 'C-1', [answerOf('k')], null, 'x');
    expect(r).toMatchObject({ error: expect.stringMatching(/unsaved draft/) });
    expect(await c.discardTableDraft(anchor, t)).toBe(true);
  });

  it('a read-only snapshot copy is refused before any spend', async () => {
    const t = await makeTable(`${tag} copy`);
    await admin`update nodes set data = data || ${JSON.stringify({ snapshot_of: ids[0] })}::jsonb where id = ${t}`;
    expect(await s.storeRefusal(anchor, sheetOf(t))).toMatch(/may not edit its table/);
  });

  it('a workspace that only reads the table is refused before any spend', async () => {
    const t = await makeTable(`${tag} read-only`);
    await m.withHeads([t], 'update', (tx) =>
      tx.execute(
        sqlTag`insert into item_grants (node_id, workspace_id, write) values (${t}, ${wsId}, false)`,
      ),
    );
    const why = await m.withScope({ kind: 'assistant', loginId: null, ws: [wsId], modWs: [] }, () =>
      s.storeRefusal(anchor, sheetOf(t)),
    );
    expect(why).toMatch(/may not edit its table|Auto-filed/);
    // Under row security the scope still reads the table's own stamp (the
    // revision its checks are filed under); a table it is not granted is
    // not listed at all.
    const listed = await m.withScope(
      { kind: 'assistant', loginId: null, ws: [wsId], modWs: [] },
      () => readMod.dwgTables(anchor),
    );
    const mine = listed.tables.filter((x) => ids.includes(x.id));
    expect(mine.map((x) => x.id)).toEqual([t]);
    expect(mine[0]).toMatchObject({ revision: SHA.slice(0, 16), sourceSha: SHA });
  });

  it('a user who writes to the draft before the commit keeps it, our rows and crops with it', async () => {
    const t = await makeTable(`${tag} race`);
    const before = await s.tableState(t);
    midStore.hook = async () => {
      await c.applyTableOps(anchor, t, [{ op: 'row_add', cells: {} }]);
    };
    let r: Awaited<ReturnType<typeof s.storeChecks>>;
    try {
      r = await s.storeChecks(anchor, sheetOf(t), 'C-1', [answerOf('k2')], null, 'y');
    } finally {
      midStore.hook = null;
    }
    // Not committed here: the rows wait in the user's draft and publish
    // with it, so the crops (their evidence) are kept.
    expect(r).toMatchObject({ stored: 0, pending: 1, note: expect.stringMatching(/publish/) });
    const now = await s.tableState(t);
    expect(now).toMatchObject({ version: before!.version, hasDraft: true });
    const left = await admin`select count(*)::int as n from nodes
      where data->>'sourceTableId' = ${t} and type = 'file'`;
    expect(left[0]!.n).toBe(1);
    expect(await c.discardTableDraft(anchor, t)).toBe(true);
  });

  it("a dry run's store check makes no folder; the real one makes it at the same path", async () => {
    const t = await makeTable(`${tag} dry`);
    const sheet = { ...sheetOf(t), sourceFileId: randomUUID(), title: `${tag} dry drawing` };
    const files = await import('@mantle/files');
    const path = files.autoFiledFolderPath('drawing-checks', {
      document: { slug: sheet.sourceFileId },
    });
    const count = async () =>
      (
        await admin`select count(*)::int as n from nodes
          where owner_id = ${anchor} and type = 'branch'`
      )[0]!.n as number;
    const was = await count();
    expect(await s.storeRefusal(anchor, sheet, { dryRun: true })).toBeNull();
    expect(await count()).toBe(was);
    expect(await files.folderByPath({ ownerId: anchor, path })).toBeNull();
    expect(await s.storeRefusal(anchor, sheet)).toBeNull();
    expect(await files.folderByPath({ ownerId: anchor, path })).not.toBeNull();
    await admin`delete from nodes where owner_id = ${anchor} and type = 'branch'
      and path::text = ${path}`;
  });

  it('end to end: an answer filed by circuit_verify applies in circuit_trace and is not asked again', async () => {
    const circuit = `${tag}-E2E`;
    const layer = `Circuit ${circuit}`;
    const num = (name: string) => ({ name, type: 'number' as const });
    const txt = (name: string) => ({ name, type: 'text' as const });
    const grid = (
      name: string,
      columns: { name: string; type: 'text' | 'number' }[],
      rows: unknown[][],
    ) => ({
      ...c.tableDocFromGrid({ columns, rows: rows as never }),
      name,
    });
    const made = await c.createTable(anchor, {
      title: `${tag} PID-E2E`,
      tags: ['auto-import'],
      sourceFileId: fileId,
      sourceSha256: SHA,
      description: 'AutoCAD DWG model-space registry. ... within 2 drawing units of it ... (test)',
      tabs: [
        grid('Layers', [txt('Layer')], [[layer], ['EQUIP']]),
        grid(
          'Segments',
          [
            txt('Layer'),
            txt('Handle'),
            num('X1'),
            num('Y1'),
            num('X2'),
            num('Y2'),
            num('Length'),
            num('Node 1'),
            num('Node 2'),
            num('Part'),
          ],
          [[layer, 'A', 0, 0, 20, 0, 20, 1, 2, 0]],
        ),
        grid(
          'Nodes',
          [
            num('Node'),
            num('X'),
            num('Y'),
            num('Degree'),
            txt('Kind'),
            txt('Block'),
            txt('Block handle'),
            txt('Layers'),
          ],
          [
            [1, 0, 0, 1, 'end', '', '', layer],
            [2, 20, 0, 1, 'end', '', '', layer],
          ],
        ),
        grid(
          'Texts',
          [txt('Text'), txt('Layer'), num('X'), num('Y')],
          [
            ['E-101', 'EQUIP', -1, 0],
            ['V-201', 'EQUIP', 25, 0],
          ],
        ),
      ],
    });
    ids.push(made.id);
    const builtins = await import('../builtins-circuits');
    const { verifyCircuit } = await import('./verify');
    const png = Buffer.from('png');
    let asked = 0;
    const deps: import('./verify').VerifyDeps = {
      readSheets: builtins.readCircuitSheets,
      fileBytes: async () => BYTES,
      crop: async (_b, spec) => ({
        ok: true,
        value: {
          converter: 'none',
          crops: spec.items.map((it) => ({
            id: it.id,
            part: 0,
            of: 1,
            window: [0, 0, 1, 1] as [number, number, number, number],
            width: 100,
            height: 100,
            textPx: 14,
            png,
          })),
          overview: { window: [0, 0, 1, 1], png },
          capped: [],
        },
      }),
      worker: async () => ({
        ok: true,
        worker: { slug: 'vision-test', provider: 'openrouter', model: 'test/vision-model' },
        multiImage: true,
      }),
      ask: async (_images, prompt) => {
        asked += 1;
        const qids = [...prompt.matchAll(/^(q\d+) \(/gm)].map((m) => m[1]);
        return {
          text: JSON.stringify({
            answers: qids.map((id) => ({ id, answer: 'yes', reason: 'into its nozzle' })),
          }),
          model: 'test/vision-model',
        };
      },
      storable: s.storeRefusal,
      store: s.storeChecks,
      now: () => new Date('2026-10-25T12:00:00.000Z'),
    };
    const first = await verifyCircuit(anchor, { circuit, kinds: ['end'] }, deps);
    expect(first).toMatchObject({ ok: true });
    expect(asked).toBe(1);
    const out1 = (
      first as unknown as { output: { answers: { answer: string }[]; summary: string } }
    ).output;
    expect(out1.answers.map((a) => a.answer)).toEqual(['yes']);
    expect(out1.summary).toMatch(/Stored in the Checks tab/);

    // circuit_trace reads it back through the real read and applies it.
    const traced = await builtins.circuitTraceHandler({ circuit }, anchor);
    expect(traced).toMatchObject({ ok: true });
    const t = (
      traced as {
        output: { checks?: { items: { trust: string }[] }; pid: unknown; limits: string[] };
      }
    ).output;
    expect(t.checks?.items.map((x) => x.trust)).toEqual(['CHECKED BY IMAGE']);
    expect(JSON.stringify(t.pid)).toContain('NEAR V-201 (CHECKED BY IMAGE)');
    expect(t.limits.join(' ')).not.toMatch(/no circuit_verify seal/);

    // A second call does not pay for the answered question again.
    const second = await verifyCircuit(anchor, { circuit, kinds: ['end'] }, deps);
    expect(second).toMatchObject({ ok: true });
    expect(asked).toBe(1);
    expect((second as unknown as { output: { summary: string } }).output.summary).toMatch(
      /no unanswered guess/,
    );
  });

  it('the revision is the stamp; a file replaced in place reads stale', async () => {
    const t = await makeTable(`${tag} revision`);
    const find = async () => (await readMod.dwgTables(anchor)).tables.find((x) => x.id === t);
    expect(await find()).toMatchObject({
      revision: SHA.slice(0, 16),
      sourceSha: SHA,
      source: 'current',
      sourceFileId: fileId,
    });
    // The outer column is the table's own: a subquery reading its own
    // `f.data` would see the file's data (no sourceFileId) and match nothing.
    await admin`update nodes set data = jsonb_set(data, '{sha256}', to_jsonb(${'b'.repeat(64)}::text)) where id = ${fileId}`;
    expect((await find())!.source).toBe('stale');
    await admin`update nodes set data = jsonb_set(data, '{sha256}', to_jsonb(${SHA}::text)) where id = ${fileId}`;
    // A table imported before the stamp.
    await admin`update nodes set data = data - 'sourceSha256' where id = ${t}`;
    expect(await find()).toMatchObject({ source: 'unstamped', revision: null });
  });
});
