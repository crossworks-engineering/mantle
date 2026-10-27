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
 * The store check before the spend judges rights only: no crop folder is
 * made until answers are filed, so a sheet skipped on the way (no crop
 * endpoint, a drawing replaced since its table was read, the request cap)
 * leaves none. Made-up drawing, no model is reached.
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
/** A second drawing, its crop folder this file's own to look for. */
const BYTES2 = Buffer.from('AC1032 made-up drawing, sheet two');
const SHA2 = createHash('sha256').update(BYTES2).digest('hex');

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
  let fileId2 = '';
  const wsId = randomUUID();
  const ids: string[] = [];
  /** The Drawing checks folders this file's calls may make, by exact path:
   *  the only folders afterAll removes. */
  const cropPaths: string[] = [];
  /** The crop folder path of the second drawing (set in beforeAll). */
  let files2Path = (): string => '';
  /** How many folders sit at or under `path` (this file's own paths only:
   *  other files share the anchor owner, so a total moves under them). */
  const foldersAt = async (path: string) =>
    (
      await admin`select count(*)::int as n from nodes
        where owner_id = ${anchor} and type = 'branch' and path <@ ${path}::ltree`
    )[0]!.n as number;

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
      alts: ['V-202', 'break', 'continues', 'open', 'other'],
      altAsk: 'If no, give "alt".',
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

  /** A drawing's auto-import table carrying one circuit: two pipe ends,
   *  each only near a tag (the guesses circuit_verify asks about). */
  const circuitTable = async (circuit: string, title: string, file: string, sha: string) => {
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
      title,
      tags: ['auto-import'],
      sourceFileId: file,
      sourceSha256: sha,
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
    return made.id;
  };

  /** circuit_verify's outside effects: the real store, a sidecar and a
   *  model made up (`over` replaces any of them). */
  const verifyDeps = async (
    bytes: Buffer,
    asked: { n: number },
    over: Partial<import('./verify').VerifyDeps> = {},
  ): Promise<import('./verify').VerifyDeps> => {
    const builtins = await import('../builtins-circuits');
    const png = Buffer.from('png');
    return {
      readSheets: builtins.readCircuitSheets,
      fileBytes: async () => bytes,
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
        asked.n += 1;
        const qids = [...prompt.matchAll(/^(q\d+) \(/gm)].map((m) => m[1]);
        return {
          text: JSON.stringify({
            answers: qids.map((id) => ({ id, answer: 'yes', reason: 'into its nozzle' })),
          }),
          model: 'test/vision-model',
        };
      },
      storable: s.storeRefusal,
      claim: s.claimVerifyRun,
      runs: s.readVerifyRuns,
      store: s.storeChecks,
      now: () => new Date('2026-10-25T12:00:00.000Z'),
      ...over,
    };
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
    // A fresh database has no Files root yet: make it, as an upload would
    // find it on a box.
    await files.ensureFilesRootBranch(anchor);
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
    fileId2 = (
      await files.upsertFile({
        ownerId: anchor,
        parentPath: 'files',
        filename: `${tag}-2.dwg`,
        bytes: BYTES2,
        overwrite: false,
      })
    ).id;
    for (const slug of [fileId, fileId2])
      cropPaths.push(files.autoFiledFolderPath('drawing-checks', { document: { slug } }));
    files2Path = () => cropPaths[1]!;
    await superuserExec(
      URL!,
      sqlTag`insert into workspaces (id, owner_id, name) values (${wsId}, ${anchor}, ${`${tag} ws`})`,
    );
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    // Only what this file made (a setup that stopped early made less).
    const crops = anchor
      ? await admin`select id from nodes where owner_id = ${anchor}
      and type = 'file' and data->>'sourceTableId' = any(${ids}::text[])`
      : [];
    const all = [
      ...ids,
      ...crops.map((r) => String(r.id)),
      ...(fileId ? [fileId] : []),
      ...(fileId2 ? [fileId2] : []),
    ];
    await admin`delete from item_grants where node_id = any(${all}::uuid[])`;
    await admin`delete from nodes where id = any(${all}::uuid[])`;
    // The Drawing checks folders its calls made, by exact path, each only
    // once empty (its crops went above): never a folder it did not make.
    if (anchor && cropPaths.length)
      await admin`delete from nodes n where n.owner_id = ${anchor} and n.type = 'branch'
        and n.path::text = any(${cropPaths}::text[])
        and not exists (select 1 from nodes c where c.owner_id = ${anchor}
          and c.path <@ n.path and c.id <> n.id)`;
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
    // Each crop's id with the sha256 of the bytes stored, sealed with the row.
    const cropIds = check.cropIdsOf(String(row.Crops)).crops;
    expect(String(row.Crops)).toContain(
      check.cropCellWords(
        cropIds[0]!,
        createHash('sha256').update(Buffer.from('png-1')).digest('hex'),
      ),
    );
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
    // Its own source table: the case does not lean on another test's.
    const src = await makeTable(`${tag} copy source`);
    const t = await makeTable(`${tag} copy`);
    await admin`update nodes set data = data || ${JSON.stringify({ snapshot_of: src })}::jsonb where id = ${t}`;
    expect(await s.storeRefusal(anchor, sheetOf(t))).toMatch(
      /^the answers could not be stored: you may not edit its table \(/,
    );
    // The source itself stays writable.
    expect(await s.storeRefusal(anchor, sheetOf(src), { dryRun: true })).toBeNull();
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
    // The table refusal, first: the crop folder is never reached.
    expect(why).toMatch(/^the answers could not be stored: you may not edit its table \(/);
    expect(why).not.toMatch(/Auto-filed/);
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

  it('neither store check makes a folder (dry run or real); filing makes it at the same path', async () => {
    const t = await makeTable(`${tag} dry`);
    const sheet = { ...sheetOf(t), sourceFileId: randomUUID(), title: `${tag} dry drawing` };
    const files = await import('@mantle/files');
    const path = files.autoFiledFolderPath('drawing-checks', {
      document: { slug: sheet.sourceFileId },
    });
    cropPaths.push(path);
    expect(await s.storeRefusal(anchor, sheet, { dryRun: true })).toBeNull();
    expect(await foldersAt(path)).toBe(0);
    // The real pass before the spend judges rights only (LOW-3).
    expect(await s.storeRefusal(anchor, sheet)).toBeNull();
    expect(await foldersAt(path)).toBe(0);
    const at = '2026-10-25T12:00:00.000Z';
    expect(await s.storeChecks(anchor, sheet, 'C-1', [answerOf('k-dry')], null, at)).toEqual({
      stored: 1,
    });
    expect(await files.folderByPath({ ownerId: anchor, path })).not.toBeNull();
  });

  it('end to end: an answer filed by circuit_verify applies in circuit_trace and is not asked again', async () => {
    const circuit = `${tag}-E2E`;
    await circuitTable(circuit, `${tag} PID-E2E`, fileId, SHA);
    const builtins = await import('../builtins-circuits');
    const { verifyCircuit } = await import('./verify');
    const counter = { n: 0 };
    const deps = await verifyDeps(BYTES, counter);
    const first = await verifyCircuit(anchor, { circuit, kinds: ['end'] }, deps);
    expect(first).toMatchObject({ ok: true });
    expect(counter.n).toBe(1);
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
    expect(counter.n).toBe(1);
    expect((second as unknown as { output: { summary: string } }).output.summary).toMatch(
      /no unanswered guess/,
    );
  });

  it('a sheet skipped before its request leaves no crop folder: no crop endpoint, a replaced drawing, the request cap (LOW-3)', async () => {
    const { verifyCircuit } = await import('./verify');
    const circuit = `${tag}-NF`;
    await circuitTable(circuit, `${tag} PID-NF`, fileId2, SHA2);
    const path = files2Path();
    const counter = { n: 0 };
    const run = async (deps: import('./verify').VerifyDeps) => {
      const r = await verifyCircuit(anchor, { circuit, kinds: ['end'] }, deps);
      return (
        (r as unknown as { output?: { not_asked?: { why: string }[] } }).output?.not_asked ?? []
      );
    };
    // The media sidecar has no crop endpoint (an older image).
    const old = await run(
      await verifyDeps(BYTES2, counter, {
        crop: async () => ({ ok: false, code: 'bad_request', message: 'unknown route' }),
      }),
    );
    expect(old.map((x) => x.why).join(' ')).toMatch(/no crop endpoint/);
    expect(await foldersAt(path)).toBe(0);
    // The drawing was replaced since its table was read.
    const replaced = await run(await verifyDeps(Buffer.from('AC1032 replaced'), counter));
    expect(replaced.length).toBeGreaterThan(0);
    expect(await foldersAt(path)).toBe(0);
    // The request cap reached before the sheet.
    const cap = check.VERIFY_MAX as { requests: number };
    const was = cap.requests;
    cap.requests = 0;
    try {
      const capped = await run(await verifyDeps(BYTES2, counter));
      expect(capped.map((x) => x.why).join(' ')).toMatch(/request cap/);
    } finally {
      cap.requests = was;
    }
    expect(await foldersAt(path)).toBe(0);
    expect(counter.n).toBe(0);
  });

  it('a claim is taken under a lock: of two at once on one circuit one passes, and it is kept', async () => {
    const t = await makeTable(`${tag} claim`);
    const circuit = `${tag}-CLAIM`;
    const at = '2026-10-25T12:00:00.000Z';
    const claimOf = (by: string) => ({
      circuit,
      by,
      at,
      sheets: [{ tableId: t, revision: 'r1' }],
      readFrom: [t],
    });
    const seen: number[] = [];
    const refusal = (runs: readonly import('./verify').VerifyRun[]) => {
      seen.push(runs.length);
      return runs.some((r) => r.circuit === circuit) ? 'already claimed' : null;
    };
    const both = await Promise.all([
      s.claimVerifyRun(anchor, claimOf('login:a'), refusal),
      s.claimVerifyRun(anchor, claimOf('login:b'), refusal),
    ]);
    expect(both.filter((r) => r === null)).toHaveLength(1);
    expect(both.filter((r) => r === 'already claimed')).toHaveLength(1);
    // The second saw the first's claim: the lock made them take turns.
    expect(seen.sort()).toEqual([0, 1]);
    const [row] = await admin`select data->${s.VERIFY_RUNS_KEY} as runs from nodes where id = ${t}`;
    expect(row!.runs).toEqual([
      { circuit, by: expect.stringMatching(/^login:[ab]$/), at, revision: 'r1' },
    ]);
    // Claims past an hour are dropped when the next is kept.
    const later = { ...claimOf('login:c'), at: '2026-10-25T14:00:00.000Z' };
    expect(await s.claimVerifyRun(anchor, later, () => null)).toBeNull();
    const [after] =
      await admin`select data->${s.VERIFY_RUNS_KEY} as runs from nodes where id = ${t}`;
    expect(after!.runs).toEqual([{ circuit, by: 'login:c', at: later.at, revision: 'r1' }]);
    // The guard's early look reads the same claims, without the lock.
    expect(await s.readVerifyRuns(anchor, [t])).toEqual([
      { tableId: t, circuit, by: 'login:c', at: later.at, revision: 'r1' },
    ]);
  });

  it('one circuit however its name is written: the lock and the claims read it alike', async () => {
    const t = await makeTable(`${tag} claim case`);
    const at = '2026-10-25T12:00:00.000Z';
    const claimOf = (circuit: string, by: string, when = at) => ({
      circuit,
      by,
      at: when,
      sheets: [{ tableId: t, revision: 'r1' }],
      readFrom: [t],
    });
    const { circuitKey } = await import('./check-keys');
    const refusal = (asked: string) => (runs: readonly import('./verify').VerifyRun[]) =>
      runs.some((r) => circuitKey(r.circuit) === circuitKey(asked)) ? 'already claimed' : null;
    const names = [`${tag}-ABC`, `${tag}-abc`, ` ${tag}-Abc `];
    const all = await Promise.all(
      names.map((n, i) => s.claimVerifyRun(anchor, claimOf(n, `login:${i}`), refusal(n))),
    );
    expect(all.filter((r) => r === null)).toHaveLength(1);
    expect(all.filter((r) => r === 'already claimed')).toHaveLength(2);
  });

  it('claims are kept per circuit, each pruned to the hour; a table rename keeps them', async () => {
    const t = await makeTable(`${tag} claim bound`);
    const base = Date.parse('2026-10-25T12:00:00.000Z');
    const claim = (circuit: string, i: number) => ({
      circuit,
      by: `login:${i}`,
      at: new Date(base + i * 1000).toISOString(),
      sheets: [{ tableId: t, revision: 'r1' }],
      readFrom: [t],
    });
    const other = `${tag}-OTHER`;
    expect(await s.claimVerifyRun(anchor, claim(other, 0), () => null)).toBeNull();
    for (let i = 1; i <= 20; i++)
      expect(await s.claimVerifyRun(anchor, claim(`${tag}-BUSY`, i), () => null)).toBeNull();
    const read = async () =>
      (await admin`select data->${s.VERIFY_RUNS_KEY} as runs from nodes where id = ${t}`)[0]!
        .runs as { circuit: string; by: string }[];
    const runs = await read();
    // The busy circuit's newest 16; the other circuit's one is kept.
    expect(runs.filter((r) => r.circuit === other)).toHaveLength(1);
    const busy = runs.filter((r) => r.circuit === `${tag}-BUSY`);
    expect(busy.map((r) => r.by)).toEqual(Array.from({ length: 16 }, (_, k) => `login:${k + 5}`));
    // A rename or an icon change merges its keys: the claims stay.
    await c.updateTable(anchor, t, { title: `${tag} renamed`, icon: 'x' });
    expect(await read()).toEqual(runs);
  });

  it('a crop is never replaced, and only a caller that may file crops deletes one', async () => {
    const files = await import('@mantle/files');
    const t = await makeTable(`${tag} crop guard`);
    const r = await s.storeChecks(
      anchor,
      sheetOf(t),
      'C-9',
      [answerOf('end:L3@1.0,0.0')],
      null,
      'z',
    );
    expect(r).toEqual({ stored: 1 });
    const [row] = await checksRows(t);
    const cropId = check.cropIdsOf(String(row!.Crops)).crops[0]!;
    const [crop] = await admin`select path::text as path, data from nodes where id = ${cropId}`;
    const filename = String((crop!.data as Row).filename);
    expect((crop!.data as Row).provenance).toBe(files.DRAWING_CHECK_PROVENANCE);
    // Replace: refused for everyone, the owner included; the bytes stay.
    await expect(
      files.upsertFile({
        ownerId: anchor,
        parentPath: String(crop!.path),
        filename,
        bytes: Buffer.from('swapped'),
        overwrite: true,
      }),
    ).rejects.toThrow(/drawing check's evidence/);
    const kept = await files.readFileById({ ownerId: anchor, fileId: cropId });
    expect(kept?.bytes.toString('utf8')).toBe('png-1');
    // Delete: a scope that manages the crop but may not change the Files
    // root is refused (403), alone or in a bulk delete.
    await admin`delete from item_grants where node_id = ${cropId}`;
    await m.withHeads([cropId], 'update', (tx) =>
      tx.execute(
        sqlTag`insert into item_grants (node_id, workspace_id, is_home) values (${cropId}, ${wsId}, true)`,
      ),
    );
    const scope = { kind: 'assistant' as const, loginId: null, ws: [wsId], modWs: [wsId] };
    const refused = await m
      .withScope(scope, () => files.deleteFileById({ ownerId: anchor, fileId: cropId }))
      .then(
        () => null,
        (e: unknown) => e as { code?: string; message?: string },
      );
    expect(refused?.code).toBe('42501');
    expect(refused?.message).toMatch(/drawing check's evidence/);
    const gate = await m.withScope(scope, () => files.bulkDeleteGate([cropId]));
    expect(gate).toEqual({ allowed: [], refused: [{ fileId: cropId, reason: 'forbidden' }] });
    expect((await admin`select 1 from nodes where id = ${cropId}`).length).toBe(1);
    // The owner (system work here) deletes it.
    expect(
      await files.deleteFileById({ ownerId: anchor, fileId: cropId, deleteDerived: true }),
    ).toEqual({ ok: true });
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
