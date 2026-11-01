/**
 * file_read's `bytes`: an app's own call gets a file's bytes as base64, so it
 * can show a stored image. Nobody else does: base64 in a model's tool result
 * costs the turn and buys nothing. The size cap holds on the row and on the
 * bytes read, and the text read of a file does not change.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const files = vi.hoisted(() => ({
  fileById: vi.fn(),
  readFileById: vi.fn(),
  folderByPath: vi.fn(),
  listAllFolders: vi.fn(),
  listFiles: vi.fn(),
  listFolders: vi.fn(),
}));
vi.mock('@mantle/files', () => files);

import { APP_BYTES_IN_FLIGHT, APP_BYTES_MAX, appBytesRefusal } from './app-bytes';
import { file_read } from './files/read';
import { appBrokerCaller, ownerWebCaller, runCaller, turnCaller } from './gate-callers';
import type { ToolHandlerContext } from './types';

const FILE_ID = '22222222-2222-4222-8222-222222222222';
const META = {
  id: FILE_ID,
  filename: 'sheet.png',
  mimeType: 'image/png',
  sizeBytes: 7,
  isText: false,
};
const app = { ownerId: 'o1', caller: { entry: 'app' } } as unknown as ToolHandlerContext;
const mcp = { ownerId: 'o1', caller: { entry: 'mcp' } } as unknown as ToolHandlerContext;
const agent: ToolHandlerContext = { ownerId: 'o1' };

const read = (ctx: ToolHandlerContext, input: Record<string, unknown> = { bytes: true }) =>
  file_read.handler({ file_id: FILE_ID, ...input }, ctx);

beforeEach(() => {
  files.fileById.mockReset().mockResolvedValue(META);
  files.readFileById
    .mockReset()
    .mockResolvedValue({ row: META, bytes: Buffer.from('picture'), path: null });
});

describe('file_read bytes', () => {
  it('hands an app the bytes of a binary file', async () => {
    expect(await read(app)).toEqual({
      ok: true,
      output: {
        file: META,
        mime_type: 'image/png',
        content_base64: Buffer.from('picture').toString('base64'),
      },
    });
  });

  it.each([
    ['an agent', agent],
    ['an MCP client', mcp],
  ])('refuses %s and names what to use, reading nothing', async (_who, ctx) => {
    expect(await read(ctx)).toMatchObject({
      ok: false,
      error: expect.stringContaining('show_image'),
    });
    expect(files.readFileById).not.toHaveBeenCalled();
  });

  it('refuses a file past the cap by its row, before it loads the bytes', async () => {
    files.fileById.mockResolvedValue({ ...META, sizeBytes: APP_BYTES_MAX + 1 });
    expect(await read(app)).toMatchObject({
      ok: false,
      error: expect.stringContaining('past the 16.0 MB'),
    });
    expect(files.readFileById).not.toHaveBeenCalled();
  });

  it('holds the cap on the bytes too: the row can be stale', async () => {
    files.readFileById.mockResolvedValue({
      row: META,
      bytes: Buffer.alloc(APP_BYTES_MAX + 1),
      path: null,
    });
    expect(await read(app)).toMatchObject({ ok: false });
  });

  it('points at the lookup for an unknown file, app or not', async () => {
    files.fileById.mockResolvedValue(null);
    expect(await read(app)).toMatchObject({
      ok: false,
      error: expect.stringContaining('file_list'),
    });
  });

  it('says so when the bytes are gone', async () => {
    files.readFileById.mockResolvedValue(null);
    expect(await read(app)).toMatchObject({ ok: false });
  });

  it('turns a burst away, and frees the slots after', async () => {
    let open!: () => void;
    const held = new Promise<void>((r) => (open = r));
    files.readFileById.mockImplementation(async () => {
      await held;
      return { row: META, bytes: Buffer.from('picture'), path: null };
    });
    const first = Array.from({ length: APP_BYTES_IN_FLIGHT }, () => read(app));
    expect(await read(app)).toMatchObject({
      ok: false,
      error: expect.stringContaining('a few at a time'),
    });
    open();
    await Promise.all(first);
    expect((await read(app)).ok).toBe(true);
  });

  it('leaves the text read of a text file as it was', async () => {
    const text = { ...META, filename: 'n.txt', isText: true };
    files.fileById.mockResolvedValue(text);
    files.readFileById.mockResolvedValue({ row: text, bytes: Buffer.from('hello'), path: null });
    expect(await read(app, {})).toEqual({ ok: true, output: { file: text, content: 'hello' } });
  });
});

describe('who the bytes are for, by the real callers', () => {
  const verdict = { ok: true } as Parameters<typeof appBrokerCaller>[1];
  const asCaller = (caller: ToolHandlerContext['caller']) =>
    appBytesRefusal({ ownerId: 'o1', caller });

  it.each([
    ['an admin run', { kind: 'web' }],
    ['a team run', { kind: 'team' }],
  ])('an app broker on %s may', (_who, surface) => {
    const caller = appBrokerCaller(surface as Parameters<typeof appBrokerCaller>[0], verdict);
    expect(asCaller(caller)).toBeNull();
  });

  it.each([
    ['a chat turn', turnCaller],
    ['a run', runCaller],
    ['the owner web', ownerWebCaller],
  ])('%s may not', (_who, caller) => {
    expect(asCaller(caller())).toContain('show_image');
  });
});
