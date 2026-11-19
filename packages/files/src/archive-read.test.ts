/**
 * Reading an archive's entries for "Extract contents" (./archive-read.ts,
 * docs/files.md "Archives"), on generated archives only
 * (./archive.test-helper.ts): the kinds by their first bytes; the clean
 * path of an entry; a ZIP and a .tar.gz with folders read in order with
 * their bytes; a climbing or absolute path, a link and a device refused and
 * named; the bombs (the whole archive past the total, an entry past the
 * entry cap, one that inflates past its declared size, too many files)
 * stopped; an encrypted entry and a wrong CRC refused; a lone gzip is one
 * file; the placing of deep folders (archive-extract.ts placeEntry).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ARCHIVE_LIMITS,
  cleanText,
  archiveBaseName,
  archiveKindOfHead,
  ArchiveRefusedError,
  EntryDamagedError,
  entrySegments,
  planArchive,
  walkArchive,
  type ArchiveEntry,
  type ArchiveLimits,
} from './archive-read';
import { placeEntry } from './archive-extract';
import { MAX_ZIP_ENTRY_BYTES, MAX_ZIP_TOTAL_BYTES } from './zip-guard';
import { testGzip, testTar, testZip } from './archive.test-helper';

let dir = '';
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'archive-read-'));
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

let n = 0;
async function onDisk(bytes: Buffer): Promise<string> {
  const file = path.join(dir, `a${(n += 1)}.bin`);
  await writeFile(file, bytes);
  return file;
}

type Seen =
  | { type: 'dir'; path: string }
  | { type: 'file'; path: string; text: string }
  | { type: 'file-error'; path: string; error: string }
  | { type: 'refused'; name: string; reason: string }
  | { type: 'skipped'; name: string };

async function readAll(
  file: string,
  kind: 'zip' | 'tar' | 'gzip',
  limits: ArchiveLimits = ARCHIVE_LIMITS,
): Promise<Seen[]> {
  const out: Seen[] = [];
  await walkArchive(file, kind, limits, async (e: ArchiveEntry) => {
    if (e.type === 'dir') out.push({ type: 'dir', path: e.segments.join('/') });
    else if (e.type === 'refused') out.push({ type: 'refused', name: e.name, reason: e.reason });
    else if (e.type === 'skipped') out.push({ type: 'skipped', name: e.name });
    else {
      const chunks: Buffer[] = [];
      try {
        for await (const c of e.open()) chunks.push(c as Buffer);
        out.push({
          type: 'file',
          path: e.segments.join('/'),
          text: Buffer.concat(chunks).toString(),
        });
      } catch (err) {
        out.push({
          type: 'file-error',
          path: e.segments.join('/'),
          error: err instanceof EntryDamagedError ? 'damaged' : String(err),
        });
      }
    }
  });
  return out;
}

const small = (over: Partial<ArchiveLimits>): ArchiveLimits => ({ ...ARCHIVE_LIMITS, ...over });

describe('the caps', () => {
  it('are the ZIP guard own caps, mirrored', () => {
    expect(ARCHIVE_LIMITS.maxEntryBytes).toBe(MAX_ZIP_ENTRY_BYTES);
    expect(ARCHIVE_LIMITS.maxTotalBytes).toBe(MAX_ZIP_TOTAL_BYTES);
    expect(ARCHIVE_LIMITS.maxFiles).toBe(10_000);
  });
});

describe('kinds and names', () => {
  it('knows a kind by its first bytes, never by its name', () => {
    expect(archiveKindOfHead(testZip([{ name: 'a.txt', data: 'a' }]))).toBe('zip');
    expect(archiveKindOfHead(testTar([{ name: 'a.txt', data: 'a' }]))).toBe('tar');
    expect(archiveKindOfHead(testGzip('x'))).toBe('gzip');
    expect(archiveKindOfHead(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]))).toBe('7z');
    expect(archiveKindOfHead(Buffer.from('Rar!\x1a\x07\x01\x00', 'latin1'))).toBe('rar');
    expect(archiveKindOfHead(Buffer.from('just some text'))).toBeNull();
  });

  it('cleans a path and refuses one that climbs or starts at a root', () => {
    expect(entrySegments('a/./b//c.txt')).toEqual({ segments: ['a', 'b', 'c.txt'] });
    expect(entrySegments('a\\b.txt')).toEqual({ segments: ['a', 'b.txt'] });
    expect(entrySegments('../etc/passwd')).toEqual({ refused: 'traversal' });
    expect(entrySegments('a/../../b')).toEqual({ refused: 'traversal' });
    expect(entrySegments('a/b/..')).toEqual({ refused: 'traversal' });
    expect(entrySegments('/etc/passwd')).toEqual({ refused: 'absolute' });
    expect(entrySegments('C:\\Windows\\x.dll')).toEqual({ refused: 'absolute' });
    expect(entrySegments('\\\\host\\share\\x')).toEqual({ refused: 'absolute' });
    expect(entrySegments('a\0b')).toEqual({ refused: 'bad-name' });
    expect(entrySegments('./')).toEqual({ refused: 'bad-name' });
  });

  it('names a folder after the archive without its archive ending', () => {
    expect(archiveBaseName('Report 2026.tar.gz')).toBe('Report 2026');
    expect(archiveBaseName('photos.ZIP')).toBe('photos');
    expect(archiveBaseName('notes.txt.gz')).toBe('notes.txt');
    expect(archiveBaseName('.zip')).toBe('.zip');
  });
});

describe('a normal archive', () => {
  it('reads a ZIP with folders in order, each with its bytes', async () => {
    const file = await onDisk(
      testZip([
        { name: 'docs/' },
        { name: 'docs/readme.md', data: '# Read me' },
        { name: 'docs/deep/more.txt', data: 'more', store: true },
        { name: 'top.txt', data: 'top '.repeat(200) },
        { name: '__MACOSX/docs/._readme.md', data: 'resource fork' },
        { name: 'docs/.DS_Store', data: 'finder' },
      ]),
    );
    expect(await readAll(file, 'zip')).toEqual([
      { type: 'dir', path: 'docs' },
      { type: 'file', path: 'docs/readme.md', text: '# Read me' },
      { type: 'file', path: 'docs/deep/more.txt', text: 'more' },
      { type: 'file', path: 'top.txt', text: 'top '.repeat(200) },
      { type: 'skipped', name: '__MACOSX/docs/._readme.md' },
      { type: 'skipped', name: 'docs/.DS_Store' },
    ]);
    expect(await planArchive(file, 'zip', ARCHIVE_LIMITS)).toEqual({
      kind: 'zip',
      files: 3,
      bytes: 9 + 4 + 800,
      refused: 0,
      skipped: 2,
    });
  });

  it('reads a .tar.gz with folders and a long name', async () => {
    const long = `${'deep-folder/'.repeat(10)}file.txt`;
    const file = await onDisk(
      testGzip(
        testTar([
          { name: 'site/', type: '5' },
          { name: 'site/index.html', data: '<h1>hi</h1>' },
          { name: long, data: 'long name' },
          { name: 'empty.txt', data: '' },
        ]),
      ),
    );
    expect(await readAll(file, 'gzip')).toEqual([
      { type: 'dir', path: 'site' },
      { type: 'file', path: 'site/index.html', text: '<h1>hi</h1>' },
      { type: 'file', path: long, text: 'long name' },
      { type: 'file', path: 'empty.txt', text: '' },
    ]);
  });

  it('reads a plain TAR, and an entry the caller leaves unread is passed', async () => {
    const file = await onDisk(
      testTar([
        { name: 'a.txt', data: 'a'.repeat(1000) },
        { name: 'b.txt', data: 'bee' },
      ]),
    );
    const seen: string[] = [];
    await walkArchive(file, 'tar', ARCHIVE_LIMITS, async (e) => {
      if (e.type !== 'file') return;
      // Leave a.txt unread: the walk must still find b.txt whole.
      if (e.segments[0] === 'b.txt') {
        const chunks: Buffer[] = [];
        for await (const c of e.open()) chunks.push(c as Buffer);
        seen.push(Buffer.concat(chunks).toString());
      }
    });
    expect(seen).toEqual(['bee']);
  });

  it('a .tar.gz entry a reader stops in the middle of is passed, and the next is whole', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 7);
    const file = await onDisk(
      testGzip(
        testTar([
          { name: 'big.bin', data: big },
          { name: 'after.txt', data: 'after' },
        ]),
      ),
    );
    const seen: string[] = [];
    await walkArchive(file, 'gzip', ARCHIVE_LIMITS, async (e) => {
      if (e.type !== 'file') return;
      const s = e.open();
      if (e.segments[0] === 'big.bin') {
        // Take one chunk, then stop (as a failed write does).
        for await (const _ of s) break;
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of s) chunks.push(c as Buffer);
      seen.push(Buffer.concat(chunks).toString());
    });
    expect(seen).toEqual(['after']);
  });

  it('reads a lone gzip as one file with no name of its own', async () => {
    const file = await onDisk(testGzip('plain text, not a tar'));
    const out: ArchiveEntry[] = [];
    let text = '';
    await walkArchive(file, 'gzip', ARCHIVE_LIMITS, async (e) => {
      out.push(e);
      if (e.type === 'file') for await (const c of e.open()) text += (c as Buffer).toString();
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'file', segments: [], size: null });
    expect(text).toBe('plain text, not a tar');
  });

  it('keeps a nested archive as one more file', async () => {
    const inner = testZip([{ name: 'inner.txt', data: 'inside' }]);
    const file = await onDisk(testZip([{ name: 'nested.zip', data: inner, store: true }]));
    const out = await readAll(file, 'zip');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'file', path: 'nested.zip' });
    expect(Buffer.from((out[0] as { text: string }).text, 'binary').length).toBeGreaterThan(0);
  });
});

describe('refused entries are named, never dropped', () => {
  it('refuses a climbing and an absolute path in a ZIP', async () => {
    const file = await onDisk(
      testZip([
        { name: '../escape.txt', data: 'x' },
        { name: 'ok/../../escape2.txt', data: 'x' },
        { name: '/etc/passwd', data: 'x' },
        { name: 'C:/Windows/evil.dll', data: 'x' },
        { name: 'fine.txt', data: 'fine' },
      ]),
    );
    expect(await readAll(file, 'zip')).toEqual([
      { type: 'refused', name: '../escape.txt', reason: 'traversal' },
      { type: 'refused', name: 'ok/../../escape2.txt', reason: 'traversal' },
      { type: 'refused', name: '/etc/passwd', reason: 'absolute' },
      { type: 'refused', name: 'C:/Windows/evil.dll', reason: 'absolute' },
      { type: 'file', path: 'fine.txt', text: 'fine' },
    ]);
  });

  it('refuses a symbolic link in a ZIP and links and devices in a TAR', async () => {
    const zip = await onDisk(
      testZip([
        { name: 'link-to-etc', data: '/etc/passwd', mode: 0o120777 },
        { name: 'fifo', data: '', mode: 0o010644 },
        { name: 'real.txt', data: 'real', mode: 0o100644 },
      ]),
    );
    expect(await readAll(zip, 'zip')).toEqual([
      { type: 'refused', name: 'link-to-etc', reason: 'link' },
      { type: 'refused', name: 'fifo', reason: 'device' },
      { type: 'file', path: 'real.txt', text: 'real' },
    ]);
    const tar = await onDisk(
      testTar([
        { name: 'sym', type: '2' },
        { name: 'hard', type: '1' },
        { name: 'dev', type: '3' },
        { name: '../up.txt', data: 'x' },
        { name: 'ok.txt', data: 'ok' },
      ]),
    );
    expect(await readAll(tar, 'tar')).toEqual([
      { type: 'refused', name: 'sym', reason: 'link' },
      { type: 'refused', name: 'hard', reason: 'link' },
      { type: 'refused', name: 'dev', reason: 'device' },
      { type: 'refused', name: '../up.txt', reason: 'traversal' },
      { type: 'file', path: 'ok.txt', text: 'ok' },
    ]);
  });

  it('refuses an encrypted entry, and a wrong CRC is damaged', async () => {
    const file = await onDisk(
      testZip([
        { name: 'secret.txt', data: 'x', encrypted: true },
        { name: 'bent.txt', data: 'some text', crc: 1234 },
      ]),
    );
    expect(await readAll(file, 'zip')).toEqual([
      { type: 'refused', name: 'secret.txt', reason: 'encrypted' },
      { type: 'file-error', path: 'bent.txt', error: 'damaged' },
    ]);
  });
});

describe('bombs', () => {
  it('refuses a whole archive past the total before reading any entry', async () => {
    // Two entries of 300 MB each, honestly declared: 600 MB together, past
    // the 512 MB total. Each is 300 deflate blocks of 1 MB of zeros on disk.
    const zero = Buffer.alloc(1024 * 1024);
    const file = await onDisk(
      testZip([
        { name: 'a.bin', repeat: { chunk: zero, times: 100 }, declaredSize: 100 * 1024 * 1024 },
        { name: 'b.bin', repeat: { chunk: zero, times: 1 }, declaredSize: 120 * 1024 * 1024 },
        { name: 'c.bin', repeat: { chunk: zero, times: 1 }, declaredSize: 120 * 1024 * 1024 },
        { name: 'd.bin', repeat: { chunk: zero, times: 1 }, declaredSize: 120 * 1024 * 1024 },
        { name: 'e.bin', repeat: { chunk: zero, times: 1 }, declaredSize: 120 * 1024 * 1024 },
      ]),
    );
    const err = await planArchive(file, 'zip', ARCHIVE_LIMITS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArchiveRefusedError);
    expect((err as ArchiveRefusedError).reason).toBe('too-large');
  });

  it('refuses an entry past the entry cap, and the others go on', async () => {
    const zero = Buffer.alloc(64 * 1024);
    const file = await onDisk(
      testZip([
        { name: 'huge.bin', repeat: { chunk: zero, times: 3 }, declaredSize: 200 * 1024 * 1024 },
        { name: 'small.txt', data: 'small' },
      ]),
    );
    expect(await readAll(file, 'zip')).toEqual([
      { type: 'refused', name: 'huge.bin', reason: 'too-large' },
      { type: 'file', path: 'small.txt', text: 'small' },
    ]);
  });

  it('stops an entry that inflates past its declared size', async () => {
    // 50 MB of zeros that says it is 1,000 bytes.
    const zero = Buffer.alloc(1024 * 1024);
    const file = await onDisk(
      testZip([{ name: 'liar.bin', repeat: { chunk: zero, times: 50 }, declaredSize: 1000 }]),
    );
    expect(await readAll(file, 'zip')).toEqual([
      { type: 'file-error', path: 'liar.bin', error: 'damaged' },
    ]);
  });

  it('refuses too many files, and a .tar.gz whose headers pass the total', async () => {
    const many = await onDisk(
      testZip(Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.txt`, data: `${i}` }))),
    );
    const tooMany = await planArchive(many, 'zip', small({ maxFiles: 10 })).catch(
      (e: unknown) => e,
    );
    expect((tooMany as ArchiveRefusedError).reason).toBe('too-many');

    // The header says 600 MB; nothing behind it is ever inflated.
    const tgz = await onDisk(
      testGzip(testTar([{ name: 'big.bin', declaredSize: 600 * 1024 * 1024 }])),
    );
    const big = await planArchive(tgz, 'gzip', ARCHIVE_LIMITS).catch((e: unknown) => e);
    expect((big as ArchiveRefusedError).reason).toBe('too-large');
  });

  it('holds a lone gzip to the entry cap as it inflates', async () => {
    const file = await onDisk(testGzip(Buffer.alloc(2 * 1024 * 1024)));
    const plan = await planArchive(file, 'gzip', small({ maxEntryBytes: 1024 * 1024 }));
    expect(plan).toMatchObject({ files: 0, refused: 1 });
    const out = await readAll(file, 'gzip', small({ maxEntryBytes: 1024 * 1024 }));
    expect(out).toEqual([{ type: 'file-error', path: '', error: 'damaged' }]);
  });

  it('refuses a damaged archive', async () => {
    const file = await onDisk(Buffer.from('PK\x03\x04 this is not really a zip at all'));
    const err = await planArchive(file, 'zip', ARCHIVE_LIMITS).catch((e: unknown) => e);
    expect((err as ArchiveRefusedError).reason).toBe('damaged');
  });
});

describe('audit round 1', () => {
  it('the walk holds the total and the count itself, with no plan before it', async () => {
    // Three entries of 1 MB each against a 2 MB total: a file changed after
    // its plan is held all the same.
    const mb1 = Buffer.alloc(1024 * 1024, 1);
    const file = await onDisk(
      testZip([
        { name: 'a.bin', repeat: { chunk: mb1, times: 1 } },
        { name: 'b.bin', repeat: { chunk: mb1, times: 1 } },
        { name: 'c.bin', repeat: { chunk: mb1, times: 1 } },
      ]),
    );
    const err = await readAll(file, 'zip', small({ maxTotalBytes: 2 * 1024 * 1024 })).catch(
      (e: unknown) => e,
    );
    expect((err as ArchiveRefusedError).reason).toBe('too-large');
    const tar = await onDisk(
      testTar(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' }))),
    );
    const many = await readAll(tar, 'tar', small({ maxFiles: 3 })).catch((e: unknown) => e);
    expect((many as ArchiveRefusedError).reason).toBe('too-many');
  });

  it('the plan holds the folders to the cap too', async () => {
    const tgz = await onDisk(
      testGzip(testTar(Array.from({ length: 12 }, (_, i) => ({ name: `d${i}/`, type: '5' })))),
    );
    const err = await planArchive(tgz, 'gzip', small({ maxFiles: 10 })).catch((e: unknown) => e);
    expect((err as ArchiveRefusedError).reason).toBe('too-many');
    expect((err as Error).message).toMatch(/folders/);
  });

  it('a folder entry that holds bytes is refused, never dropped', async () => {
    const file = await onDisk(
      testZip([
        { name: 'looks-like-a-file', data: 'secret bytes', mode: 0o040755 },
        { name: 'real/', mode: 0o040755 },
      ]),
    );
    expect(await readAll(file, 'zip')).toEqual([
      { type: 'refused', name: 'looks-like-a-file', reason: 'unsupported' },
      { type: 'dir', path: 'real' },
    ]);
  });

  it('a directory offset past the file is a damaged archive, not a fault', async () => {
    const zip = testZip([{ name: 'a.txt', data: 'a' }]);
    // The end record's directory offset, far past the file.
    zip.writeUInt32LE(0x7fffffff, zip.length - 22 + 16);
    const err = await planArchive(await onDisk(zip), 'zip', ARCHIVE_LIMITS).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ArchiveRefusedError);
    expect((err as ArchiveRefusedError).reason).toBe('damaged');
  });

  it('a name is cleaned of controls, turn-around marks and half pairs, cut on whole characters', () => {
    expect(cleanText('a\u202egnp.exe', 50)).toBe('a gnp.exe');
    expect(cleanText('a\x07b\nc', 50)).toBe('a b c');
    const emoji = `${'x'.repeat(199)}\u{1F600}tail`;
    const cut = cleanText(emoji, 200);
    expect(cut).toBe(`${'x'.repeat(199)}\u{1F600}...`);
    expect(cleanText('lone \ud83d half', 50)).toBe('lone  half');
  });
});

describe('placing an entry in the tree', () => {
  it('keeps the folders while the tree has room and puts the rest in the name', () => {
    expect(placeEntry(['a', 'b', 'c.txt'], 2)).toEqual({
      folders: ['a', 'b'],
      name: 'c.txt',
      title: 'c.txt',
      flattened: false,
    });
    expect(placeEntry(['a', 'b', 'c', 'd.txt'], 1)).toEqual({
      folders: ['a'],
      name: 'b-c-d.txt',
      title: 'b/c/d.txt',
      flattened: true,
    });
    expect(placeEntry(['x.txt'], 0)).toEqual({
      folders: [],
      name: 'x.txt',
      title: 'x.txt',
      flattened: false,
    });
  });
});
