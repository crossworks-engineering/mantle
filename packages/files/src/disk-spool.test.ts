import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHash, randomBytes } from 'node:crypto';

let root: string;
let prevRoot: string | undefined;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mantle-spool-'));
  prevRoot = process.env.MANTLE_FILES_ROOT;
  process.env.MANTLE_FILES_ROOT = root;
});
afterAll(async () => {
  if (prevRoot === undefined) delete process.env.MANTLE_FILES_ROOT;
  else process.env.MANTLE_FILES_ROOT = prevRoot;
  await rm(root, { recursive: true, force: true });
});

const disk = () => import('./disk');
const paths = () => import('./paths');

function chunked(bytes: Buffer, chunk = 64 * 1024): Readable {
  const parts: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += chunk) parts.push(bytes.subarray(i, i + chunk));
  return Readable.from(parts);
}

describe('spoolUpload', () => {
  it('spools a stream to a .part file with the right hash and size', async () => {
    const { spoolUpload, spoolDir, discardSpooled } = await disk();
    const bytes = randomBytes(300 * 1024);
    const spooled = await spoolUpload(chunked(bytes), { maxBytes: 1024 * 1024 });
    expect(path.dirname(spooled.tempPath)).toBe(spoolDir());
    expect(spooled.size).toBe(bytes.length);
    expect(spooled.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(await readFile(spooled.tempPath)).toEqual(bytes);
    await discardSpooled(spooled);
    await discardSpooled(spooled); // idempotent
  });

  it('refuses at the cap and leaves no partial file behind', async () => {
    const { spoolUpload, spoolDir, UploadTooLargeError } = await disk();
    const bytes = randomBytes(3 * 64 * 1024);
    await expect(spoolUpload(chunked(bytes), { maxBytes: 100 * 1024 })).rejects.toBeInstanceOf(
      UploadTooLargeError,
    );
    const left = (await readdir(spoolDir())).filter((n) => n.endsWith('.part'));
    expect(left).toEqual([]);
  });
});

describe('adoptSpooled', () => {
  it('moves the spool into the folder and reports the same hash', async () => {
    const { spoolUpload, adoptSpooled } = await disk();
    const { diskPathForFile } = await paths();
    const bytes = Buffer.from('hello spool');
    const spooled = await spoolUpload(Readable.from([bytes]), { maxBytes: 1024 });
    const written = await adoptSpooled('files.inbox', 'hello.txt', spooled);
    expect(written.path).toBe(diskPathForFile('files.inbox', 'hello.txt'));
    expect(written.sha256).toBe(spooled.sha256);
    expect(written.size).toBe(bytes.length);
    expect(await readFile(written.path, 'utf8')).toBe('hello spool');
    await expect(stat(spooled.tempPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a collision without overwrite and discards the spool', async () => {
    const { spoolUpload, adoptSpooled } = await disk();
    const first = await spoolUpload(Readable.from([Buffer.from('one')]), { maxBytes: 1024 });
    await adoptSpooled('files.inbox', 'dup.txt', first);
    const second = await spoolUpload(Readable.from([Buffer.from('two')]), { maxBytes: 1024 });
    await expect(adoptSpooled('files.inbox', 'dup.txt', second)).rejects.toThrow(/already exists/);
    await expect(stat(second.tempPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const third = await spoolUpload(Readable.from([Buffer.from('three')]), { maxBytes: 1024 });
    const written = await adoptSpooled('files.inbox', 'dup.txt', third, { overwrite: true });
    expect(await readFile(written.path, 'utf8')).toBe('three');
  });
});

describe('sweepSpool', () => {
  it('removes stale .part files and keeps fresh ones', async () => {
    const { sweepSpool, spoolDir } = await disk();
    const dir = spoolDir();
    const stale = path.join(dir, 'stale.part');
    const fresh = path.join(dir, 'fresh.part');
    await writeFile(stale, 'x');
    await writeFile(fresh, 'y');
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await utimes(stale, old, old);
    expect(await sweepSpool()).toBe(1);
    await expect(stat(stale)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(fresh)).isFile()).toBe(true);
  });
});
