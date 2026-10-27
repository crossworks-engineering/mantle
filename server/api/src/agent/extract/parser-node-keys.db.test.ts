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
 *  - the native read of a PDF that found no text
 *    (`data.native_pdf.empty_sha256`, images.ts): a second extract of the
 *    same bytes, from the node as the database holds it (as a redrive after
 *    a restart reads it), makes no native read; new bytes do.
 *
 * The parser, the document worker, the file bytes and tracing are stubbed;
 * the writes and the reads are real.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/api/src/agent/extract/parser-node-keys.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({
  bytes: Buffer.alloc(0),
  runDocumentWorker: vi.fn(),
  parserRasterizePdf: vi.fn(),
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
  return { ...actual, runDocumentWorker: h.runDocumentWorker };
});
vi.mock('@mantle/files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/files')>();
  return { ...actual, parserRasterizePdf: h.parserRasterizePdf };
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
  const owner = randomUUID();
  const tag = `pnk${randomUUID().slice(0, 6)}`;

  const extract = <T>(fn: () => Promise<T>) => m.runAsSystem('queue:extract', fn) as Promise<T>;
  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];

  /** A file node of this owner, with some data the writes must keep. */
  const fileNode = async (): Promise<string> => {
    const id = randomUUID();
    await x(sql`insert into nodes (id, owner_id, type, title, path, data) values
      (${id}, ${owner}, 'file', 'scan.pdf', 'files',
       ${JSON.stringify({ filename: 'scan.pdf', mimeType: 'application/pdf', keep: 'me' })}::jsonb)`);
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
    ({ ocrIngestPdfNode } = await import('./images'));
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
    h.bytes = Buffer.from(`%PDF-1.4 ${tag} scan`);
    // The provider reads PDFs natively and finds nothing; the render then
    // fails on a busy parser, so the job is retried.
    h.runDocumentWorker.mockResolvedValue({ ran: true, text: '', note: null, model: 'm' });
    const { ParserError } = await import('@mantle/files');
    h.parserRasterizePdf.mockRejectedValue(
      new ParserError('busy', 'busy', { retryable: true, terminal: false }),
    );

    await extract(async () => ocrIngestPdfNode(await nodeRow(id), owner)).catch(() => {});
    expect(h.runDocumentWorker).toHaveBeenCalledTimes(1);
    const sha = createHash('sha256').update(h.bytes).digest('hex');
    expect((await dataOf(id)).native_pdf).toEqual({ empty_sha256: sha });
    expect((await dataOf(id)).keep).toBe('me');

    // The retry (or a redrive after a restart) reads the node afresh.
    await extract(async () => ocrIngestPdfNode(await nodeRow(id), owner)).catch(() => {});
    expect(h.runDocumentWorker).toHaveBeenCalledTimes(1);
    expect(h.parserRasterizePdf).toHaveBeenCalledTimes(2);

    // New bytes: the marker is not theirs.
    h.bytes = Buffer.from(`%PDF-1.4 ${tag} another scan`);
    await extract(async () => ocrIngestPdfNode(await nodeRow(id), owner)).catch(() => {});
    expect(h.runDocumentWorker).toHaveBeenCalledTimes(2);
    expect(m.takeActorMisses()).toEqual([]);
  });
});
