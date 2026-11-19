/**
 * What the extractor keeps on a file node about the parser, on a migrated
 * scratch database with BOTH checks on (the actor check and the edit
 * check), written the way the extract queue writes it (the system scope
 * `queue:extract`):
 *
 *  - the parser failure count (`data.parser_failures`, parser-failures.ts):
 *    `get` reads nothing before a failure, `add` counts per key and keeps
 *    the code, a `final` refusal goes straight to terminal (2), and the
 *    node's other data stays;
 *  - the native read of a typed PDF that found no text
 *    (`data.native_pdf.empty_sha256`, images.ts nativeReadPdfNode): a second
 *    extract of the same bytes, from the node as the database holds it (as a
 *    redrive after a restart reads it), makes no native read; new bytes do;
 *  - the pages a scan read kept (`data.ocr.resume`, images.ts
 *    ocrIngestPdfNode): a retry after a busy parser goes on after them, and
 *    the end puts the final `ocr` in their place.
 *
 * The page read, the document worker, the file bytes and tracing are
 * stubbed; the writes and the reads are real.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/api/src/agent/extract/parser-node-keys.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({
  bytes: Buffer.alloc(0),
  runDocumentWorker: vi.fn(),
  readScannedPdf: vi.fn(),
}));

vi.mock('@mantle/tracing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/tracing')>();
  return {
    ...actual,
    startTrace: vi.fn(async (_init: unknown, fn: () => unknown) => fn()),
    step: vi.fn(async (_spec: unknown, fn: (handle: unknown) => unknown) =>
      fn({ setMeta: () => {} }),
    ),
  };
});
vi.mock('@mantle/runtime/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/runtime/agent')>();
  return {
    ...actual,
    runDocumentWorker: h.runDocumentWorker,
    readScannedPdf: h.readScannedPdf,
  };
});
vi.mock('./file-bytes', () => ({
  loadFileBytes: async () => ({ bytes: h.bytes, filename: 'scan.pdf' }),
}));

describe.skipIf(!URL)('the parser keys on a file node, both checks on', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let ledgerOf: typeof import('./parser-failures').nodeParserFailures;
  let ocrIngestPdfNode: typeof import('./images').ocrIngestPdfNode;
  let nativeReadPdfNode: typeof import('./images').nativeReadPdfNode;
  const owner = randomUUID();
  const tag = `pnk${randomUUID().slice(0, 6)}`;

  const extract = <T>(fn: () => Promise<T>) => m.runAsSystem('queue:extract', fn) as Promise<T>;
  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];

  /** A file node of this owner, with some data the writes must keep. */
  const fileNode = async (): Promise<string> => {
    const id = randomUUID();
    // A file's name is unique in its folder: one per node.
    const filename = `scan-${id.slice(0, 8)}.pdf`;
    await x(sql`insert into nodes (id, owner_id, type, title, path, data) values
      (${id}, ${owner}, 'file', ${filename}, 'files',
       ${JSON.stringify({ filename, mimeType: 'application/pdf', keep: 'me' })}::jsonb)`);
    return id;
  };
  const dataOf = async (id: string) =>
    (await x<{ data: Record<string, unknown> }>(sql`select data from nodes where id = ${id}`))[0]!
      .data;
  const nodeRow = async (id: string) =>
    extract(async () => {
      const { eq } = await import('drizzle-orm');
      const [row] = await m.db.select().from(m.nodes).where(eq(m.nodes.id, id)).limit(1);
      return row!;
    });

  beforeAll(async () => {
    process.env.MANTLE_ACTOR_CHECK = 'on';
    process.env.MANTLE_TEST_EDIT_CHECK = 'on';
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    ({ nodeParserFailures: ledgerOf } = await import('./parser-failures'));
    ({ ocrIngestPdfNode, nativeReadPdfNode } = await import('./images'));
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await ts.runWorkspacesSwitch();
  }, 240_000);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    process.env.MANTLE_ACTOR_CHECK = 'warn';
    delete process.env.MANTLE_TEST_EDIT_CHECK;
    await m?.closeDb();
    await scratch?.drop();
  });

  it('counts per key, keeps the code, and leaves the rest of the data', async () => {
    const id = await fileNode();
    const ledger = ledgerOf(id, owner);
    const text = `text:${'a'.repeat(64)}`;
    const images = `images:${'a'.repeat(64)}`;
    await extract(async () => {
      expect(await ledger.get(text)).toBeNull();
      expect(await ledger.add(text, 'timeout')).toBe(1);
      expect(await ledger.get(text)).toEqual({ n: 1, code: 'timeout' });
      expect(await ledger.add(text, 'crashed')).toBe(2);
      expect(await ledger.get(text)).toEqual({ n: 2, code: 'crashed' });
      // Another job on the same bytes counts on its own.
      expect(await ledger.get(images)).toBeNull();
      expect(await ledger.add(images, 'timeout')).toBe(1);
    });
    const data = await dataOf(id);
    expect(data.keep).toBe('me');
    expect(data.parser_failures).toEqual({
      [text]: { n: 2, code: 'crashed' },
      [images]: { n: 1, code: 'timeout' },
    });
    expect(m.takeActorMisses()).toEqual([]);
  });

  it('makes a final refusal terminal at once', async () => {
    const id = await fileNode();
    const ledger = ledgerOf(id, owner);
    const key = `grid:${'b'.repeat(64)}`;
    await extract(async () => {
      expect(await ledger.add(key, 'too_large', { final: true })).toBe(2);
      expect(await ledger.get(key)).toEqual({ n: 2, code: 'too_large' });
    });
  });

  it('reads another owner’s node as no count, and counts a write to it as a first failure', async () => {
    const id = await fileNode();
    const stranger = ledgerOf(id, randomUUID());
    const key = `text:${'c'.repeat(64)}`;
    await extract(async () => {
      expect(await stranger.get(key)).toBeNull();
      expect(await stranger.add(key, 'timeout')).toBe(1);
    });
    expect((await dataOf(id)).parser_failures).toBeUndefined();
  });

  it('a second extract of the same bytes makes no native read; new bytes do', async () => {
    const id = await fileNode();
    h.bytes = Buffer.from(`%PDF-1.4 ${tag} typed`);
    // The provider reads PDFs natively and finds nothing: the text layer is
    // kept, and the marker says so for these bytes.
    h.runDocumentWorker.mockResolvedValue({ ran: true, text: '', note: null, model: 'm' });

    await extract(async () => nativeReadPdfNode(await nodeRow(id), owner));
    expect(h.runDocumentWorker).toHaveBeenCalledTimes(1);
    const sha = createHash('sha256').update(h.bytes).digest('hex');
    expect((await dataOf(id)).native_pdf).toEqual({ empty_sha256: sha });
    expect((await dataOf(id)).keep).toBe('me');

    // The retry (or a redrive after a restart) reads the node afresh.
    await extract(async () => nativeReadPdfNode(await nodeRow(id), owner));
    expect(h.runDocumentWorker).toHaveBeenCalledTimes(1);

    // New bytes: the marker is not theirs.
    h.bytes = Buffer.from(`%PDF-1.4 ${tag} another typed`);
    await extract(async () => nativeReadPdfNode(await nodeRow(id), owner));
    expect(h.runDocumentWorker).toHaveBeenCalledTimes(2);
    expect(m.takeActorMisses()).toEqual([]);
  });

  it('a scan read goes on after the pages a try before kept, and pays for none again', async () => {
    const id = await fileNode();
    h.bytes = Buffer.from(`%PDF-1.4 ${tag} scan`);
    const sha = createHash('sha256').update(h.bytes).digest('hex');
    await x(
      sql`update nodes set data = data || jsonb_build_object('sha256', ${sha}::text) where id = ${id}`,
    );
    const { ParserError } = await import('@mantle/files');
    type Share = import('@mantle/runtime/agent').ScanShareHooks;
    // Try 1: the first window is claimed, read and kept, then the parser
    // is busy.
    h.readScannedPdf.mockImplementationOnce(async (o: { share: Share }) => {
      const c = await o.share.claim([1, 2]);
      expect(c.mine).toEqual([1, 2]);
      await o.share.keep(
        [
          { page: 1, method: 'scan_reader', text: 'Page one read.' },
          { page: 2, method: 'unread', text: '', why: 'bad_read' },
        ],
        3,
      );
      await o.share.claim([3]);
      throw new ParserError('busy', 'busy', { retryable: true, terminal: false });
    });
    const err = await extract(async () => ocrIngestPdfNode(await nodeRow(id), owner)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ParserError);
    const kept = (await dataOf(id)).ocr as {
      scan: { sha256: string; pages: Record<string, unknown>; claims: Record<string, unknown> };
    };
    expect(kept.scan.sha256).toBe(sha);
    expect(Object.keys(kept.scan.pages)).toEqual(['1', '2']);
    expect(Object.keys(kept.scan.claims)).toEqual(['3']);

    // Try 2: the pages kept are done; its own claim of page 3 is its own.
    h.readScannedPdf.mockImplementationOnce(async (o: { share: Share }) => {
      expect((await o.share.claim([3])).mine).toEqual([3]);
      return {
        pages: [{ page: 3, method: 'scan_reader', text: 'Page three read.' }],
        pagesTotal: 3,
        ran: true,
        model: 'm',
      };
    });
    const r = await extract(async () => ocrIngestPdfNode(await nodeRow(id), owner));
    expect(h.readScannedPdf.mock.calls[1]![0]).toMatchObject({
      done: new Set([1, 2]),
      pagesTotal: 3,
    });
    expect(r.text).toBe('[Page 1]\nPage one read.\n\n[Page 3]\nPage three read.');
    const data = await dataOf(id);
    // The read's end: the final mark, the shared pages gone (no chat turn).
    expect(data.ocr).toEqual({
      pages_read: 2,
      pages_total: 3,
      unread: { bad_read: 1 },
      scan_read: true,
    });
    expect(data.text).toBe(r.text);
    expect(data.keep).toBe('me');
    expect(m.takeActorMisses()).toEqual([]);
  });

  it('a chat turn and the extract share one node’s reads: one claim wins, each takes the other’s pages', async () => {
    const id = await fileNode();
    const bytes = Buffer.from(`%PDF-1.4 ${tag} shared`);
    const sha = createHash('sha256').update(bytes).digest('hex');
    await x(
      sql`update nodes set data = data || jsonb_build_object('sha256', ${sha}::text) where id = ${id}`,
    );
    const rt = await import('@mantle/runtime/agent');
    const hooks = (by: 'chat' | 'extract') =>
      rt.scanShareHooks({
        nodeId: id,
        sha256: sha,
        by,
        final: rt.scanPageFinal,
        claimMs: () => 60_000,
      });
    const chat = hooks('chat');
    const extract = hooks('extract');
    // The chat turn says it reads, and claims pages 1 and 2.
    await rt.setChatReading(id, sha, Date.now() + 120_000);
    expect((await chat.claim([1, 2])).mine).toEqual([1, 2]);
    // The extract, at the same pages and one more: page 3 is its own.
    const c = await extract.claim([1, 2, 3]);
    expect(c.mine).toEqual([3]);
    expect([...c.theirs.keys()]).toEqual([1, 2]);
    // Each keeps its read; each then takes the other's with no claim.
    await chat.keep([
      { page: 1, method: 'scan_reader', text: 'one' },
      { page: 2, method: 'scan_reader', text: 'two' },
    ]);
    expect(await extract.keep([{ page: 3, method: 'scan_reader', text: 'three' }], 3)).toBe(true);
    expect([...(await extract.wait([1, 2], Date.now() + 5_000)).keys()]).toEqual([1, 2]);
    expect([...(await chat.claim([3])).kept.keys()]).toEqual([3]);
    // Of other bytes: nothing shared.
    const other = rt.scanShareHooks({
      nodeId: id,
      sha256: 'f'.repeat(64),
      by: 'chat',
      final: rt.scanPageFinal,
      claimMs: () => 60_000,
    });
    const o = await other.claim([1]);
    expect(o.kept.size).toBe(0);
    expect(o.mine).toEqual([1]);
    // Its keep writes nothing, and says so (its reader's wait is then a
    // paid one: the pages are paid for again).
    expect(await other.keep([{ page: 1, method: 'scan_reader', text: 'x' }])).toBe(false);
    // A book's ask of page 2 while the chat turn reads: kept, no call.
    expect(await rt.bookScanTurn(id, 2)).toEqual({
      kept: { page: 2, method: 'scan_reader', text: 'two' },
    });
    expect((await dataOf(id)).keep).toBe('me');
    expect(m.takeActorMisses()).toEqual([]);
  });
  it('a book’s figure whose vision call waits is kept for the book alone: a chat turn reads the page itself', async () => {
    const id = await fileNode();
    const sha = createHash('sha256').update(`${tag} book figure`).digest('hex');
    await x(
      sql`update nodes set data = data || jsonb_build_object('sha256', ${sha}::text) where id = ${id}`,
    );
    const rt = await import('@mantle/runtime/agent');
    // The book's ask paid the Scan reader read of page 4; its vision call
    // waited.
    expect(await rt.keepBookFigure(id, 4)).toBe(true);
    // The book's run again takes it: only the vision call is left.
    expect(await rt.bookScanTurn(id, 4)).toEqual({ figure: true });
    // A chat turn takes it as no read: it claims the page and reads it.
    const chat = rt.scanShareHooks({
      nodeId: id,
      sha256: sha,
      by: 'chat',
      final: rt.scanPageFinal,
      claimMs: () => 60_000,
    });
    const c = await chat.claim([4]);
    expect(c.kept.size).toBe(0);
    expect(c.mine).toEqual([4]);
    expect((await rt.scanKeptOf(id, sha)).size).toBe(0);
    // Its read, kept over it, stands for every reader, the book's too.
    expect(await chat.keep([{ page: 4, method: 'vision', text: 'A VALVE' }])).toBe(true);
    expect(await rt.bookScanTurn(id, 4)).toEqual({
      kept: { page: 4, method: 'vision', text: 'A VALVE' },
    });
    expect((await dataOf(id)).keep).toBe('me');
    expect(m.takeActorMisses()).toEqual([]);
  });

  it('a whole read is never written over; the chat turn’s end drops the shared pages beside it', async () => {
    const rt = await import('@mantle/runtime/agent');
    const id = await fileNode();
    const sha = createHash('sha256').update(`${tag} whole`).digest('hex');
    // A whole read by the core (a sketch read writes `ocr: true` too).
    await x(sql`update nodes set data = data || jsonb_build_object('sha256', ${sha}::text,
      'text', 'All of it'::text, 'ocr', 'true'::jsonb) where id = ${id}`);
    const chat = rt.scanShareHooks({
      nodeId: id,
      sha256: sha,
      by: 'chat',
      final: rt.scanPageFinal,
      claimMs: () => 60_000,
    });
    await rt.setChatReading(id, sha, Date.now() + 60_000);
    expect((await chat.claim([1])).final).toBe(true);
    expect(await chat.keep([{ page: 1, method: 'scan_reader', text: 'late' }])).toBe(false);
    expect((await dataOf(id)).ocr).toBe(true);
    expect(await rt.scanFinalReadOf(id, sha)).toEqual({ text: 'All of it', ocr: true });

    // The core's end while a chat turn read: its mark with the pages beside
    // it; the turn's end drops them, and the mark is `true` again.
    await x(
      sql`update nodes set data = jsonb_set(data, '{ocr}', ${JSON.stringify({
        pages_read: 1,
        pages_total: 1,
        scan_read: true,
        scan: { sha256: sha, pages: { 1: ['scan_reader', '', 'All of it'] }, claims: {} },
      })}::jsonb) where id = ${id}`,
    );
    await rt.setChatReading(id, sha, null);
    expect((await dataOf(id)).ocr).toBe(true);
    expect((await dataOf(id)).keep).toBe('me');
    expect(m.takeActorMisses()).toEqual([]);
  });
});
