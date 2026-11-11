/**
 * The sketch read of a scanned drawing, on a real migrated Postgres and a
 * real files root: when it runs, what it asks the vision worker, what it
 * writes, and that it runs once. The parser is faked at the fetch and
 * counted; the vision worker is a stand-in that is counted. Made-up values.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/api/src/agent/extract/pdf-sketch.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';

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
}));

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
    f.resetParserFailures();
    vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        const route = String(url).replace('http://parser.test:8095', '');
        parserCalls.push(route);
        if (route === '/pdf/pieces') return Response.json({ ok: true, pages: pieces });
        return Response.json({
          ok: true,
          numPages: 2,
          pageCountMayBeShort: false,
          allRead: true,
          kind,
          sample: '',
          pages: [PAGE(1), PAGE(2)],
        });
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
    // The parser twice (the page facts, the pieces), the model once a picture.
    expect(parserCalls).toEqual(['/pdf/drawing', '/pdf/pieces']);
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
});
