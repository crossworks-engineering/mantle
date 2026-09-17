/**
 * Behavioural tests for the file_* write tools: file_create, file_rename,
 * file_set_indexing, file_move, file_copy, and the operator-only file_upload.
 *
 * These tools are thin over `@mantle/files`, which is exactly why they are
 * worth pinning: the thinness is the contract. Each one must
 *
 *  - scope every store call to `ctx.ownerId` (the store decides "not yours"
 *    only if the owner reaches it; a handler that forgets to pass it turns
 *    every file in the brain into fair game);
 *  - refuse a blank required argument BEFORE touching the store, so a model
 *    that sent `{}` gets a usable message instead of a stack trace from a
 *    drizzle query with an empty uuid;
 *  - pass the store's own refusal (name clash, foreign folder, files root)
 *    through verbatim rather than swallowing it into a generic failure.
 *
 * file_upload also carries the only size and encoding decisions made at the
 * tool layer (the base64 decode and the MAX_UPLOAD_BYTES cap), so those are
 * pinned here rather than in the store tests.
 *
 * The store edges are stubbed; the tools' own branching is real. Note that
 * file_create lives in FILE_CREATE_TOOLS and the move/copy/indexing tools in
 * FILE_MANAGE_TOOLS, not in FILE_TOOLS; picking from the wrong array yields
 * `undefined.handler`, which is a confusing way to learn that.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/files')>();
  return {
    ...actual,
    ensureFolderPath: vi.fn(),
    upsertFile: vi.fn(),
    renameFileById: vi.fn(),
    setIndexingMode: vi.fn(),
    fileById: vi.fn(),
    moveFileById: vi.fn(),
    copyFileById: vi.fn(),
  };
});
vi.mock('@mantle/tracing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/tracing')>();
  return { ...actual, recordIngest: vi.fn() };
});

import {
  MAX_UPLOAD_BYTES,
  copyFileById,
  ensureFolderPath,
  fileById,
  moveFileById,
  renameFileById,
  setIndexingMode,
  upsertFile,
} from '@mantle/files';
import { recordIngest } from '@mantle/tracing';
import {
  FILE_CREATE_TOOLS,
  FILE_MANAGE_TOOLS,
  FILE_OPERATOR_TOOLS,
  FILE_TOOLS,
} from './builtins-files';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

function pick(arr: readonly BuiltinToolDef[], slug: string): BuiltinToolDef {
  const def = arr.find((t) => t.slug === slug);
  if (!def) throw new Error(`no tool '${slug}' in the given array`);
  return def;
}

const fileCreate = pick(FILE_CREATE_TOOLS, 'file_create');
const fileRename = pick(FILE_TOOLS, 'file_rename');
const fileSetIndexing = pick(FILE_MANAGE_TOOLS, 'file_set_indexing');
const fileMove = pick(FILE_MANAGE_TOOLS, 'file_move');
const fileCopy = pick(FILE_MANAGE_TOOLS, 'file_copy');
const fileUpload = pick(FILE_OPERATOR_TOOLS, 'file_upload');

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const FILE_ID = '11111111-2222-4333-8444-555555555555';
const NEW_ID = '22222222-2222-4333-8444-555555555555';

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): unknown {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output;
}

/** A FileRow as the store returns it; only the fields the tools read matter. */
const row = {
  id: FILE_ID,
  parentPath: 'files.work',
  title: 'notes.md',
  filename: 'notes.md',
  extension: 'md',
  mimeType: 'text/markdown',
  sizeBytes: 5,
  sha256: null,
  isText: true,
  summary: null,
  indexing: null,
  indexingApplied: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks clears calls, not implementations; re-set every default so a
  // test that forgets to stub still gets a promise back, not `undefined`.
  vi.mocked(ensureFolderPath).mockResolvedValue('files.work');
  vi.mocked(upsertFile).mockResolvedValue(row as never);
  vi.mocked(renameFileById).mockResolvedValue(row as never);
  vi.mocked(setIndexingMode).mockResolvedValue({ node: { id: FILE_ID }, requeued: 0 } as never);
  vi.mocked(fileById).mockResolvedValue(row as never);
  vi.mocked(moveFileById).mockResolvedValue(row as never);
  vi.mocked(copyFileById).mockResolvedValue({ ...row, id: NEW_ID } as never);
  vi.mocked(recordIngest).mockResolvedValue(undefined as never);
});

describe('file_create', () => {
  it('refuses a blank parent_path or filename WITHOUT touching the store', async () => {
    const a = await fileCreate.handler({ parent_path: '', filename: 'x.md', content: 'hi' }, ctx);
    expect(errorOf(a)).toMatch(/parent_path \+ filename required/);
    const b = await fileCreate.handler(
      { parent_path: 'files.work', filename: '', content: 'hi' },
      ctx,
    );
    expect(errorOf(b)).toMatch(/parent_path \+ filename required/);
    expect(ensureFolderPath).not.toHaveBeenCalled();
    expect(upsertFile).not.toHaveBeenCalled();
  });

  it('ensures the folder exists, then writes the utf-8 bytes under the owner', async () => {
    const res = await fileCreate.handler(
      { parent_path: 'files.work', filename: 'notes.md', content: 'héllo' },
      ctx,
    );
    // The folder is brought into existence rather than refused: a skill can
    // name a folder the brain has never had.
    expect(ensureFolderPath).toHaveBeenCalledWith({ ownerId: 'o1', path: 'files.work' });
    expect(upsertFile).toHaveBeenCalledWith({
      ownerId: 'o1',
      parentPath: 'files.work',
      filename: 'notes.md',
      bytes: Buffer.from('héllo', 'utf8'),
      overwrite: undefined,
    });
    expect(outputOf(res)).toBe(row);
  });

  it('passes overwrite through only when it is a real boolean', async () => {
    await fileCreate.handler(
      { parent_path: 'files.work', filename: 'notes.md', content: 'x', overwrite: true },
      ctx,
    );
    expect(upsertFile).toHaveBeenCalledWith(expect.objectContaining({ overwrite: true }));
    vi.clearAllMocks();
    await fileCreate.handler(
      { parent_path: 'files.work', filename: 'notes.md', content: 'x', overwrite: 'yes' },
      ctx,
    );
    // A string 'yes' must NOT be read as consent to clobber an existing file.
    expect(upsertFile).toHaveBeenCalledWith(expect.objectContaining({ overwrite: undefined }));
  });

  it('records the create as an ingest event attributed to the tool', async () => {
    const agentCtx: ToolHandlerContext = {
      ownerId: 'o1',
      agent: { slug: 'responder', depth: 1, delegateTo: [] } as never,
    };
    await fileCreate.handler(
      { parent_path: 'files.work', filename: 'notes.md', content: 'body' },
      agentCtx,
    );
    expect(recordIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent_tool',
        ownerId: 'o1',
        nodeId: FILE_ID,
        snippet: 'body',
        payload: expect.objectContaining({ via: 'file_create_tool', invokingAgent: 'responder' }),
      }),
    );
  });

  it('stops at a path outside the files root: the store refusal is the error, nothing is written', async () => {
    vi.mocked(ensureFolderPath).mockRejectedValue(
      new Error("ensureFolderPath: 'notes.work' is not under 'files'"),
    );
    const res = await fileCreate.handler(
      { parent_path: 'notes.work', filename: 'notes.md', content: 'x' },
      ctx,
    );
    expect(errorOf(res)).toMatch(/not under 'files'/);
    expect(upsertFile).not.toHaveBeenCalled();
    expect(recordIngest).not.toHaveBeenCalled();
  });

  it('surfaces a name collision from the store and does not log a phantom ingest', async () => {
    vi.mocked(upsertFile).mockRejectedValue(new Error('upsertFile: notes.md already exists'));
    const res = await fileCreate.handler(
      { parent_path: 'files.work', filename: 'notes.md', content: 'x' },
      ctx,
    );
    expect(errorOf(res)).toMatch(/already exists/);
    expect(recordIngest).not.toHaveBeenCalled();
  });
});

describe('file_rename', () => {
  it('refuses a blank file_id or new_stem WITHOUT calling the store', async () => {
    expect(errorOf(await fileRename.handler({ file_id: '', new_stem: 'x' }, ctx))).toMatch(
      /file_id \+ new_stem required/,
    );
    expect(errorOf(await fileRename.handler({ file_id: FILE_ID, new_stem: '' }, ctx))).toMatch(
      /file_id \+ new_stem required/,
    );
    expect(renameFileById).not.toHaveBeenCalled();
  });

  it('renames under the owner and reports the new name on the trace step', async () => {
    const setOutput = vi.fn();
    const stepCtx: ToolHandlerContext = {
      ownerId: 'o1',
      step: { setOutput, setMeta: vi.fn(), addTokens: vi.fn(), addCost: vi.fn() },
    };
    const renamed = { ...row, filename: 'report.md' };
    vi.mocked(renameFileById).mockResolvedValue(renamed as never);
    const res = await fileRename.handler({ file_id: FILE_ID, new_stem: 'report' }, stepCtx);
    expect(renameFileById).toHaveBeenCalledWith({
      ownerId: 'o1',
      fileId: FILE_ID,
      newStem: 'report',
    });
    expect(outputOf(res)).toBe(renamed);
    expect(setOutput).toHaveBeenCalledWith({ fileId: FILE_ID, filename: 'report.md' });
  });

  it('turns a null from the store into a not-found that names the lookup tools', async () => {
    vi.mocked(renameFileById).mockResolvedValue(null);
    const err = errorOf(await fileRename.handler({ file_id: FILE_ID, new_stem: 'x' }, ctx));
    expect(err).toMatch(/file not found/);
    expect(err).toMatch(/file_list/);
  });

  it('passes a store refusal (name clash) through as the error', async () => {
    vi.mocked(renameFileById).mockRejectedValue(new Error('renameFileById: x.md already exists'));
    expect(errorOf(await fileRename.handler({ file_id: FILE_ID, new_stem: 'x' }, ctx))).toMatch(
      /already exists/,
    );
  });
});

describe('file_set_indexing', () => {
  it('refuses a blank file_id WITHOUT calling the store', async () => {
    expect(errorOf(await fileSetIndexing.handler({ file_id: '', mode: 'metadata' }, ctx))).toMatch(
      /file_id required/,
    );
    expect(setIndexingMode).not.toHaveBeenCalled();
  });

  it('sets the mode on the file under the owner and re-reads the row', async () => {
    vi.mocked(setIndexingMode).mockResolvedValue({ node: { id: FILE_ID }, requeued: 1 } as never);
    const res = await fileSetIndexing.handler({ file_id: FILE_ID, mode: 'metadata' }, ctx);
    expect(setIndexingMode).toHaveBeenCalledWith({
      ownerId: 'o1',
      nodeId: FILE_ID,
      mode: 'metadata',
    });
    expect(fileById).toHaveBeenCalledWith({ ownerId: 'o1', fileId: FILE_ID });
    const out = outputOf(res) as { file: unknown; requeued: number; note: string };
    expect(out.file).toBe(row);
    expect(out.requeued).toBe(1);
    // The model needs to know the change is asynchronous, or it will report
    // "done" and the user will search for content that is still indexed.
    expect(out.note).toMatch(/re-indexing queued/);
  });

  it('says no re-index was needed when the store queued nothing', async () => {
    const out = outputOf(
      await fileSetIndexing.handler({ file_id: FILE_ID, mode: 'inherit' }, ctx),
    ) as { note: string };
    expect(out.note).toMatch(/no re-indexing needed/);
  });

  it('passes a store refusal through (wrong node type, unknown id)', async () => {
    vi.mocked(setIndexingMode).mockRejectedValue(
      new Error(`setIndexingMode: node ${FILE_ID} not found`),
    );
    expect(errorOf(await fileSetIndexing.handler({ file_id: FILE_ID, mode: 'full' }, ctx))).toMatch(
      /not found/,
    );
    expect(fileById).not.toHaveBeenCalled();
  });
});

describe('file_move', () => {
  it('refuses a blank file_id or dest_path WITHOUT calling the store', async () => {
    expect(errorOf(await fileMove.handler({ file_id: '', dest_path: 'files.a' }, ctx))).toMatch(
      /file_id and dest_path required/,
    );
    expect(errorOf(await fileMove.handler({ file_id: FILE_ID, dest_path: '' }, ctx))).toMatch(
      /file_id and dest_path required/,
    );
    expect(moveFileById).not.toHaveBeenCalled();
  });

  it('moves under the owner and returns the relocated row', async () => {
    const moved = { ...row, parentPath: 'files.archive' };
    vi.mocked(moveFileById).mockResolvedValue(moved as never);
    const res = await fileMove.handler({ file_id: FILE_ID, dest_path: 'files.archive' }, ctx);
    expect(moveFileById).toHaveBeenCalledWith({
      ownerId: 'o1',
      fileId: FILE_ID,
      destPath: 'files.archive',
    });
    expect(outputOf(res)).toBe(moved);
  });

  it('passes the store refusal through when the destination is not the owner’s or has a clash', async () => {
    // The ownership check lives in the store (the owner id it received is
    // what makes it fail); the tool must surface that verdict, not mask it.
    vi.mocked(moveFileById).mockRejectedValue(
      new Error("moveFileById: no folder at 'files.other' — create it with folder_create first"),
    );
    const err = errorOf(
      await fileMove.handler({ file_id: FILE_ID, dest_path: 'files.other' }, ctx),
    );
    expect(err).toMatch(/no folder at 'files.other'/);
  });
});

describe('file_copy', () => {
  it('refuses a blank file_id or dest_path WITHOUT calling the store', async () => {
    expect(errorOf(await fileCopy.handler({ file_id: '', dest_path: 'files.a' }, ctx))).toMatch(
      /file_id and dest_path required/,
    );
    expect(errorOf(await fileCopy.handler({ file_id: FILE_ID, dest_path: '' }, ctx))).toMatch(
      /file_id and dest_path required/,
    );
    expect(copyFileById).not.toHaveBeenCalled();
  });

  it('copies under the owner, keeping the source name when none is given', async () => {
    const res = await fileCopy.handler({ file_id: FILE_ID, dest_path: 'files.backups' }, ctx);
    expect(copyFileById).toHaveBeenCalledWith({
      ownerId: 'o1',
      fileId: FILE_ID,
      destPath: 'files.backups',
      newFilename: undefined,
    });
    // The output is the NEW row: a different id from the source.
    expect((outputOf(res) as { id: string }).id).toBe(NEW_ID);
  });

  it('forwards new_filename, and treats an empty one as absent', async () => {
    await fileCopy.handler(
      { file_id: FILE_ID, dest_path: 'files.backups', new_filename: 'notes-v2.md' },
      ctx,
    );
    expect(copyFileById).toHaveBeenCalledWith(
      expect.objectContaining({ newFilename: 'notes-v2.md' }),
    );
    vi.clearAllMocks();
    await fileCopy.handler({ file_id: FILE_ID, dest_path: 'files.backups', new_filename: '' }, ctx);
    // '' would reach the store as a real (invalid) filename; it must collapse
    // to "use the source's name".
    expect(copyFileById).toHaveBeenCalledWith(expect.objectContaining({ newFilename: undefined }));
  });

  it('passes a store refusal (name clash at the destination) through', async () => {
    vi.mocked(copyFileById).mockRejectedValue(
      new Error("copyFileById: 'notes.md' already exists in files.backups"),
    );
    expect(
      errorOf(await fileCopy.handler({ file_id: FILE_ID, dest_path: 'files.backups' }, ctx)),
    ).toMatch(/already exists/);
  });
});

describe('file_upload (operator surface)', () => {
  it('refuses a blank parent_path or filename WITHOUT touching the store', async () => {
    expect(
      errorOf(
        await fileUpload.handler({ parent_path: '', filename: 'a.txt', content_text: 'x' }, ctx),
      ),
    ).toMatch(/parent_path \+ filename required/);
    expect(
      errorOf(
        await fileUpload.handler(
          { parent_path: 'files.work', filename: '', content_text: 'x' },
          ctx,
        ),
      ),
    ).toMatch(/parent_path \+ filename required/);
    expect(upsertFile).not.toHaveBeenCalled();
  });

  it('refuses when neither content_text nor content_base64 is given', async () => {
    const res = await fileUpload.handler({ parent_path: 'files.work', filename: 'a.txt' }, ctx);
    expect(errorOf(res)).toMatch(/pass content_text or content_base64/);
    expect(upsertFile).not.toHaveBeenCalled();
  });

  it('refuses an indexing value outside full/metadata before writing anything', async () => {
    const res = await fileUpload.handler(
      { parent_path: 'files.work', filename: 'a.txt', content_text: 'x', indexing: 'inherit' },
      ctx,
    );
    expect(errorOf(res)).toMatch(/indexing must be 'full' or 'metadata'/);
    expect(upsertFile).not.toHaveBeenCalled();
    expect(setIndexingMode).not.toHaveBeenCalled();
  });

  it('writes content_text as utf-8 under the owner, with no indexing side call', async () => {
    const res = await fileUpload.handler(
      { parent_path: 'files.work', filename: 'a.txt', content_text: 'héllo' },
      ctx,
    );
    expect(upsertFile).toHaveBeenCalledWith({
      ownerId: 'o1',
      parentPath: 'files.work',
      filename: 'a.txt',
      bytes: Buffer.from('héllo', 'utf8'),
      overwrite: undefined,
    });
    expect(setIndexingMode).not.toHaveBeenCalled();
    // Without an indexing request the row goes back untouched: no `indexing`
    // key is bolted on.
    expect(outputOf(res)).toBe(row);
  });

  it('decodes content_base64 into the exact bytes before storing', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    await fileUpload.handler(
      { parent_path: 'files.work', filename: 'a.png', content_base64: bytes.toString('base64') },
      ctx,
    );
    expect(upsertFile).toHaveBeenCalledWith(expect.objectContaining({ bytes }));
  });

  it('prefers content_text when both are given', async () => {
    await fileUpload.handler(
      {
        parent_path: 'files.work',
        filename: 'a.txt',
        content_text: 'text wins',
        content_base64: Buffer.from('binary loses').toString('base64'),
      },
      ctx,
    );
    expect(upsertFile).toHaveBeenCalledWith(
      expect.objectContaining({ bytes: Buffer.from('text wins', 'utf8') }),
    );
  });

  it('rejects a payload over MAX_UPLOAD_BYTES before it reaches the store', async () => {
    const res = await fileUpload.handler(
      {
        parent_path: 'files.work',
        filename: 'big.txt',
        content_text: 'a'.repeat(MAX_UPLOAD_BYTES + 1),
      },
      ctx,
    );
    const err = errorOf(res);
    expect(err).toMatch(/too large/);
    expect(err).not.toMatch(/video_ingest/);
    expect(upsertFile).not.toHaveBeenCalled();
  });

  it('points an over-size MEDIA file at video_ingest instead of a bare refusal', async () => {
    const res = await fileUpload.handler(
      {
        parent_path: 'files.work',
        filename: 'clip.mp4',
        content_text: 'a'.repeat(MAX_UPLOAD_BYTES + 1),
      },
      ctx,
    );
    expect(errorOf(res)).toMatch(/video_ingest/);
    expect(upsertFile).not.toHaveBeenCalled();
  });

  it("applies indexing: 'metadata' to the NEW row after the write and echoes it", async () => {
    const res = await fileUpload.handler(
      { parent_path: 'files.work', filename: 'a.txt', content_text: 'x', indexing: 'metadata' },
      ctx,
    );
    expect(setIndexingMode).toHaveBeenCalledWith({
      ownerId: 'o1',
      nodeId: FILE_ID,
      mode: 'metadata',
    });
    // Order matters: the flag is set on the row the write produced.
    expect(vi.mocked(upsertFile).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(setIndexingMode).mock.invocationCallOrder[0]!,
    );
    expect(outputOf(res)).toEqual({ ...row, indexing: 'metadata' });
  });

  it('prefixes a store failure so the caller knows which tool refused', async () => {
    vi.mocked(upsertFile).mockRejectedValue(new Error('a.txt already exists'));
    const res = await fileUpload.handler(
      { parent_path: 'files.work', filename: 'a.txt', content_text: 'x' },
      ctx,
    );
    expect(errorOf(res)).toMatch(/^file_upload failed: a.txt already exists/);
  });
});
