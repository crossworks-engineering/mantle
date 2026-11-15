/**
 * The sketch read of a scanned drawing, on a real migrated Postgres and a
 * real files root: when it runs, what it asks the vision worker, what it
 * writes, and that it runs once. The parser is faked at the fetch and
 * counted: the sketch read's own kit jobs (`/pdf/drawing`, `/pdf/pieces`)
 * answer made-up facts and pieces, and an upload's `pipelineRun` jobs run
 * the real steps of pdf-router and drawing-pdf in this process on the same
 * made-up facts. The vision worker is a stand-in that is counted. Made-up
 * values.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/api/src/agent/extract/pdf-sketch.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';
import { inProcessPipelineFetch } from '@mantle/files/pipelines/test-job';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({
  /** The cost guard's answer, and whether a vision worker is wired. */
  allowed: true,
  worker: true,
  /** Each vision call's prompt and file name, and the answers by call. */
  vision: [] as {
    prompt: string;
    filename: string;
    maxTokens?: number;
    leastThinking?: boolean;
  }[],
  answers: [] as ({ ran: boolean; text: string } | undefined)[],
  /** The page facts every read of the page facts gives (both paths). */
  drawing: null as unknown,
  /** Every parser route and every vision call, in the order they ran. */
  order: [] as string[],
  /** The pieces job answers 503: a parser that is busy or down. */
  piecesDown: false,
}));

vi.mock('@mantle/files/readers/pdf-drawing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/files/readers/pdf-drawing')>();
  return { ...actual, readPdfDrawingInJob: async () => structuredClone(h.drawing) };
});

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  return {
    ...actual,
    llmWorkAllowed: async () => h.allowed,
    getDefaultWorker: async (owner: string, kind: string) =>
      kind === 'vision'
        ? h.worker
          ? ({ id: 'w', slug: 'vision', model: 'made-up-vision' } as never)
          : null
        : actual.getDefaultWorker(owner, kind as never),
  };
});
vi.mock('@mantle/runtime/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/runtime/agent')>();
  return {
    ...actual,
    runVisionWorker: async (opts: {
      prompt?: string;
      filename?: string | null;
      maxTokens?: number;
      leastThinking?: boolean;
    }) => {
      const answer = h.answers[h.vision.length] ?? { ran: true, text: '' };
      h.order.push('vision');
      h.vision.push({
        prompt: opts.prompt ?? '',
        filename: opts.filename ?? '',
        maxTokens: opts.maxTokens,
        leastThinking: opts.leastThinking,
      });
      return {
        ran: answer.ran,
        text: answer.text,
        note: answer.ran ? null : 'Vision worker failed: made up',
        model: 'made-up-vision',
      };
    },
  };
});

describe.skipIf(!URL)('the sketch read of a scanned drawing', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let f: typeof import('@mantle/files');
  let sqlTag: typeof import('drizzle-orm').sql;
  let maybeAutoTableSpreadsheet: typeof import('./auto-table').maybeAutoTableSpreadsheet;
  let sketchIngestPdfNode: typeof import('./pdf-sketch').sketchIngestPdfNode;
  let scratch: { url: string; drop: () => Promise<void> } | undefined;
  let anchor: string;
  const team = randomUUID();
  const FOLDER = 'files.sketch';
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-sketch-'));
  const parserCalls: string[] = [];
  /** Each request as `route options`, the options as sent; never cleared by scanFile. */
  const parserOpts: string[] = [];
  let kind = 'scan';
  let pieces: unknown[] = [];

  const su = async (q: ReturnType<typeof sqlTag>) =>
    (await import('@mantle/db/test-support')).superuserExec(scratch!.url, q);
  const x = async <T>(q: ReturnType<typeof sqlTag>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const unique = () => `${randomUUID().slice(0, 8)}.pdf`;
  const upload = (bytes: string) =>
    m.withCreateHome({ createWs: team, privateWs: null }, () =>
      f.upsertFile({
        ownerId: anchor,
        parentPath: FOLDER,
        filename: unique(),
        bytes: Buffer.from(bytes),
        overwrite: true,
      }),
    );
  const nodeRow = async (id: string) => {
    const { eq } = await import('drizzle-orm');
    const [row] = await m.db.select().from(m.nodes).where(eq(m.nodes.id, id)).limit(1);
    return row!;
  };
  const shaOf = async (id: string) =>
    ((await nodeRow(id)).data as Record<string, unknown>).sha256 as string;
  const namesOf = (id: string) =>
    existsSync(f.fileDbsDir()) ? readdirSync(f.fileDbsDir()).filter((n) => n.startsWith(id)) : [];
  const rowsOf = async (id: string, q: string) => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const db = new DatabaseSync(f.fileDbPaths(id, await shaOf(id))!.sqlite, { readOnly: true });
    try {
      return db.prepare(q).all() as Record<string, unknown>[];
    } finally {
      db.close();
    }
  };
  /** A scan PDF with its model-free database, as the file database pass leaves it. */
  const scanFile = async (bytes: string) => {
    const file = await upload(bytes);
    await maybeAutoTableSpreadsheet(await nodeRow(file.id), anchor);
    parserCalls.length = 0;
    return file;
  };
  const read = async (id: string) => sketchIngestPdfNode(await nodeRow(id), anchor);

  const PAGE = (n: number) => ({
    page: n,
    status: 'ok',
    class: 'scan',
    size: 'a4',
    widthMm: 297,
    heightMm: 210,
    rotate: 0,
    chars: 0,
    runs: 0,
    hiddenShare: 0,
    imageCover: 1,
    segments: 0,
    axes: null,
    tagLike: 0,
    instruments: 0,
    lineNumbers: 0,
    markups: 0,
    markupsWithText: 0,
    kind: 'scan',
    kindFrom: 'picture',
    eye: null,
  });
  const png = Buffer.from('a made-up picture').toString('base64');
  const box = (y: number) => [0.1, y, 0.3, y + 0.02];
  /** Two pages: the first with three pieces in two pictures, the second not drawn. */
  const TWO_PAGES = [
    {
      page: 1,
      status: 'ok',
      dpi: 300,
      pieces: [
        { box: box(0.1), picture: 0, scale: 1 },
        { box: box(0.2), picture: 0, scale: 1 },
        { box: box(0.3), picture: 1, scale: 1 },
      ],
      notSent: [box(0.9)],
      pictures: [png, png],
    },
    { page: 2, status: 'no_picture' },
  ];

  beforeAll(async () => {
    scratch = await (await import('@mantle/db/test-support')).createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(root, 'tables');
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    mkdirSync(process.env.MANTLE_FILES_ROOT, { recursive: true });
    m = await import('@mantle/db');
    f = await import('@mantle/files');
    sqlTag = (await import('drizzle-orm')).sql;
    ({ maybeAutoTableSpreadsheet } = await import('./auto-table'));
    ({ sketchIngestPdfNode } = await import('./pdf-sketch'));
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    anchor = await ensureTestAnchor(admin);
    await su(sqlTag`insert into workspaces (id, owner_id, name)
      values (${team}, ${anchor}, ${`team ${team.slice(0, 8)}`})`);
    await su(sqlTag`insert into workspaces (owner_id, name, is_admin)
      select ${anchor}::uuid, 'Admin', true where mantle_ws_admin_id(${anchor}::uuid) is null`);
    await x(sqlTag`insert into nodes (owner_id, type, title, slug, path)
      values (${anchor}, 'branch', 'files', 'files', 'files') on conflict do nothing`);
    await m.withCreateHome({ createWs: team, privateWs: null }, () =>
      m.withNodeInsertHeads(anchor, [{ type: 'branch', path: FOLDER }], (tx) =>
        tx.execute(sqlTag`insert into nodes (id, owner_id, type, title, path)
          values (${randomUUID()}, ${anchor}, 'branch', ${FOLDER}, ${FOLDER}::ltree)`),
      ),
    );
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    parserCalls.length = 0;
    kind = 'scan';
    pieces = TWO_PAGES;
    h.allowed = true;
    h.worker = true;
    h.vision.length = 0;
    h.answers = [];
    h.order.length = 0;
    h.piecesDown = false;
    f.resetParserFailures();
    vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
    const run = inProcessPipelineFetch();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const route = String(url).replace('http://parser.test:8095', '');
        const length = Number(new Headers(init?.headers).get('x-parser-opts-length'));
        const sent = Buffer.from(await new Response(init?.body).arrayBuffer());
        const opts = sent.subarray(0, length).toString('utf8');
        h.drawing = {
          numPages: 2,
          pageCountMayBeShort: false,
          largeImageNotRead: false,
          allRead: true,
          kind,
          sample: '',
          pages: [PAGE(1), PAGE(2)],
        };
        if (route === '/pipeline/run') {
          // An upload's job: `id step`, and the options as sent.
          const o = JSON.parse(opts) as { id: string; request: { step: number; options: unknown } };
          parserCalls.push(`${o.id} ${o.request.step}`);
          parserOpts.push(`${o.id} ${JSON.stringify(o.request.options)}`);
          return run(url, { ...init, body: sent });
        }
        parserCalls.push(route);
        parserOpts.push(`${route} ${opts}`);
        h.order.push(route);
        if (route === '/pdf/pieces' && h.piecesDown) return new Response('busy', { status: 503 });
        if (route === '/pdf/pieces') return Response.json({ ok: true, pages: pieces });
        return Response.json({ ok: true, ...(h.drawing as object) });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('reads each packed picture once, writes the rows over the same database, and gives the text', async () => {
    const file = await scanFile('a made-up scan, read');
    expect(await rowsOf(file.id, `SELECT "Kind", "Vision read" FROM "File"`)).toEqual([
      { Kind: 'scan', 'Vision read': 0 },
    ]);
    h.answers = [
      { ran: true, text: '1: FT-101 4"-P-1001-A1B\n2:' },
      { ran: true, text: '3: U2-E-12A' },
    ];
    const out = await read(file.id);
    // The parser twice (the page facts, the pieces), the model once a
    // picture. After the write, Site tags (on in every workspace) runs its
    // one model-free job on the new Texts.
    expect(parserCalls).toEqual(['/pdf/drawing', '/pdf/pieces', 'site-tags 1']);
    expect(h.vision.map((v) => v.filename.replace(/^.*#/, ''))).toEqual([
      'page-1-part-1.png',
      'page-1-part-2.png',
    ]);
    expect(h.vision[0]!.prompt).toBe(f.SKETCH_PROMPT);
    // Every call asks for the least thinking: the answer cap is tight.
    expect(h.vision.every((v) => v.leastThinking === true)).toBe(true);
    // One name, the same one: the database of these bytes, written again.
    expect(namesOf(file.id)).toHaveLength(1);
    expect(
      await rowsOf(
        file.id,
        `SELECT "Kind", "Vision read", "Vision model", "Scan pages read" FROM "File"`,
      ),
    ).toEqual([
      { Kind: 'scan', 'Vision read': 1, 'Vision model': 'made-up-vision', 'Scan pages read': 1 },
    ]);
    expect(
      await rowsOf(file.id, `SELECT "Page", "Vision status", "Pieces", "Pieces read" FROM "Pages"`),
    ).toEqual([
      { Page: 1, 'Vision status': 'ok', Pieces: 3, 'Pieces read': 2 },
      { Page: 2, 'Vision status': 'no_picture', Pieces: 0, 'Pieces read': 0 },
    ]);
    expect(
      await rowsOf(file.id, `SELECT "Text", "Source" FROM "Texts" ORDER BY "Line", "Text"`),
    ).toEqual([
      { Text: '4"-P-1001-A1B', Source: 'ocr' },
      { Text: 'FT-101', Source: 'ocr' },
      { Text: 'U2-E-12A', Source: 'ocr' },
    ]);
    expect(
      await rowsOf(file.id, `SELECT "Tag", "Source", "Confidence" FROM "Tags" ORDER BY "Tag"`),
    ).toEqual([
      { Tag: 'FT-101', Source: 'ocr', Confidence: 0.65 },
      { Tag: 'U2-E-12A', Source: 'ocr', Confidence: 0.6 },
    ]);
    expect(await rowsOf(file.id, `SELECT "Why" FROM "Gaps" ORDER BY "Why"`)).toEqual([
      { Why: 'no_text_read' },
      { Why: 'not_sent' },
    ]);
    expect(out?.text).toContain('## Page 1');
    expect(out?.text).toContain('FT-101 4"-P-1001-A1B');
    expect(out?.text).toContain('Tags: FT-101, U2-E-12A');
  });

  it('the title block box: in the upload read, in the sketch read request when not the default, in the rows and in the stamp', async () => {
    const ps = await import('@mantle/content/pipeline-state');
    const reader = f.builtinForExt('pdf')!;
    const metaOf = async (id: string) =>
      Object.fromEntries(
        (await rowsOf(id, 'SELECT k, v FROM _meta')).map((r) => [r.k as string, r.v as string]),
      );
    // A box with the defaults: the router has no options, the reader gets
    // the box in force, and the stamp is the phase 1 stamp.
    parserOpts.length = 0;
    const plain = await scanFile('a made-up scan, the default box');
    expect(parserOpts).toEqual([
      'pdf-router {}',
      'drawing-pdf {"title_block_width_mm":190,"title_block_height_mm":70}',
    ]);
    const plainStamp = f.stampOfMeta(await metaOf(plain.id));
    expect(plainStamp?.pipeline_options).toBeUndefined();
    try {
      // A wider and higher box: the third piece's centre is in it, the first's is not.
      const set = await ps.setPipelineState(anchor, null, reader, {
        options: { title_block_width_mm: 300, title_block_height_mm: 150 },
      });
      expect(set.ok).toBe(true);
      const hash = (await ps.pipelineStateOf(anchor, reader)).optionsHash;
      expect(hash).toMatch(/^[0-9a-f]{8}$/);
      // A file read before the change is not current.
      expect(f.readerIsCurrent(plainStamp, reader, '')).toBe(true);
      expect(f.readerIsCurrent(plainStamp, reader, hash)).toBe(false);

      parserOpts.length = 0;
      const wide = await scanFile('a made-up scan, a wider box');
      const sent = '{"title_block_width_mm":300,"title_block_height_mm":150}';
      expect(parserOpts).toEqual(['pdf-router {}', `drawing-pdf ${sent}`]);
      expect((await metaOf(wide.id)).pipeline_options).toBe(hash);
      expect(f.readerIsCurrent(f.stampOfMeta(await metaOf(wide.id)), reader, hash)).toBe(true);

      // The sketch read asks the parser with the same box, and its words follow it.
      h.answers = [
        { ran: true, text: '1: TK-7\n2: FT-101' },
        { ran: true, text: '3: U2-E-12A' },
      ];
      parserOpts.length = 0;
      expect(await read(wide.id)).not.toBeNull();
      expect(parserOpts[0]).toBe(`/pdf/drawing ${sent}`);
      expect(
        await rowsOf(wide.id, `SELECT "Text", "Region" FROM "Texts" ORDER BY "Line", "Text"`),
      ).toEqual([
        { Text: 'TK-7', Region: 'body' },
        { Text: 'FT-101', Region: 'body' },
        { Text: 'U2-E-12A', Region: 'title_block' },
      ]);
      expect((await metaOf(wide.id)).pipeline_options).toBe(hash);
    } finally {
      await ps.setPipelineState(anchor, null, reader, {
        options: { title_block_width_mm: 190, title_block_height_mm: 70 },
      });
    }
  });

  it("runs once for a file's bytes: the database is the record", async () => {
    const file = await scanFile('a made-up scan, once');
    h.answers = [{ ran: true, text: '1: TK-7' }];
    expect(await read(file.id)).not.toBeNull();
    const calls = h.vision.length;
    parserCalls.length = 0;
    expect(await read(file.id)).toBeNull();
    expect(await read(file.id)).toBeNull();
    expect(h.vision).toHaveLength(calls);
    expect(parserCalls).toEqual([]);
  });

  it('does not run, and asks nothing, when it is not due', async () => {
    // No model work for this file; no vision worker; no database; no sketch kind.
    const guarded = await scanFile('a made-up scan, guarded');
    h.allowed = false;
    expect(await read(guarded.id)).toBeNull();
    h.allowed = true;
    h.worker = false;
    expect(await read(guarded.id)).toBeNull();
    h.worker = true;
    const bare = await upload('a made-up scan, no database');
    expect(await read(bare.id)).toBeNull();
    kind = 'pid';
    const pid = await scanFile('a made-up P&ID');
    expect(await read(pid.id)).toBeNull();
    expect(h.vision).toEqual([]);
    expect(parserCalls).toEqual([]);
    expect(await rowsOf(guarded.id, `SELECT "Vision read" FROM "File"`)).toEqual([
      { 'Vision read': 0 },
    ]);
  });

  it('is not due where drawing-pdf is off in the file workspace: no parser call, no vision call; on again, it reads', async () => {
    // A database from before: the upload read it while the reader was on.
    const file = await scanFile('a made-up scan, its reader off');
    const ps = await import('@mantle/content/pipeline-state');
    const reader = f.builtinForExt('pdf')!;
    expect((await ps.setPipelineState(anchor, null, reader, { offIn: [team] })).ok).toBe(true);
    try {
      h.vision.length = 0;
      parserCalls.length = 0;
      h.answers = [{ ran: true, text: '1: TK-9' }];
      expect(await read(file.id)).toBeNull();
      expect(parserCalls).toEqual([]);
      expect(h.vision).toEqual([]);
      expect(await rowsOf(file.id, `SELECT "Vision read" FROM "File"`)).toEqual([
        { 'Vision read': 0 },
      ]);
    } finally {
      await ps.setPipelineState(anchor, null, reader, { offIn: [] });
    }
    expect(await read(file.id)).not.toBeNull();
    expect(h.vision.length).toBeGreaterThan(0);
    expect(parserCalls.slice(0, 2)).toEqual(['/pdf/drawing', '/pdf/pieces']);
    expect(await rowsOf(file.id, `SELECT "Vision read" FROM "File"`)).toEqual([
      { 'Vision read': 1 },
    ]);
  });

  it('is not due when the file row is gone: no parser call, no vision call', async () => {
    const file = await scanFile('a made-up scan, its row gone');
    const node = await nodeRow(file.id);
    await su(sqlTag`delete from nodes where id = ${file.id}`);
    h.vision.length = 0;
    parserCalls.length = 0;
    h.answers = [{ ran: true, text: '1: TK-9' }];
    expect(await sketchIngestPdfNode(node, anchor)).toBeNull();
    expect(parserCalls).toEqual([]);
    expect(h.vision).toEqual([]);
  });

  it('a worker that does not run: one call, nothing written, and the next extract tries again', async () => {
    const file = await scanFile('a made-up scan, worker down');
    h.answers = [{ ran: false, text: '' }];
    expect(await read(file.id)).toBeNull();
    // The second picture was not sent after the first call did not run.
    expect(h.vision).toHaveLength(1);
    expect(await rowsOf(file.id, `SELECT "Vision read" FROM "File"`)).toEqual([
      { 'Vision read': 0 },
    ]);
    h.vision.length = 0;
    h.answers = [
      { ran: true, text: '1: TK-7' },
      { ran: true, text: '' },
    ];
    expect(await read(file.id)).not.toBeNull();
    expect(h.vision).toHaveLength(2);
  });

  it('a later call that fails is stated, and not asked again', async () => {
    const file = await scanFile('a made-up scan, one call failed');
    h.answers = [
      { ran: true, text: '1: TK-7\n2: PSV-12' },
      { ran: false, text: '' },
    ];
    expect((await read(file.id))?.text).toContain('TK-7');
    expect(await rowsOf(file.id, `SELECT "Why" FROM "Gaps" ORDER BY "Why"`)).toEqual([
      { Why: 'not_read' },
      { Why: 'not_sent' },
    ]);
    h.vision.length = 0;
    expect(await read(file.id)).toBeNull();
    expect(h.vision).toEqual([]);
  });

  it('a second read of the page facts that names another kind: nothing asked, nothing written', async () => {
    const file = await scanFile('a made-up scan, read differently the second time');
    // The parser was busy: a page ran over its time, and the rules say unsure.
    kind = 'unsure';
    expect(await read(file.id)).toBeNull();
    expect(h.vision).toEqual([]);
    expect(await rowsOf(file.id, `SELECT "Kind", "Vision read" FROM "File"`)).toEqual([
      { Kind: 'scan', 'Vision read': 0 },
    ]);
    // The next extract reads it as before, and the read runs.
    kind = 'scan';
    h.answers = [{ ran: true, text: '1: TK-7' }];
    expect(await read(file.id)).not.toBeNull();
  });

  it('a call may answer only as much as its pieces need', async () => {
    const file = await scanFile('a made-up scan, token cap');
    await read(file.id);
    // Two pieces in the first picture, one in the second.
    expect(h.vision.map((v) => v.maxTokens)).toEqual([280, 240]);
  });

  it('a file with no piece to send asks no model and writes nothing', async () => {
    const file = await scanFile('a made-up scan, no text on it');
    pieces = [
      { page: 1, status: 'refused' },
      { page: 2, status: 'no_picture' },
    ];
    expect(await read(file.id)).toBeNull();
    expect(h.vision).toEqual([]);
    expect(await rowsOf(file.id, `SELECT "Vision read" FROM "File"`)).toEqual([
      { 'Vision read': 0 },
    ]);
  });

  it('new bytes are a new read', async () => {
    kind = 'scan';
    const name = unique();
    const put = (bytes: string) =>
      m.withCreateHome({ createWs: team, privateWs: null }, () =>
        f.upsertFile({
          ownerId: anchor,
          parentPath: FOLDER,
          filename: name,
          bytes: Buffer.from(bytes),
          overwrite: true,
        }),
      );
    const file = await put('revision A of a made-up scan');
    await maybeAutoTableSpreadsheet(await nodeRow(file.id), anchor);
    h.answers = [{ ran: true, text: '1: TK-7' }];
    expect(await read(file.id)).not.toBeNull();
    await put('revision B of a made-up scan');
    await maybeAutoTableSpreadsheet(await nodeRow(file.id), anchor);
    h.vision.length = 0;
    h.answers = [{ ran: true, text: '1: TK-8' }];
    expect((await read(file.id))?.text).toContain('TK-8');
    expect(namesOf(file.id)).toHaveLength(1);
  });

  it('the PDF router counts the upload that named the kind, never the second look of the sketch read', async () => {
    const ps = await import('@mantle/content/pipeline-state');
    const runsOf = async (id: string) =>
      (
        await ps.pipelineStateOf(
          anchor,
          f.BUILTIN_PIPELINES.find((p) => p.id === id)!,
        )
      ).runs;
    const router = await runsOf('pdf-router');
    const reader = await runsOf('drawing-pdf');
    const file = await scanFile('a made-up scan, counted');
    expect([await runsOf('pdf-router'), await runsOf('drawing-pdf')]).toEqual([
      router + 1,
      reader + 1,
    ]);
    h.answers = [{ ran: true, text: '1: FT-101' }];
    expect(await read(file.id)).not.toBeNull();
    // The sketch read wrote the database again: a run of the reader, not of
    // the router. Its look at the page facts names no kind.
    expect([await runsOf('pdf-router'), await runsOf('drawing-pdf')]).toEqual([
      router + 1,
      reader + 2,
    ]);
  });

  it('the money order: every parser job before the first vision call, none after it', async () => {
    const file = await scanFile('a made-up scan, the order of its calls');
    h.order.length = 0;
    h.answers = [
      { ran: true, text: '1: TK-7' },
      { ran: true, text: '3: FT-101' },
    ];
    expect(await read(file.id)).not.toBeNull();
    expect(h.order).toEqual(['/pdf/drawing', '/pdf/pieces', 'vision', 'vision']);
  });

  it('a parser failure comes before the calls: nothing paid, nothing written', async () => {
    const file = await scanFile('a made-up scan, the parser busy');
    h.piecesDown = true;
    await expect(read(file.id)).rejects.toThrow();
    expect(h.vision).toEqual([]);
    expect(await rowsOf(file.id, `SELECT "Vision read" FROM "File"`)).toEqual([
      { 'Vision read': 0 },
    ]);
  });

  it('a second read of the page facts with more pages not read whole: nothing asked, nothing written', async () => {
    const file = await scanFile('a made-up scan, a page over its time the second time');
    const before = await rowsOf(file.id, 'SELECT * FROM "Pages" ORDER BY "Page"');
    parserCalls.length = 0;
    h.order.length = 0;
    // The reader of the page facts gives the second page as over its time.
    const slow = vi.fn(async (url: unknown) => {
      const route = String(url).replace('http://parser.test:8095', '');
      h.order.push(route);
      const pages = [PAGE(1), { ...PAGE(2), status: 'too_large' }];
      return Response.json({
        ok: true,
        numPages: 2,
        pageCountMayBeShort: false,
        allRead: false,
        kind,
        sample: '',
        pages,
      });
    });
    vi.stubGlobal('fetch', slow);
    expect(await read(file.id)).toBeNull();
    expect(h.order).toEqual(['/pdf/drawing', '/pdf/pieces']);
    expect(h.vision).toEqual([]);
    expect(await rowsOf(file.id, 'SELECT * FROM "Pages" ORDER BY "Page"')).toEqual(before);
  });

  it('a read again of a database with a sketch read is skipped (sketch): nothing read, nothing changed', async () => {
    const { buildFileDatabase } = await import('@mantle/content/file-database');
    const file = await scanFile('a made-up scan, read again');
    h.answers = [{ ran: true, text: '1: TK-7' }];
    expect(await read(file.id)).not.toBeNull();
    const before = await rowsOf(file.id, 'SELECT * FROM "Texts" ORDER BY "Line", "Text"');
    const vision = h.vision.length;
    parserCalls.length = 0;
    const node = await nodeRow(file.id);
    const data = node.data as Record<string, unknown>;
    const loaded = (await f.readFileNodeBytes(node as never))!;
    expect(
      await buildFileDatabase({
        fileId: file.id,
        ownerId: anchor,
        sha256: data.sha256,
        bytes: loaded.bytes,
        filename: loaded.filename,
      }),
    ).toEqual({ status: 'skipped', reason: 'sketch' });
    expect(parserCalls).toEqual([]);
    expect(h.vision).toHaveLength(vision);
    expect(await rowsOf(file.id, `SELECT "Vision read" FROM "File"`)).toEqual([
      { 'Vision read': 1 },
    ]);
    expect(await rowsOf(file.id, 'SELECT * FROM "Texts" ORDER BY "Line", "Text"')).toEqual(before);
  });
});
