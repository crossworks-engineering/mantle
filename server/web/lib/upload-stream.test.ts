import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

let root: string;
let prevRoot: string | undefined;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mantle-upload-'));
  prevRoot = process.env.MANTLE_FILES_ROOT;
  process.env.MANTLE_FILES_ROOT = root;
});
afterAll(async () => {
  if (prevRoot === undefined) delete process.env.MANTLE_FILES_ROOT;
  else process.env.MANTLE_FILES_ROOT = prevRoot;
  await rm(root, { recursive: true, force: true });
});

const mod = () => import('./upload-stream');

function multipart(parts: Array<['field', string, string] | ['file', string, Uint8Array]>) {
  const fd = new FormData();
  for (const p of parts) {
    if (p[0] === 'field') fd.set(p[1], p[2]);
    else fd.set('file', new File([p[2] as BlobPart], p[1]));
  }
  return new Request('http://localhost/api/files/files', { method: 'POST', body: fd });
}

describe('declaredTooLarge', () => {
  it('refuses on the declared length alone, with slack for framing', async () => {
    const { declaredTooLarge } = await mod();
    const max = 10 * 1024 * 1024;
    expect(declaredTooLarge(new Headers({ 'content-length': String(max + 1024) }), max)).toBe(
      false,
    );
    expect(declaredTooLarge(new Headers({ 'content-length': String(3 * max) }), max)).toBe(true);
    expect(declaredTooLarge(new Headers(), max)).toBe(false);
  });
});

describe('readMultipartUpload', () => {
  it('collects fields and spools the file, whatever the part order', async () => {
    const { readMultipartUpload } = await mod();
    const bytes = randomBytes(200 * 1024);
    const req = multipart([
      ['file', 'backup.bin', bytes],
      ['field', 'parentPath', 'files.inbox'],
    ]);
    const parsed = await readMultipartUpload(req, { maxBytes: 1024 * 1024 });
    expect(parsed.fields.parentPath).toBe('files.inbox');
    expect(parsed.file?.filename).toBe('backup.bin');
    expect(parsed.file?.spooled.size).toBe(bytes.length);
    expect(await readFile(parsed.file!.spooled.tempPath)).toEqual(Buffer.from(bytes));
    const { discardSpooled } = await import('@mantle/files');
    await discardSpooled(parsed.file!.spooled);
  });

  it('keeps a non-ASCII filename intact', async () => {
    // busboy defaults multipart part headers to latin1 (RFC 7578 never states a
    // charset) while every browser sends UTF-8, so without defParamCharset an
    // accented or non-Latin name landed mojibake'd and was STORED that way.
    const { readMultipartUpload } = await mod();
    const name = 'Kr\u00fcger — вложение 附件.pdf';
    const req = multipart([['file', name, randomBytes(64)]]);
    const parsed = await readMultipartUpload(req, { maxBytes: 1024 * 1024 });
    expect(parsed.file?.filename).toBe(name);
    const { discardSpooled } = await import('@mantle/files');
    await discardSpooled(parsed.file!.spooled);
  });

  it('rejects an oversized file with the filename and cleans the spool', async () => {
    const { readMultipartUpload } = await mod();
    const { UploadTooLargeError, spoolDir } = await import('@mantle/files');
    const req = multipart([
      ['field', 'parentPath', 'files.inbox'],
      ['file', 'huge.bak', randomBytes(600 * 1024)],
    ]);
    const err = await readMultipartUpload(req, { maxBytes: 256 * 1024 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadTooLargeError);
    expect((err as InstanceType<typeof UploadTooLargeError>).filename).toBe('huge.bak');
    // Give the async discard a tick, then the spool dir must hold no .part.
    await new Promise((r) => setTimeout(r, 20));
    const left = (await readdir(spoolDir())).filter((n) => n.endsWith('.part'));
    expect(left).toEqual([]);
  });

  /** A real multipart body, replayed as its first half and then a failed read:
   *  a client dropping the connection mid-upload. The error lands on the read
   *  after the half, once `dropWhen` settles, so the test picks the moment by
   *  state rather than by a wall-clock timer (a 10 ms timer raced the spool's
   *  own setup and flaked CI on 2026-09-15). */
  async function droppedUpload(dropWhen: () => Promise<void>) {
    const full = multipart([
      ['field', 'parentPath', 'files.inbox'],
      ['file', 'dropped.bak', randomBytes(400 * 1024)],
    ]);
    const body = new Uint8Array(await full.arrayBuffer());
    let sent = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(body.subarray(0, Math.floor(body.length / 2)));
            return;
          }
          await dropWhen();
          controller.error(new Error('aborted'));
        },
      },
      { highWaterMark: 0 },
    );
    return new Request('http://localhost/api/files/files', {
      method: 'POST',
      headers: { 'content-type': full.headers.get('content-type')! },
      body: stream,
      // @ts-expect-error duplex is required for a streaming body in undici
      duplex: 'half',
    });
  }

  const spoolParts = async () => {
    const { spoolDir } = await import('@mantle/files');
    return (await readdir(spoolDir()).catch(() => [])).filter((n) => n.endsWith('.part'));
  };

  it('survives a drop before the spool file is even open', async () => {
    // The drop lands while spoolUpload is still awaiting mkdir/open, before
    // its pipeline holds the part stream. The part stream is destroyed with
    // the error then, and an unlistened 'error' is an uncaught exception.
    const { readMultipartUpload } = await mod();
    const req = await droppedUpload(async () => {});
    await expect(readMultipartUpload(req, { maxBytes: 4 * 1024 * 1024 })).rejects.toThrow(
      'aborted',
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(await spoolParts()).toEqual([]);
  });

  it('cleans the spool when the client drops the connection mid-body', async () => {
    const { readMultipartUpload } = await mod();
    let sawPart = false;
    const req = await droppedUpload(async () => {
      // Drop only once bytes are going to disk: the .part is there to clean.
      for (let i = 0; i < 500 && !sawPart; i++) {
        sawPart = (await spoolParts()).length > 0;
        if (!sawPart) await new Promise((r) => setTimeout(r, 10));
      }
    });
    await expect(readMultipartUpload(req, { maxBytes: 4 * 1024 * 1024 })).rejects.toThrow(
      'aborted',
    );
    expect(sawPart).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(await spoolParts()).toEqual([]);
  });

  it('returns file: null when no file part came', async () => {
    const { readMultipartUpload } = await mod();
    const parsed = await readMultipartUpload(multipart([['field', 'parentPath', 'files.x']]), {
      maxBytes: 1024,
    });
    expect(parsed.file).toBeNull();
    expect(parsed.fields.parentPath).toBe('files.x');
    await expect(stat(path.join(root, '.upload-spool', 'nope'))).rejects.toBeTruthy();
  });
});
