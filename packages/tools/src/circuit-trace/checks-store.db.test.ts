/**
 * The image check's store on a real, migrated Postgres (checks-store.ts):
 * storeChecks files sealed answers on the drawing's file row, with its crops as
 * name-only image files linked to the drawing, and keeps `updated_at`.
 * storeRefusal refuses before any spend: a file the caller only reads, a
 * read-only snapshot copy, a private file, a running extract, a revision near the
 * cap. Two circuits on one drawing keep both answers. An answer filed while the
 * file read its old Table still applies once its database is built. A flip during
 * a vision call files nothing. A replace does not apply old answers to new bytes.
 * The same grids read as a Table and as a database give the same sheet.
 * The store check before the spend judges rights only: no crop folder is made
 * until answers are filed, so a sheet skipped on the way (no crop endpoint, a
 * drawing replaced since it was read, the request cap) leaves none. Made-up
 * drawing, no model is reached.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/circuit-trace/checks-store.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor, superuserExec } from '@mantle/db/test-support';

/** Runs after each file a test's call saves: a flip while the crops are made,
 *  after the store's first check and before its transaction. */
const midStore = vi.hoisted(() => ({ hook: null as null | (() => Promise<void>) }));

vi.mock('@mantle/files', async (orig) => {
  const real = await orig<typeof import('@mantle/files')>();
  return {
    ...real,
    upsertFile: async (...a: Parameters<typeof real.upsertFile>) => {
      const out = await real.upsertFile(...a);
      await midStore.hook?.();
      return out;
    },
  };
});

const URL = process.env.MANTLE_TEST_DATABASE_URL;
type Row = Record<string, unknown>;
const sha256Of = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe.skipIf(!URL)('the image check store', () => {
  let m: typeof import('@mantle/db');
  let c: typeof import('@mantle/content');
  let files: typeof import('@mantle/files');
  let build: typeof import('@mantle/content/file-database').buildFileDatabase;
  let s: typeof import('./checks-store');
  let readMod: typeof import('./read');
  let check: typeof import('./check');
  let admin: (strings: TemplateStringsArray, ...v: unknown[]) => Promise<Row[]>;
  let sqlTag: typeof import('drizzle-orm').sql;
  let anchor = '';
  const tag = `ckst${randomUUID().slice(0, 6)}`;
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-ckst-'));
  const wsId = randomUUID();
  const ids: string[] = [];
  const AT = '2026-10-25T12:00:00.000Z';
  /** The Drawing checks folders this file's calls may make, by exact path:
   *  the only folders afterAll removes. */
  const cropPaths: string[] = [];
  /** How many folders sit at or under `path` (this file's own paths only:
   *  other files share the anchor owner, so a total moves under them). */
  const foldersAt = async (at: string) =>
    (
      await admin`select count(*)::int as n from nodes
        where owner_id = ${anchor} and type = 'branch' and path <@ ${at}::ltree`
    )[0]!.n as number;

  type Drawing = { id: string; title: string; bytes: Buffer; sha: string; rev: string };
  /** A drawing as an ordinary upload, with no data source yet. */
  const drawing = async (name: string, ext = 'dwg'): Promise<Drawing> => {
    const title = `${tag} ${name}`;
    const bytes = Buffer.from(`AC1032 made-up drawing ${title}`);
    const { id } = await files.upsertFile({
      ownerId: anchor,
      parentPath: 'files',
      filename: `${tag}-${name}.${ext}`,
      title,
      bytes,
      overwrite: false,
    });
    ids.push(id);
    cropPaths.push(files.autoFiledFolderPath('drawing-checks', { document: { slug: id } }));
    const sha = sha256Of(bytes);
    return { id, title: `${tag}-${name}`, bytes, sha, rev: sha.slice(0, 16) };
  };

  const DESCRIPTION =
    'AutoCAD DWG model-space registry. ... within 2 drawing units of it ... (test)';
  const num = (name: string) => ({ name, type: 'number' as const });
  const txt = (name: string) => ({ name, type: 'text' as const });
  /** A drawing's tabs carrying one circuit: two pipe ends, each only near a tag
   *  (the guesses circuit_verify asks about), with a tab of each kind. */
  const gridsOf = (circuit: string) => {
    const layer = `Circuit ${circuit}`;
    return [
      { name: 'Layers', columns: [txt('Layer')], rows: [[layer], ['EQUIP']] },
      {
        name: 'Circuits',
        columns: [txt('Circuit'), txt('Parent'), txt('Layers'), txt('Line numbers')],
        rows: [[circuit, '', layer, '']],
      },
      {
        name: 'Segments',
        columns: [
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
        rows: [
          [layer, 'A', 0, 0, 20, 0, 20, 1, 2, 0],
          ['EQUIP', 'E1', -2, 0, -1, 0, 1, 7, 8, 0],
        ],
      },
      {
        name: 'Nodes',
        columns: [
          num('Node'),
          num('X'),
          num('Y'),
          num('Degree'),
          txt('Kind'),
          txt('Block'),
          txt('Block handle'),
          txt('Layers'),
        ],
        rows: [
          [1, 0, 0, 1, 'end', '', '', layer],
          [2, 20, 0, 1, 'end', '', '', layer],
        ],
      },
      {
        name: 'Inserts',
        columns: [
          txt('Block'),
          txt('Layer'),
          txt('Handle'),
          num('X'),
          num('Y'),
          num('Min X'),
          num('Min Y'),
          num('Max X'),
          num('Max Y'),
        ],
        rows: [['VALVE', layer, 'B1', 10, 1, 9, 0, 11, 2]],
      },
      {
        name: 'Blocks',
        columns: [txt('Block'), txt('Layer'), txt('Handle'), num('X'), num('Y'), txt('TAG')],
        rows: [['VALVE', layer, 'B1', 10, 1, 'XV-1']],
      },
      {
        name: 'Texts',
        columns: [txt('Text'), txt('Layer'), num('X'), num('Y')],
        rows: [
          ['E-101', 'EQUIP', -1, 0],
          ['V-201', 'EQUIP', 25, 0],
        ],
      },
    ];
  };

  /** The drawing's database, as the extract writes it. */
  const withDatabase = async (d: Drawing, circuit: string) => {
    const out = await build({
      fileId: d.id,
      ownerId: anchor,
      sha256: d.sha,
      bytes: d.bytes,
      filename: `${d.title}.dwg`,
      parsed: { kind: 'sheets', sheets: gridsOf(circuit) as never, description: DESCRIPTION },
    });
    expect(out).toMatchObject({ status: 'built' });
  };

  /** The drawing's old Table: the auto Table a file still has before the rebuild. */
  const withOldTable = async (
    d: Drawing,
    circuit: string,
    stamped: string | null = d.sha,
    description = DESCRIPTION,
  ) => {
    const made = await c.createTable(anchor, {
      title: d.title,
      tags: ['auto-import'],
      sourceFileId: d.id,
      ...(stamped ? { sourceSha256: stamped } : {}),
      description,
      tabs: gridsOf(circuit).map((g) => ({
        ...c.tableDocFromGrid({ columns: g.columns, rows: g.rows as never }),
        name: g.name,
      })),
    });
    ids.push(made.id);
    return made.id;
  };

  const sheetOf = (d: Drawing) => ({
    tableId: d.id,
    title: d.title,
    sourceFileId: d.id,
    revision: d.rev,
    sourceSha: d.sha,
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

  const answerOf = (key: string, verdict: 'yes' | 'no' = 'yes') => ({
    q: {
      id: 'q1',
      key,
      kind: 'end' as const,
      tableId: '',
      sheet: `${tag} PID-1`,
      sourceFileId: '',
      node: 2,
      handles: ['A1'],
      guess: 'the pipe end #2 belongs to "V-201"',
      question: 'Does the pipe end connect to "V-201"?',
      item: { id: 'q1', kind: 'point' as const, at: [1, 0] as [number, number], pad: 4 },
      pidKey: 'x:2',
      alts: ['V-202', 'break', 'continues', 'open', 'other'],
      altAsk: 'If no, give "alt".',
    },
    verdict,
    reason: 'into its nozzle',
    model: 'test/vision-model',
    crops: [{ png: Buffer.from('png-1'), part: 0, of: 1, window: [0, 0, 2, 2], textPx: 14 }],
  });

  /** The answers on a file row, read loosely as the readers do. */
  const answersOn = async (id: string) =>
    check.storedChecksOf(
      (await admin`select data->'drawingChecks' as a from nodes where id = ${id}`)[0]!.a,
    );
  const setData = (id: string, patch: Row) =>
    admin`update nodes set data = data || ${JSON.stringify(patch)}::jsonb where id = ${id}`;
  const updatedAt = async (id: string) =>
    String((await admin`select updated_at::text as u from nodes where id = ${id}`)[0]!.u);
  const cropsOf = async (id: string) =>
    (
      await admin`select id from nodes where owner_id = ${anchor} and type = 'file'
      and data->>'provenance' = ${files.DRAWING_CHECK_PROVENANCE}
      and data->>'sourceFileId' = ${id}`
    ).map((r) => String(r.id));

  /** circuit_verify's outside effects: the real store, a parser and a
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
        const qids = [...prompt.matchAll(/^(q\d+) \(/gm)].map((x) => x[1]);
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
      now: () => new Date(AT),
      ...over,
    };
  };
  type VerifyOut = {
    summary: string;
    answers: { answer: string }[];
    limits: string[];
    not_asked?: { why: string }[];
  };
  const outOf = (r: unknown) => (r as { output: VerifyOut }).output;

  const traceOf = async (circuit: string) => {
    const builtins = await import('../builtins-circuits');
    const traced = await builtins.circuitTraceHandler({ circuit }, anchor);
    expect(traced).toMatchObject({ ok: true });
    return (
      traced as {
        output: {
          checks?: { items: { trust: string }[] };
          pid: unknown;
          limits: string[];
          sheets: { tableId: string; url?: string }[];
        };
      }
    ).output;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.TABLE_DB_DIR = path.join(root, 'table-dbs');
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    m = await import('@mantle/db');
    c = await import('@mantle/content');
    files = await import('@mantle/files');
    build = (await import('@mantle/content/file-database')).buildFileDatabase;
    s = await import('./checks-store');
    readMod = await import('./read');
    check = await import('./check');
    sqlTag = (await import('drizzle-orm')).sql;
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    await m.ensureViewerRoles(admin as never, process.env.MANTLE_MASTER_KEY);
    anchor = await ensureTestAnchor(admin as never);
    // A fresh database has no Files root yet: make it, as an upload would
    // find it on a box.
    await files.ensureFilesRootBranch(anchor);
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
      and type = 'file' and data->>'sourceFileId' = any(${ids}::text[])`
      : [];
    const all = [...ids, ...crops.map((r) => String(r.id))];
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

  it('files the answers: sealed under the file id on its row, linked crops, updated_at kept', async () => {
    const d = await drawing('store');
    const sheet = sheetOf(d);
    expect(await s.storeRefusal(anchor, sheet)).toBeNull();
    const before = await updatedAt(d.id);
    const r = await s.storeChecks(anchor, sheet, 'C-1', [answerOf('end:A1@1.0,0.0')], null, AT);
    expect(r).toEqual({ stored: 1 });
    const rows = await answersOn(d.id);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      key: 'end:A1@1.0,0.0',
      answer: 'yes',
      trust: 'CHECKED BY IMAGE',
      model: 'test/vision-model',
      revision: d.rev,
      file: d.id,
    });
    // The row as the read maps it holds its seal (every field it covers).
    expect(check.sealedRow(d.id, row)).toBe(true);
    expect(check.sealedRow(d.id, { ...row, reason: 'typed' })).toBe(false);
    // Each crop's id with the sha256 of the bytes stored, sealed with the answer.
    const cropIds = check.cropIdsOf(String(row.crops)).crops;
    expect(String(row.crops)).toContain(
      check.cropCellWords(cropIds[0]!, sha256Of(Buffer.from('png-1'))),
    );
    const crops = await admin`select data from nodes where id = any(${cropIds}::uuid[])`;
    expect(crops).toHaveLength(1);
    expect(crops[0]!.data).toMatchObject({
      indexing: 'metadata',
      sourceFileId: d.id,
      revision: d.rev,
    });
    // A bumped date would void a terminal skip and queue the file again.
    expect(await updatedAt(d.id)).toBe(before);
    expect(
      await s.claimVerifyRun(anchor, claimOf('C-1', 'login:a', AT, [d]), () => null),
    ).toBeNull();
    expect(await updatedAt(d.id)).toBe(before);
  });

  const claimOf = (circuit: string, by: string, at: string, ds: Drawing[]) => ({
    circuit,
    by,
    at,
    sheets: ds.map((d) => ({ tableId: d.id, revision: 'r1' })),
    readFrom: ds.map((d) => d.id),
  });

  it('a read-only snapshot copy is refused before any spend', async () => {
    const d = await drawing('copy');
    await setData(d.id, { snapshot_of: randomUUID() });
    expect(await s.storeRefusal(anchor, sheetOf(d))).toMatch(/read-only snapshot copy/);
  });

  it('a workspace that only reads the file is refused before any spend, and one with Write is asked no more', async () => {
    const d = await drawing('read-only');
    const grant = (write: boolean) =>
      m.withHeads([d.id], 'update', async (tx) => {
        await tx.execute(sqlTag`delete from item_grants where node_id = ${d.id}`);
        await tx.execute(
          sqlTag`insert into item_grants (node_id, workspace_id, write, is_home) values (${d.id}, ${wsId}, ${write}, true)`,
        );
      });
    await grant(false);
    const scope = { kind: 'assistant' as const, loginId: null, ws: [wsId], modWs: [] };
    const why = await m.withTurnScope(scope, () => s.storeRefusal(anchor, sheetOf(d)), {
      writes: true,
    });
    // The edit refusal, first: the crop folder is never reached.
    expect(why).toMatch(/^the answers could not be stored: you may not edit its file/);
    expect(why).not.toMatch(/Auto-filed/);
    // A Write switch is the final rule: past it only the crop folder's own right.
    await grant(true);
    const past = await m.withTurnScope(scope, () => s.storeRefusal(anchor, sheetOf(d)), {
      writes: true,
    });
    expect(past).not.toMatch(/may not edit/);
    // The list in that scope reads it, with the file's own revision.
    const listed = await m.withTurnScope(scope, () => readMod.dwgSheets(anchor));
    const mine = listed.sheets.filter((x) => x.id === d.id);
    expect(mine).toEqual([]); // no data source yet: a gap, not a sheet
    expect(listed.gaps.join('\n')).toContain(d.title);
  });

  it('refuses a private file and a running extract, each before any spend', async () => {
    const d = await drawing('states');
    await setData(d.id, { indexing: 'metadata' });
    expect(await s.storeRefusal(anchor, sheetOf(d))).toMatch(/set to stay out of the brain/);
    await setData(d.id, { indexing: 'full', index_work: 'extract' });
    expect(await s.storeRefusal(anchor, sheetOf(d))).toMatch(/being read into the brain/);
    await admin`update nodes set data = data - 'index_work' where id = ${d.id}`;
    expect(await s.storeRefusal(anchor, sheetOf(d))).toBeNull();
  });

  it('the same grids as a Table and as a database give the same sheet', async () => {
    const circuit = `${tag}-SAME`;
    const d = await drawing('same');
    const tableId = await withOldTable(d, circuit);
    await withDatabase(d, circuit);
    const base = {
      id: d.id,
      title: d.title,
      sourceFileId: d.id,
      revision: d.rev,
      sourceSha: d.sha,
      source: 'current' as const,
    };
    const fromDb = await readMod.readSheet(anchor, { ...base, description: null }, circuit);
    const fromTable = await readMod.readSheet(
      anchor,
      { ...base, description: DESCRIPTION, oldTableId: tableId },
      circuit,
    );
    expect(fromDb.kind).toBe('sheet');
    // Each write gives its rows new ids, the one thing that differs, and the
    // read orders by them. The keys of the trace are handles and coordinates.
    const same = (r: typeof fromDb) => {
      if (r.kind !== 'sheet') return r;
      const byJson = <T>(list: readonly T[] | undefined) =>
        (list ?? []).map((x) => JSON.stringify(x)).sort();
      return {
        ...r.sheet,
        circuitRows: byJson(r.sheet.circuitRows.map(({ _rid, ...row }) => row)),
        segments: byJson(r.sheet.segments),
        network: byJson(r.sheet.network),
        nodes: byJson(r.sheet.nodes),
        inserts: byJson(r.sheet.inserts),
        blocks: byJson(r.sheet.blocks),
        texts: byJson(r.sheet.texts),
      };
    };
    expect(same(fromDb)).toEqual(same(fromTable));
    if (fromDb.kind !== 'sheet' || fromTable.kind !== 'sheet') return;
    // And the same trace from either.
    const { traceCircuit } = await import('./walk');
    const key = (x: typeof fromDb.sheet) => {
      const t = traceCircuit(circuit, [x]);
      return { sheets: t.sheets.map((w) => w.runs), guesses: t.guesses, limits: t.limits };
    };
    expect(key(fromDb.sheet)).toEqual(key(fromTable.sheet));
    // Real rows, every tab: not two empty sheets.
    expect(fromDb.sheet.segments).toHaveLength(1);
    expect(fromDb.sheet.network).toHaveLength(1);
    expect(fromDb.sheet.nodes).toHaveLength(2);
    expect(fromDb.sheet.inserts).toHaveLength(1);
    expect(fromDb.sheet.blocks).toEqual([expect.objectContaining({ attribs: { TAG: 'XV-1' } })]);
    expect(fromDb.sheet.texts).toHaveLength(2);
    expect(fromDb.sheet.circuitRows).toHaveLength(1);
    // The description from `_meta`: its near distance, not a computed one.
    expect(fromDb.sheet.near).toBe(2);
    // The link goes to the file.
    expect(fromDb.sheet.url).toContain(d.id);
  });

  it('two circuits on one drawing keep both answers, at once', async () => {
    const d = await drawing('two-circuits');
    const one = (circuit: string) =>
      s.storeChecks(anchor, sheetOf(d), circuit, [answerOf('end:K@1.0,0.0')], null, AT);
    const all = await Promise.all([one(`${tag}-A`), one(`${tag}-B`), one(`${tag}-C`)]);
    expect(all).toEqual([{ stored: 1 }, { stored: 1 }, { stored: 1 }]);
    const rows = await answersOn(d.id);
    expect(rows.map((r) => r.circuit).sort()).toEqual([`${tag}-A`, `${tag}-B`, `${tag}-C`]);
    expect(rows.every((r) => check.sealedRow(d.id, r))).toBe(true);
    // The same guess asked again replaces its own answer, not the others'.
    await s.storeChecks(
      anchor,
      sheetOf(d),
      `${tag}-A`,
      [answerOf('end:K@1.0,0.0', 'no')],
      null,
      'z',
    );
    const after = await answersOn(d.id);
    expect(after).toHaveLength(3);
    expect(after.find((r) => r.circuit === `${tag}-A`)!.answer).toBe('no');
    // Read by circuit, however its name is written.
    expect(await readMod.readCircuitChecks(anchor, d.id, ` ${tag}-b `)).toHaveLength(1);
  });

  it('an answer filed on the old Table still applies after the database is built, and is not asked again', async () => {
    const circuit = `${tag}-FB`;
    const d = await drawing('fallback');
    await withOldTable(d, circuit);
    const { verifyCircuit } = await import('./verify');
    const counter = { n: 0 };
    const deps = await verifyDeps(d.bytes, counter);
    const first = await verifyCircuit(anchor, { circuit, kinds: ['end'] }, deps);
    expect(first).toMatchObject({ ok: true });
    expect(counter.n).toBe(1);
    expect(outOf(first).answers.map((a) => a.answer)).toEqual(['yes']);
    expect(outOf(first).summary).toMatch(/Stored on each drawing's file/);
    // Nothing went to the Table: no Checks tab.
    const tableRow =
      await admin`select id from nodes where data->>'sourceFileId' = ${d.id} and type = 'table'`;
    const { tableSqlSurface } = await import('@mantle/content/table-storage');
    const surface = await tableSqlSurface(anchor, String(tableRow[0]!.id));
    expect(surface!.tabs.map((t) => t.name)).not.toContain('Checks');
    // circuit_trace reads it back through the real read and applies it.
    const onTable = await traceOf(circuit);
    expect(onTable.checks?.items.map((x) => x.trust)).toEqual(['CHECKED BY IMAGE']);
    expect(JSON.stringify(onTable.pid)).toContain('NEAR V-201 (CHECKED BY IMAGE)');
    expect(onTable.limits.join(' ')).not.toMatch(/no circuit_verify seal/);

    // The database is built: the same answer, on the same guess.
    await withDatabase(d, circuit);
    const listed = (await readMod.dwgSheets(anchor)).sheets.find((x) => x.id === d.id)!;
    expect(listed.oldTableId ?? null).toBeNull();
    const onDb = await traceOf(circuit);
    expect(onDb.checks?.items.map((x) => x.trust)).toEqual(['CHECKED BY IMAGE']);
    expect(JSON.stringify(onDb.pid)).toContain('NEAR V-201 (CHECKED BY IMAGE)');

    // A second call does not pay for the answered question again.
    const second = await verifyCircuit(anchor, { circuit, kinds: ['end'] }, deps);
    expect(second).toMatchObject({ ok: true });
    expect(counter.n).toBe(1);
    expect(outOf(second).summary).toMatch(/no unanswered guess/);
  });

  it('a revision near the cap is refused before the vision call; an older revision does not count', async () => {
    const circuit = `${tag}-CAP`;
    const d = await drawing('cap');
    await withDatabase(d, circuit);
    const { verifyCircuit } = await import('./verify');
    const filler = (revision: string, bytes: number) => {
      const one = { key: `k`, revision, circuit: 'other', reason: 'x'.repeat(4000) };
      return Array.from({ length: Math.ceil(bytes / 4100) }, (_, i) => ({ ...one, key: `k${i}` }));
    };
    // One call's margin from the cap, at the current revision.
    const near = s.ANSWERS_CAP_BYTES - s.ANSWERS_CALL_MARGIN_BYTES + 4100;
    await setData(d.id, { drawingChecks: filler(d.rev, near) });
    const counter = { n: 0 };
    const refused = await verifyCircuit(
      anchor,
      { circuit, kinds: ['end'] },
      await verifyDeps(d.bytes, counter),
    );
    expect(refused.ok).toBe(false);
    expect((refused as { error: string }).error).toMatch(/already holds \d+ answers/);
    expect(counter.n).toBe(0);
    expect(await cropsOf(d.id)).toEqual([]);

    // The same bytes at an older revision: it goes first, and the call runs.
    await setData(d.id, { drawingChecks: filler('oldrev', s.ANSWERS_CAP_BYTES) });
    const ok = await verifyCircuit(
      anchor,
      { circuit, kinds: ['end'] },
      await verifyDeps(d.bytes, counter),
    );
    expect(ok).toMatchObject({ ok: true });
    expect(counter.n).toBe(1);
    const held = await answersOn(d.id);
    expect(new Set(held.map((r) => r.revision))).toEqual(new Set([d.rev]));
  });

  it('a flip during the vision call files nothing, and no crop stays', async () => {
    const circuit = `${tag}-FLIP`;
    const d = await drawing('flip');
    await withDatabase(d, circuit);
    const { verifyCircuit } = await import('./verify');
    const counter = { n: 0 };
    const base = await verifyDeps(d.bytes, counter);
    const r = await verifyCircuit(
      anchor,
      { circuit, kinds: ['end'] },
      {
        ...base,
        ask: async (images, prompt) => {
          await setData(d.id, { indexing: 'metadata' });
          return base.ask(images, prompt);
        },
      },
    );
    expect(r).toMatchObject({ ok: true });
    expect(counter.n).toBe(1);
    expect(outOf(r).limits.join(' ')).toMatch(/could not be stored on its file/);
    expect(outOf(r).summary).toMatch(/Nothing was stored/);
    expect(await answersOn(d.id)).toEqual([]);
    expect(await cropsOf(d.id)).toEqual([]);
  });

  it('a flip after the first check is caught inside the transaction: its own flag, and a folder it reads', async () => {
    const d = await drawing('flip-late');
    midStore.hook = async () => {
      await setData(d.id, { indexing: 'metadata' });
    };
    try {
      const r = await s.storeChecks(anchor, sheetOf(d), 'C-L', [answerOf('k')], null, AT);
      expect(r).toEqual({ error: expect.stringMatching(/set to stay out of the brain during/) });
    } finally {
      midStore.hook = null;
    }
    expect(await answersOn(d.id)).toEqual([]);
    expect(await cropsOf(d.id)).toEqual([]);
    // The claim refuses a private file too: nothing is filed on it, nothing spent.
    expect(await s.claimVerifyRun(anchor, claimOf('C-L', 'login:a', AT, [d]), () => null)).toMatch(
      /stay out of the brain/,
    );

    const folder = await files.createFolder({
      ownerId: anchor,
      parentPath: 'files',
      slug: `${tag}-flagged`,
    });
    ids.push(folder.id);
    const bytes = Buffer.from(`AC1032 ${tag} in a folder`);
    const inside = await files.upsertFile({
      ownerId: anchor,
      parentPath: folder.path,
      filename: `${tag}-inside.dwg`,
      bytes,
      overwrite: false,
    });
    ids.unshift(inside.id);
    const sha = sha256Of(bytes);
    const e: Drawing = { id: inside.id, title: 'inside', bytes, sha, rev: sha.slice(0, 16) };
    cropPaths.push(files.autoFiledFolderPath('drawing-checks', { document: { slug: e.id } }));
    midStore.hook = async () => {
      await setData(folder.id, { indexing: 'metadata' });
    };
    try {
      const r = await s.storeChecks(anchor, sheetOf(e), 'C-L', [answerOf('k')], null, AT);
      expect(r).toEqual({ error: expect.stringMatching(/set to stay out of the brain during/) });
    } finally {
      midStore.hook = null;
    }
    expect(await answersOn(e.id)).toEqual([]);
  });

  it('a replace does not apply old answers to new bytes; they are asked again', async () => {
    const circuit = `${tag}-REP`;
    const d = await drawing('replace');
    await withDatabase(d, circuit);
    const { verifyCircuit } = await import('./verify');
    const counter = { n: 0 };
    expect(
      await verifyCircuit(anchor, { circuit, kinds: ['end'] }, await verifyDeps(d.bytes, counter)),
    ).toMatchObject({ ok: true });
    const old = await answersOn(d.id);
    expect(old).toHaveLength(1);

    const newBytes = Buffer.from(`AC1032 replaced ${tag}`);
    await files.upsertFile({
      ownerId: anchor,
      parentPath: 'files',
      filename: `${d.title}.dwg`,
      bytes: newBytes,
      overwrite: true,
    });
    const sha = sha256Of(newBytes);
    // Mid replace: the new bytes have no name yet. It gives no sheet, and says so.
    const gaps = (await readMod.dwgSheets(anchor)).gaps.join('\n');
    expect(gaps).toMatch(new RegExp(`${d.title}: gives no sheet.*No database yet`));
    // A replace stamps the extract: circuit_verify waits for it.
    const next: Drawing = { ...d, bytes: newBytes, sha, rev: sha.slice(0, 16) };
    expect(await s.storeRefusal(anchor, sheetOf(next))).toMatch(/being read into the brain/);
    await admin`update nodes set data = data - 'index_work' where id = ${d.id}`;

    await withDatabase(next, circuit);
    const traced = await traceOf(circuit);
    expect(traced.checks).toBeUndefined();
    expect(traced.limits.join(' ')).toMatch(
      /an older revision of the drawing are kept on its file/,
    );
    // The old answer's seal holds: only its revision is not these bytes.
    expect(check.sealedRow(d.id, (await answersOn(d.id))[0]!)).toBe(true);
    const again = await verifyCircuit(
      anchor,
      { circuit, kinds: ['end'] },
      await verifyDeps(newBytes, counter, { now: () => new Date('2026-10-25T13:00:00.000Z') }),
    );
    expect(again).toMatchObject({ ok: true });
    expect(counter.n).toBe(2);
    expect((await answersOn(d.id)).map((r) => r.revision).sort()).toEqual([d.rev, next.rev].sort());
  });

  it('a file still on an old Table keeps its stale and unstamped refusals; a database has neither', async () => {
    const circuit = `${tag}-STALE`;
    const d = await drawing('stale');
    await withOldTable(d, circuit, 'b'.repeat(64));
    const { verifyCircuit } = await import('./verify');
    const counter = { n: 0 };
    const stale = await verifyCircuit(
      anchor,
      { circuit, kinds: ['end'] },
      await verifyDeps(d.bytes, counter),
    );
    expect(stale.ok).toBe(false);
    expect((stale as { error: string }).error).toMatch(/replaced after its table was built/);

    const u = await drawing('unstamped');
    await withOldTable(u, `${circuit}-U`, null);
    const unstamped = await verifyCircuit(
      anchor,
      { circuit: `${circuit}-U`, kinds: ['end'] },
      await verifyDeps(u.bytes, counter),
    );
    expect((unstamped as { error: string }).error).toMatch(/imported before tables recorded/);

    await withDatabase(d, circuit);
    expect(
      await verifyCircuit(anchor, { circuit, kinds: ['end'] }, await verifyDeps(d.bytes, counter)),
    ).toMatchObject({ ok: true });
  });

  it('a refused file with an old Table is left out and said; a file with neither source is named', async () => {
    const circuit = `${tag}-OUT`;
    const d = await drawing('refused');
    await withOldTable(d, circuit);
    await setData(d.id, { indexing: 'metadata' });
    const listed = await readMod.dwgSheets(anchor);
    expect(listed.sheets.map((x) => x.id)).not.toContain(d.id);
    expect(listed.gaps.join('\n')).toMatch(
      new RegExp(`${d.title}: left out of this trace\\. This file is set to stay out`),
    );
    const traced = await traceOf(circuit);
    expect(traced.sheets).toEqual([]);

    // A `.none` gives its reason, and a DWF is not listed at all.
    const none = await drawing('none');
    await files.writeFileDbNone(none.id, none.sha, 'too-large');
    const dwf = await files.upsertFile({
      ownerId: anchor,
      parentPath: 'files',
      filename: `${tag}-plan.dwf`,
      bytes: Buffer.from('dwf'),
      overwrite: false,
    });
    ids.push(dwf.id);
    const after = await readMod.dwgSheets(anchor);
    expect(after.gaps.join('\n')).toMatch(
      new RegExp(`${none.title}: gives no sheet.*too large to read into a database`),
    );
    expect(after.gaps.join('\n')).not.toContain(`${tag}-plan`);
    // A drive-synced file has no data.filename: its title says it is a drawing.
    const synced = await drawing('synced');
    await admin`update nodes set data = data - 'filename' where id = ${synced.id}`;
    await admin`update nodes set title = ${`${synced.title}.DXF`} where id = ${synced.id}`;
    expect((await readMod.dwgSheets(anchor)).gaps.join('\n')).toContain(`${synced.title}: gives`);
  });

  it('a DGN is a drawing: its old MicroStation Table is found, its sheet named without .dgn', async () => {
    const d = await drawing('unit', 'dgn');
    const table = await withOldTable(
      d,
      `${tag}-DGN`,
      d.sha,
      'MicroStation DGN model-space registry. ... (test)',
    );
    const sheet = (await readMod.dwgSheets(anchor)).sheets.find((x) => x.id === d.id);
    expect(sheet).toMatchObject({ title: `${tag}-unit`, oldTableId: table, source: 'current' });
  });

  it('drawings never read (no reader when they came) sort last: they cannot crowd readable drawings out', async () => {
    // MAX_TABLES drawings from yesterday, and newer ones that hold a current
    // no_parser stamp (old DGN files after the roll).
    const first = await drawing('crowd-0');
    const made =
      await admin`insert into nodes (owner_id, parent_id, type, title, slug, data, path, tags,
        home_ws, read_ws, write_ws, login_id, updated_at)
      select owner_id, parent_id, type, title || ' ' || g, slug || '-' || g,
        jsonb_set(data, '{filename}', to_jsonb(${`${tag}-crowd-`}::text || g || '.dwg')),
        path, tags, home_ws, read_ws, write_ws, login_id, now() - interval '1 day'
      from nodes, generate_series(1, ${readMod.MAX_TABLES}) g where id = ${first.id} returning id`;
    ids.push(...made.map((r) => String(r.id)));
    const unread: string[] = [];
    for (const n of [1, 2, 3]) {
      const f = await files.upsertFile({
        ownerId: anchor,
        parentPath: 'files',
        filename: `${tag}-unread-${n}.dgn`,
        bytes: Buffer.from(`made-up design file ${n}`),
        overwrite: false,
      });
      ids.push(f.id);
      unread.push(`${tag}-unread-${n}`);
      await admin`update nodes set updated_at = now() + interval '1 hour',
        data = data || jsonb_build_object('extract_skipped',
          jsonb_build_object('reason', 'no_parser', 'at', now() + interval '2 hours'))
        where id = ${f.id}`;
    }
    const listed = await readMod.dwgSheets(anchor);
    const gaps = listed.gaps.join('\n');
    expect(listed.more).toBe(true);
    expect(gaps).toContain(`${tag}-crowd-1: gives no sheet`);
    for (const name of unread) expect(gaps).not.toContain(`${name}:`);
    // Written since its stamp (renamed, edited): a drawing like any other
    // again, newest first, as it will be read again.
    await admin`update nodes set updated_at = now() + interval '3 hours' where id = ${ids.at(-1)!}`;
    const again = (await readMod.dwgSheets(anchor)).gaps.join('\n');
    expect(again).toContain(`${unread[2]}: gives no sheet`);
    expect(again).not.toContain(`${unread[0]}:`);
    // Out of the window for the tests below.
    await admin`delete from nodes where id = any(${[...made.map((r) => String(r.id)), first.id]}::uuid[])`;
  });

  it('the list selects keys, not the whole data', async () => {
    const d = await drawing('keys');
    await withDatabase(d, `${tag}-KEYS`);
    await setData(d.id, { drawingChecks: [{ key: 'x', reason: 'SHOULD-NOT-BE-READ' }] });
    const spy = vi.spyOn(files, 'fileDbSqlitePath');
    const listed = await readMod.dwgSheets(anchor);
    spy.mockRestore();
    expect(JSON.stringify(listed)).not.toContain('SHOULD-NOT-BE-READ');
  });

  it('neither store check makes a folder (dry run or real); filing makes it at the same path', async () => {
    const d = await drawing('dry');
    const at = files.autoFiledFolderPath('drawing-checks', { document: { slug: d.id } });
    expect(await s.storeRefusal(anchor, sheetOf(d), { dryRun: true })).toBeNull();
    expect(await foldersAt(at)).toBe(0);
    // The real pass before the spend judges rights only (LOW-3).
    expect(await s.storeRefusal(anchor, sheetOf(d))).toBeNull();
    expect(await foldersAt(at)).toBe(0);
    expect(await s.storeChecks(anchor, sheetOf(d), 'C-1', [answerOf('k-dry')], null, AT)).toEqual({
      stored: 1,
    });
    expect(await files.folderByPath({ ownerId: anchor, path: at })).not.toBeNull();
  });

  it('a sheet skipped before its request leaves no crop folder: a failed crop, a replaced drawing, the request cap (LOW-3)', async () => {
    const { verifyCircuit } = await import('./verify');
    const circuit = `${tag}-NF`;
    const d = await drawing('nf');
    await withDatabase(d, circuit);
    const at = files.autoFiledFolderPath('drawing-checks', { document: { slug: d.id } });
    const counter = { n: 0 };
    const run = async (deps: import('./verify').VerifyDeps) => {
      const r = await verifyCircuit(anchor, { circuit, kinds: ['end'] }, deps);
      // A refusal or an empty result names itself here, not as an empty list.
      expect(r).toMatchObject({ ok: true, output: { not_asked: expect.any(Array) } });
      return (r as unknown as { output: { not_asked: { why: string }[] } }).output.not_asked;
    };
    // The parser could not crop the drawing.
    const old = await run(
      await verifyDeps(d.bytes, counter, {
        crop: async () => ({
          ok: false,
          code: 'failed',
          message: 'no converter produced a parseable DXF',
          retryable: false,
          terminal: false,
        }),
      }),
    );
    expect(old.map((x) => x.why).join(' ')).toMatch(/could not be cropped/);
    expect(await foldersAt(at)).toBe(0);
    // The drawing was replaced since it was read.
    const replaced = await run(await verifyDeps(Buffer.from('AC1032 replaced'), counter));
    expect(replaced.length).toBeGreaterThan(0);
    expect(await foldersAt(at)).toBe(0);
    // The request cap reached before the sheet.
    const cap = check.VERIFY_MAX as { requests: number };
    const was = cap.requests;
    cap.requests = 0;
    try {
      const capped = await run(await verifyDeps(d.bytes, counter));
      expect(capped.map((x) => x.why).join(' ')).toMatch(/request cap/);
    } finally {
      cap.requests = was;
    }
    expect(await foldersAt(at)).toBe(0);
    expect(counter.n).toBe(0);
  });

  it('a claim is taken under a lock: of two at once on one circuit one passes, and it is kept', async () => {
    const d = await drawing('claim');
    const circuit = `${tag}-CLAIM`;
    const seen: number[] = [];
    const refusal = (runs: readonly import('./verify').VerifyRun[]) => {
      seen.push(runs.length);
      return runs.some((r) => r.circuit === circuit) ? 'already claimed' : null;
    };
    const both = await Promise.all([
      s.claimVerifyRun(anchor, claimOf(circuit, 'login:a', AT, [d]), refusal),
      s.claimVerifyRun(anchor, claimOf(circuit, 'login:b', AT, [d]), refusal),
    ]);
    expect(both.filter((r) => r === null)).toHaveLength(1);
    expect(both.filter((r) => r === 'already claimed')).toHaveLength(1);
    // The second saw the first's claim: the lock made them take turns.
    expect(seen.sort()).toEqual([0, 1]);
    const [row] =
      await admin`select data->${s.VERIFY_RUNS_KEY} as runs from nodes where id = ${d.id}`;
    expect(row!.runs).toEqual([
      { circuit, by: expect.stringMatching(/^login:[ab]$/), at: AT, revision: 'r1' },
    ]);
    // Claims past an hour are dropped when the next is kept.
    const at2 = '2026-10-25T14:00:00.000Z';
    expect(
      await s.claimVerifyRun(anchor, claimOf(circuit, 'login:c', at2, [d]), () => null),
    ).toBeNull();
    const [after] =
      await admin`select data->${s.VERIFY_RUNS_KEY} as runs from nodes where id = ${d.id}`;
    expect(after!.runs).toEqual([{ circuit, by: 'login:c', at: at2, revision: 'r1' }]);
    // The guard's early look reads the same claims, without the lock.
    expect(await s.readVerifyRuns(anchor, [d.id])).toEqual([
      { tableId: d.id, circuit, by: 'login:c', at: at2, revision: 'r1' },
    ]);
  });

  it('one circuit however its name is written: the lock and the claims read it alike', async () => {
    const d = await drawing('claim-case');
    const { circuitKey } = await import('./check-keys');
    const refusal = (asked: string) => (runs: readonly import('./verify').VerifyRun[]) =>
      runs.some((r) => circuitKey(r.circuit) === circuitKey(asked)) ? 'already claimed' : null;
    const names = [`${tag}-ABC`, `${tag}-abc`, ` ${tag}-Abc `];
    const all = await Promise.all(
      names.map((n, i) => s.claimVerifyRun(anchor, claimOf(n, `login:${i}`, AT, [d]), refusal(n))),
    );
    expect(all.filter((r) => r === null)).toHaveLength(1);
    expect(all.filter((r) => r === 'already claimed')).toHaveLength(2);
  });

  it('claims are kept per circuit, each pruned to the hour', async () => {
    const d = await drawing('claim-bound');
    const base = Date.parse(AT);
    const claim = (circuit: string, i: number) =>
      claimOf(circuit, `login:${i}`, new Date(base + i * 1000).toISOString(), [d]);
    const other = `${tag}-OTHER`;
    expect(await s.claimVerifyRun(anchor, claim(other, 0), () => null)).toBeNull();
    for (let i = 1; i <= 20; i++)
      expect(await s.claimVerifyRun(anchor, claim(`${tag}-BUSY`, i), () => null)).toBeNull();
    const read = async () =>
      (await admin`select data->${s.VERIFY_RUNS_KEY} as runs from nodes where id = ${d.id}`)[0]!
        .runs as { circuit: string; by: string }[];
    const runs = await read();
    // The busy circuit's newest 16; the other circuit's one is kept.
    expect(runs.filter((r) => r.circuit === other)).toHaveLength(1);
    const busy = runs.filter((r) => r.circuit === `${tag}-BUSY`);
    expect(busy.map((r) => r.by)).toEqual(Array.from({ length: 16 }, (_, k) => `login:${k + 5}`));
  });

  it('a crop is never replaced, and only a caller that may file crops deletes one', async () => {
    const d = await drawing('crop-guard');
    const r = await s.storeChecks(
      anchor,
      sheetOf(d),
      'C-9',
      [answerOf('end:L3@1.0,0.0')],
      null,
      'z',
    );
    expect(r).toEqual({ stored: 1 });
    const [row] = await answersOn(d.id);
    const cropId = check.cropIdsOf(String(row!.crops)).crops[0]!;
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
});
