/**
 * POST /api/screenshots without a database: the login is stood in and the
 * save (saveExport, export-home.test.ts holds where it lands) records what
 * it was asked. A PNG by its declared type and its bytes, at most 10 MB,
 * not empty; `meta` checked (screenshot-meta.test.ts holds its rules);
 * the file saved by the export rule under the Screenshots source, tagged,
 * its metadata in data.screenshot; the reply 201 with the file and where
 * it landed. The body streams to a temporary spool, emptied after every
 * answer. Runs the same on Node and Bun (the declared type is the part
 * header's, not the runtime's guess from the filename).
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  saves: [] as Array<Record<string, unknown>>,
  ingests: [] as Array<Record<string, unknown>>,
  landedIn: { id: 'ws-1', name: 'Home' } as { id: string; name: string } | null,
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ownerCaller: () => ({ id: 'owner-id', email: '', actor: { id: 'member-id' } }),
}));
vi.mock('@mantle/files', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  saveExport: async (
    args: Record<string, unknown> & { filename: string; spooled: { tempPath: string } },
  ) => {
    // What was spooled, read before the route empties the spool.
    const bytes = readFileSync(args.spooled.tempPath);
    h.saves.push({ ...args, bytes });
    return {
      file: {
        id: 'file-1',
        parentPath: 'files',
        filename: args.filename,
        mimeType: 'image/png',
        sizeBytes: bytes.length,
      },
      autoFiled: false,
      landedIn: h.landedIn,
    };
  },
}));
vi.mock('@mantle/tracing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordIngest: async (init: Record<string, unknown>) => {
    h.ingests.push(init);
    return null;
  },
}));

const { POST } = await import('./route');
const { UploadTooLargeError } = await import('@mantle/files');

let root = '';
let prevRoot: string | undefined;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mantle-screenshots-route-'));
  prevRoot = process.env.MANTLE_FILES_ROOT;
  process.env.MANTLE_FILES_ROOT = root;
});
afterAll(async () => {
  if (prevRoot === undefined) delete process.env.MANTLE_FILES_ROOT;
  else process.env.MANTLE_FILES_ROOT = prevRoot;
  await rm(root, { recursive: true, force: true });
});
/** What is left in the upload spool. */
const spoolLeft = async () =>
  (await readdir(path.join(root, '.upload-spool')).catch(() => [] as string[])).filter((n) =>
    n.endsWith('.part'),
  );

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

function post(parts: { file?: Blob | string; name?: string; meta?: string }): Promise<Response> {
  const form = new FormData();
  if (parts.file !== undefined) {
    if (typeof parts.file === 'string') form.set('file', parts.file);
    else form.set('file', parts.file, parts.name ?? 'shot.png');
  }
  if (parts.meta !== undefined) form.set('meta', parts.meta);
  return POST(
    new Request('https://brain.example.invalid/api/screenshots', { method: 'POST', body: form }),
  );
}
const png = (bytes: Uint8Array = PNG, type = 'image/png') =>
  new Blob([Uint8Array.from(bytes)], { type });

beforeEach(() => {
  h.saves.length = 0;
  h.ingests.length = 0;
  h.landedIn = { id: 'ws-1', name: 'Home' };
  vi.useRealTimers();
});

describe('POST /api/screenshots', () => {
  it('saves a PNG by the export rule, tagged, its metadata on the file: 201', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T10:15:07.000Z'));
    const res = await post({
      file: png(),
      meta: JSON.stringify({ screen: 'Files', route: '/files', extra: 'dropped' }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      file: {
        id: 'file-1',
        filename: 'screenshot-2026-11-06-101507.png',
        sizeBytes: PNG.length,
        mimeType: 'image/png',
      },
      landedIn: { id: 'ws-1', name: 'Home' },
    });
    expect(h.saves).toHaveLength(1);
    const save = h.saves[0]!;
    expect(save).toMatchObject({
      ownerId: 'owner-id',
      filename: 'screenshot-2026-11-06-101507.png',
      source: 'screenshots',
      tags: ['screenshot'],
      data: {
        screenshot: { screen: 'Files', route: '/files', capturedAt: '2026-11-06T10:15:07.000Z' },
      },
    });
    expect((save.data as { screenshot: object }).screenshot).not.toHaveProperty('extra');
    expect(Buffer.compare(save.bytes as Buffer, PNG)).toBe(0);
    expect(h.ingests[0]).toMatchObject({ source: 'screenshot', nodeId: 'file-1' });
  });

  it('no meta is the server time only; landedIn null passes through', async () => {
    h.landedIn = null;
    const res = await post({ file: png() });
    expect(res.status).toBe(201);
    expect((await res.json()).landedIn).toBeNull();
    const shot = (h.saves[0]!.data as { screenshot: Record<string, unknown> }).screenshot;
    expect(Object.keys(shot)).toEqual(['capturedAt']);
  });

  it('no file part, a text field named file, or not multipart at all: 400', async () => {
    expect((await post({ meta: '{}' })).status).toBe(400);
    expect((await post({ file: 'not a file' })).status).toBe(400);
    const json = await POST(
      new Request('https://brain.example.invalid/api/screenshots', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(json.status).toBe(400);
    expect(await json.json()).toEqual({ error: 'multipart field `file` required' });
    expect(h.saves).toEqual([]);
  });

  it('an empty file: 400', async () => {
    const res = await post({ file: png(new Uint8Array(0)) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'empty file' });
  });

  it('over 10 MB: the upload cap (413 by the one error table), nothing kept', async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PNG);
    const err = await post({ file: png(big) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadTooLargeError);
    expect((err as InstanceType<typeof UploadTooLargeError>).maxBytes).toBe(10 * 1024 * 1024);
    expect(h.saves).toEqual([]);
    expect(await spoolLeft()).toEqual([]);
  });

  it('exactly 10 MB is kept', async () => {
    const at = new Uint8Array(10 * 1024 * 1024);
    at.set(PNG);
    expect((await post({ file: png(at) })).status).toBe(201);
  });

  it('a PNG by its bytes but declared another type: 415, whatever the filename says', async () => {
    for (const type of ['image/jpeg', 'application/octet-stream', '']) {
      const res = await post({ file: png(PNG, type), name: 'shot.png' });
      expect(res.status, type).toBe(415);
    }
    expect(h.saves).toEqual([]);
    expect(await spoolLeft()).toEqual([]);
  });

  it('declared image/png under any filename (a browser Blob is "blob"): 201', async () => {
    for (const name of ['blob', 'capture.bin', 'shot.png']) {
      expect((await post({ file: png(), name })).status, name).toBe(201);
    }
  });

  it('declared image/png but not a PNG by its bytes: 415', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const res = await post({ file: png(jpeg) });
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: 'a screenshot must be a PNG image' });
    expect(h.saves).toEqual([]);
    expect(await spoolLeft()).toEqual([]);
  });

  it('invalid meta: 400 with a plain message, nothing saved', async () => {
    const notJson = await post({ file: png(), meta: '{"a":' });
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({ error: 'meta is not valid JSON' });
    const badKey = await post({ file: png(), meta: JSON.stringify({ shell: 'cli' }) });
    expect(badKey.status).toBe(400);
    expect((await badKey.json()).error).toMatch(/^invalid meta: shell/);
    expect(h.saves).toEqual([]);
    expect(await spoolLeft()).toEqual([]);
  });

  it('meta sent as a file part is not read: no meta, the server time only', async () => {
    const form = new FormData();
    form.set('file', png(), 'a.png');
    form.set('meta', new Blob(['{"note":"x"}'], { type: 'application/json' }), 'meta.json');
    const res = await POST(
      new Request('https://brain.example.invalid/api/screenshots', { method: 'POST', body: form }),
    );
    expect(res.status).toBe(201);
    const shot = (h.saves[0]!.data as { screenshot: Record<string, unknown> }).screenshot;
    expect(Object.keys(shot)).toEqual(['capturedAt']);
  });
});
