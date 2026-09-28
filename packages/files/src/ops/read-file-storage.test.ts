/**
 * readFileById must find the bytes wherever they actually live.
 *
 * Regression lock for 2026-09-10: an email attachment has no disk presence and
 * no `data.filename`, so `diskPathForFile` returned null and readFileById gave
 * up — every attachment link in the assistant chat answered
 * `{"error": "not found"}` from /api/files/files/<id>?raw=1 while the bytes sat
 * in object storage the whole time. 267 of 268 attachments on jason-prod.
 *
 * The node lookup and the email_attachments lookup are both
 * select().from().where().limit(1), so the mock serves them from one queue in
 * call order. `importOriginal` keeps the real schema objects, so the eq()/and()
 * calls under test run against genuine drizzle columns.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

const selectQueue: unknown[][] = [];
const getContent = vi.fn<(key: string) => Promise<{ body: Readable }>>();

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(async () => selectQueue.shift() ?? []),
  };
  return { ...actual, db: { ...actual.db, select: vi.fn(() => chain) } };
});

vi.mock('@mantle/storage', () => ({ getContent: (key: string) => getContent(key) }));

const { readFileById, openFileById } = await import('./files');

/** A file node as email sync writes it: name on `title`, NO `data.filename`,
 *  bytes in object storage rather than the host-mirrored tree. */
function attachmentNode(data: Record<string, unknown> = {}) {
  return {
    id: 'f1e2d3c4-0000-4000-8000-000000000001',
    ownerId: 'bc505da9-0000-4000-8000-000000000002',
    type: 'file',
    title: 'COR14.1.pdf',
    path: 'inbox.jason.attachments',
    data: { sha256: 'abc', mimeType: 'application/pdf', sizeBytes: 12, ...data },
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  };
}

const args = {
  ownerId: 'bc505da9-0000-4000-8000-000000000002',
  fileId: 'f1e2d3c4-0000-4000-8000-000000000001',
};

beforeEach(() => {
  selectQueue.length = 0;
  getContent.mockReset();
});

describe('readFileById — object-storage fallback', () => {
  it('serves an attachment that exists only in object storage', async () => {
    selectQueue.push([attachmentNode()], [{ storageKey: 'attachments/02/17/abc' }]);
    getContent.mockResolvedValue({ body: Readable.from([Buffer.from('%PDF-1.7')]) });

    const res = await readFileById(args);

    expect(res).not.toBeNull();
    expect(res!.bytes.toString()).toBe('%PDF-1.7');
    expect(getContent).toHaveBeenCalledWith('attachments/02/17/abc');
    // Nothing came off disk, so claiming a disk path would be a lie.
    expect(res!.path).toBeNull();
    // The display name still resolves, via title.
    expect(res!.row.filename).toBe('COR14.1.pdf');
  });

  it('returns null (a clean 404) when the stored object is gone', async () => {
    selectQueue.push([attachmentNode()], [{ storageKey: 'attachments/02/17/abc' }]);
    getContent.mockRejectedValue(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }));

    await expect(readFileById(args)).resolves.toBeNull();
  });

  it('returns null when the node is not an attachment and has no disk path', async () => {
    selectQueue.push([attachmentNode()], []);

    await expect(readFileById(args)).resolves.toBeNull();
    expect(getContent).not.toHaveBeenCalled();
  });

  it('still prefers inline content and never reaches storage for it', async () => {
    selectQueue.push([attachmentNode({ content: 'hello' })]);

    const res = await readFileById(args);

    expect(res!.bytes.toString()).toBe('hello');
    expect(getContent).not.toHaveBeenCalled();
  });
});

describe('openFileById: the streaming twin', () => {
  const drain = async (stream: Readable) => {
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
    return Buffer.concat(chunks).toString();
  };

  it('streams a file on disk with its size from stat, without reading it first', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const root = mkdtempSync(join(tmpdir(), 'open-file-'));
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'big.bin'), 'DISK-BYTES');
    const saved = process.env.MANTLE_FILES_ROOT;
    process.env.MANTLE_FILES_ROOT = root;
    try {
      selectQueue.push([{ ...attachmentNode({ filename: 'big.bin' }), path: 'files.docs' }]);
      const res = await openFileById(args);
      expect(res!.size).toBe(10);
      // A file stream, not a buffer wrapped in one: it has a path.
      expect((res!.stream as Readable & { path?: string }).path).toBe(
        join(root, 'docs', 'big.bin'),
      );
      expect(await drain(res!.stream)).toBe('DISK-BYTES');
      expect(getContent).not.toHaveBeenCalled();
    } finally {
      if (saved === undefined) delete process.env.MANTLE_FILES_ROOT;
      else process.env.MANTLE_FILES_ROOT = saved;
    }
  });

  it('streams inline content and a storage-only attachment, like readFileById', async () => {
    selectQueue.push([attachmentNode({ content: 'hello' })]);
    const inline = await openFileById(args);
    expect(inline!.size).toBe(5);
    expect(await drain(inline!.stream)).toBe('hello');

    selectQueue.push([attachmentNode()], [{ storageKey: 'attachments/02/17/abc' }]);
    getContent.mockResolvedValue({ body: Readable.from([Buffer.from('%PDF-1.7')]) });
    const stored = await openFileById(args);
    expect(stored!.size).toBe(8);
    expect(await drain(stored!.stream)).toBe('%PDF-1.7');
  });

  it('is null for a missing node or bytes that are nowhere', async () => {
    selectQueue.push([]);
    await expect(openFileById(args)).resolves.toBeNull();
    selectQueue.push([attachmentNode()], []);
    await expect(openFileById(args)).resolves.toBeNull();
  });
});
