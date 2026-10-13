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

describe('stageSpooled', () => {
  it('moves the spool beside its name (a staging name), the same hash; placing puts it under the name', async () => {
    const { spoolUpload, stageSpooled, placeStaged } = await disk();
    const { diskPathForFile } = await paths();
    const bytes = Buffer.from('hello spool');
    const spooled = await spoolUpload(Readable.from([bytes]), { maxBytes: 1024 });
    const staged = await stageSpooled('files.inbox', 'hello.txt', spooled);
    expect(staged.finalPath).toBe(diskPathForFile('files.inbox', 'hello.txt'));
    expect(staged.sha256).toBe(spooled.sha256);
    expect(staged.size).toBe(bytes.length);
    await expect(stat(spooled.tempPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await placeStaged(staged);
    expect(await readFile(staged.finalPath, 'utf8')).toBe('hello spool');
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
