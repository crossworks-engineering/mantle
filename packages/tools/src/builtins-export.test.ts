/**
 * Behavioural tests for export_node.
 *
 * The rendering (page/note to .docx, table to .xlsx) lives in
 * `@mantle/content`'s `resolveExport` and is stubbed here. What the tool
 * itself owns, and what is worth pinning:
 *
 *  - Owner scoping on BOTH edges: `resolveExport` gets `ctx.ownerId` (so a
 *    node the owner does not hold comes back null, not rendered), and the
 *    `loadImage` callback it is handed reads image bytes under the same owner.
 *    That callback is the one place a page export can pull a file that is not
 *    the page itself; it must not be an unscoped read.
 *  - The not-found arm is an error, not a silent empty file. A null from
 *    resolveExport means "not yours, or not exportable"; the tool must stop
 *    there without touching the file store.
 *  - The output format is whatever resolveExport chose from the node type;
 *    a caller-supplied filename is honoured for its stem only, and the
 *    extension is forced to match. Otherwise a user asking for `plan.xlsx`
 *    on a page gets a Word document with an Excel name.
 *  - The bytes reaching the store are the rendered bytes, unmodified, saved
 *    under the dated `exports` folder, and the returned path/id describe that
 *    saved file (the description promises "the new file's id, name, and
 *    path").
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/content', () => ({ resolveExport: vi.fn() }));
vi.mock('@mantle/files', () => ({
  ensureDatedUploadFolder: vi.fn(),
  readFileById: vi.fn(),
  upsertFile: vi.fn(),
}));
vi.mock('@mantle/tracing', () => ({ recordIngest: vi.fn() }));

import { resolveExport } from '@mantle/content';
import { ensureDatedUploadFolder, readFileById, upsertFile } from '@mantle/files';
import { recordIngest } from '@mantle/tracing';
import { EXPORT_TOOLS } from './builtins-export';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const exportNode = EXPORT_TOOLS.find((t) => t.slug === 'export_node')!;

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const NODE_ID = '11111111-2222-4333-8444-555555555555';
const FILE_ID = '22222222-2222-4333-8444-555555555555';
const IMAGE_ID = '33333333-2222-4333-8444-555555555555';
const EXPORT_PATH = 'files.exports.2026-09-03';

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

const docxBytes = Buffer.from('PK-docx-bytes');
const pageExport = {
  bytes: docxBytes,
  filename: 'runbook.docx',
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  format: 'docx',
  kind: 'page',
  title: 'Runbook',
};
const tableExport = {
  bytes: Buffer.from('PK-xlsx-bytes'),
  filename: 'budget.xlsx',
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  format: 'xlsx',
  kind: 'table',
  title: 'Budget',
};

/** What upsertFile hands back; the tool's output is built from this. */
function savedRow(filename: string, size: number) {
  return { id: FILE_ID, parentPath: EXPORT_PATH, filename, sizeBytes: size };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveExport).mockResolvedValue(pageExport as never);
  vi.mocked(ensureDatedUploadFolder).mockResolvedValue(EXPORT_PATH);
  vi.mocked(upsertFile).mockImplementation(
    async (args) => savedRow(args.filename, args.bytes?.byteLength ?? 0) as never,
  );
  vi.mocked(readFileById).mockResolvedValue(null);
  vi.mocked(recordIngest).mockResolvedValue(undefined as never);
});

describe('export_node', () => {
  it('refuses a blank or whitespace node_id WITHOUT rendering or writing', async () => {
    expect(errorOf(await exportNode.handler({ node_id: '' }, ctx))).toMatch(/node_id is required/);
    expect(errorOf(await exportNode.handler({ node_id: '   ' }, ctx))).toMatch(
      /node_id is required/,
    );
    expect(resolveExport).not.toHaveBeenCalled();
    expect(upsertFile).not.toHaveBeenCalled();
  });

  it('resolves the node under the owner, with the id trimmed', async () => {
    await exportNode.handler({ node_id: `  ${NODE_ID}  ` }, ctx);
    expect(resolveExport).toHaveBeenCalledWith(
      'o1',
      NODE_ID,
      expect.objectContaining({ loadImage: expect.any(Function) }),
    );
  });

  it('reads embedded images through loadImage under the SAME owner', async () => {
    vi.mocked(readFileById).mockResolvedValue({ bytes: Buffer.from('png') } as never);
    await exportNode.handler({ node_id: NODE_ID }, ctx);
    const opts = vi.mocked(resolveExport).mock.calls[0]![2]!;
    const loaded = await opts.loadImage!(IMAGE_ID);
    // An unscoped read here would let a page export embed any owner's image.
    expect(readFileById).toHaveBeenCalledWith({ ownerId: 'o1', fileId: IMAGE_ID });
    expect(loaded).toEqual({ bytes: Buffer.from('png') });
  });

  it('loadImage yields null for a missing image rather than throwing the whole export', async () => {
    vi.mocked(readFileById).mockResolvedValue(null);
    await exportNode.handler({ node_id: NODE_ID }, ctx);
    const opts = vi.mocked(resolveExport).mock.calls[0]![2]!;
    expect(await opts.loadImage!(IMAGE_ID)).toBeNull();
  });

  it('stops at not-found (not the owner’s, or not exportable) without touching the store', async () => {
    vi.mocked(resolveExport).mockResolvedValue(null);
    const err = errorOf(await exportNode.handler({ node_id: NODE_ID }, ctx));
    expect(err).toMatch(new RegExp(`${NODE_ID} not found`));
    expect(err).toMatch(/exportable page\/note\/table/);
    expect(ensureDatedUploadFolder).not.toHaveBeenCalled();
    expect(upsertFile).not.toHaveBeenCalled();
    expect(recordIngest).not.toHaveBeenCalled();
  });

  it('reports a render failure as such, and writes nothing', async () => {
    vi.mocked(resolveExport).mockRejectedValue(new Error('docx: unsupported block'));
    const err = errorOf(await exportNode.handler({ node_id: NODE_ID }, ctx));
    expect(err).toMatch(/^export failed: docx: unsupported block/);
    expect(upsertFile).not.toHaveBeenCalled();
  });

  it('saves a page as .docx under the dated exports folder and returns the file facts', async () => {
    const res = await exportNode.handler({ node_id: NODE_ID }, ctx);
    expect(ensureDatedUploadFolder).toHaveBeenCalledWith({
      ownerId: 'o1',
      topSlug: 'exports',
      topDescription: expect.any(String),
    });
    // The rendered bytes go to the store untouched, under the owner.
    expect(upsertFile).toHaveBeenCalledWith({
      ownerId: 'o1',
      parentPath: EXPORT_PATH,
      filename: 'runbook.docx',
      bytes: docxBytes,
    });
    expect(outputOf(res)).toEqual({
      file_id: FILE_ID,
      filename: 'runbook.docx',
      path: `${EXPORT_PATH}/runbook.docx`,
      format: 'docx',
      kind: 'page',
      size_bytes: docxBytes.byteLength,
    });
  });

  it('saves a table as .xlsx: the format follows the node type, not the caller', async () => {
    vi.mocked(resolveExport).mockResolvedValue(tableExport as never);
    const out = outputOf(await exportNode.handler({ node_id: NODE_ID }, ctx));
    expect(upsertFile).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'budget.xlsx', bytes: tableExport.bytes }),
    );
    expect(out.format).toBe('xlsx');
    expect(out.kind).toBe('table');
  });

  it('honours a caller filename for its stem but forces the extension to the chosen format', async () => {
    // A page asked for as `.xlsx` must still come out as Word: the format is
    // decided by the node type, and a mismatched extension would mislead
    // every consumer that trusts the name.
    const a = outputOf(await exportNode.handler({ node_id: NODE_ID, filename: 'plan.xlsx' }, ctx));
    expect(a.filename).toBe('plan.docx');
    vi.clearAllMocks();
    vi.mocked(resolveExport).mockResolvedValue(pageExport as never);
    vi.mocked(ensureDatedUploadFolder).mockResolvedValue(EXPORT_PATH);
    vi.mocked(upsertFile).mockImplementation(async (args) => savedRow(args.filename, 1) as never);
    const b = outputOf(await exportNode.handler({ node_id: NODE_ID, filename: 'plan' }, ctx));
    expect(b.filename).toBe('plan.docx');
    const c = outputOf(
      await exportNode.handler({ node_id: NODE_ID, filename: 'Plan v2.DOCX' }, ctx),
    );
    expect(c.filename).toBe('Plan v2.docx');
  });

  it('ignores a whitespace-only filename and keeps the rendered name', async () => {
    const out = outputOf(await exportNode.handler({ node_id: NODE_ID, filename: '   ' }, ctx));
    expect(out.filename).toBe('runbook.docx');
  });

  it('records the export as an ingest event pointing back at the source node', async () => {
    const agentCtx: ToolHandlerContext = {
      ownerId: 'o1',
      agent: { slug: 'responder', depth: 1, delegateTo: [] } as never,
    };
    await exportNode.handler({ node_id: NODE_ID }, agentCtx);
    expect(recordIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent_tool',
        ownerId: 'o1',
        nodeId: FILE_ID,
        summary: expect.stringMatching(/Exported page "Runbook" to DOCX: runbook\.docx/),
        payload: expect.objectContaining({
          via: 'export_node_tool',
          sourceNodeId: NODE_ID,
          format: 'docx',
          invokingAgent: 'responder',
        }),
      }),
    );
  });

  it('passes a store failure through and records no ingest for a file that was not saved', async () => {
    vi.mocked(upsertFile).mockRejectedValue(new Error('disk full'));
    expect(errorOf(await exportNode.handler({ node_id: NODE_ID }, ctx))).toMatch(/disk full/);
    expect(recordIngest).not.toHaveBeenCalled();
  });
});
