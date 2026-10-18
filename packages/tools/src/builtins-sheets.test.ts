/**
 * Tests for sheet_build, the tool that turns a workbook spec into a styled
 * .xlsx under /files.
 *
 * The renderer (buildSheet) and the file store (saveExport, where an export
 * lands) are stubbed; the filename normalisation, the error split, and
 * the save-and-report path are real.
 *
 * What is worth pinning:
 *
 *  - The destination is the tool's to choose. A folder the model prefixes
 *    onto the filename is stripped, and the file lands where an export
 *    lands (saveExport), so an agent cannot write a spreadsheet into an
 *    arbitrary path.
 *  - A spec error reaches the model VERBATIM. buildSheet's SheetSpecError
 *    names the sheet and key at fault; flattening it into "build failed"
 *    would cost the agent the one fact it needs to fix the call. Any other
 *    failure is prefixed so the two are distinguishable.
 *  - Nothing is saved when the build fails. saveExport must not be reached
 *    on either error arm.
 *  - The ingest trace records the file id, because a built sheet is a node
 *    the brain should know about, and reports the row total across sheets.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/content', () => {
  class SheetSpecError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'SheetSpecError';
    }
  }
  return { buildSheet: vi.fn(), SheetSpecError };
});
vi.mock('@mantle/files', () => ({ saveExport: vi.fn() }));
vi.mock('@mantle/tracing', () => ({ recordIngest: vi.fn(async () => undefined) }));

import { buildSheet, SheetSpecError } from '@mantle/content';
import { saveExport } from '@mantle/files';
import { recordIngest } from '@mantle/tracing';
import { SHEET_TOOLS, SHEET_TOOL_SLUGS } from './builtins-sheets';
import type { ToolHandlerContext } from './types';

const build = SHEET_TOOLS.find((t) => t.slug === 'sheet_build')!;
const ctx: ToolHandlerContext = { ownerId: 'o1' };

type Result = Awaited<ReturnType<(typeof build)['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

const sheets = [
  {
    name: 'Quote',
    columns: [
      { key: 'item', header: 'Item' },
      { key: 'amount', header: 'Amount', type: 'currency' },
    ],
    rows: [
      { item: 'Bolt', amount: 4 },
      { item: 'Nut', amount: 2 },
    ],
  },
  { name: 'Notes', columns: [{ key: 'n', header: 'Note' }], rows: [{ n: 'x' }] },
];

const BYTES = Buffer.from('xlsx');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(buildSheet).mockResolvedValue(BYTES);
  vi.mocked(saveExport).mockImplementation(
    async (args) =>
      ({
        file: {
          id: 'file_1',
          filename: args.filename,
          parentPath: 'files.exports.2026_09_03',
          sizeBytes: args.bytes?.length ?? 0,
        },
        autoFiled: true,
        landedIn: null,
      }) as never,
  );
});

describe('sheet_build', () => {
  it('is registered and exported in the slug list', () => {
    expect(build).toBeDefined();
    expect(SHEET_TOOL_SLUGS).toContain('sheet_build');
  });

  it('refuses a blank filename, and a bare folder, before building', async () => {
    expect(errorOf(await build.handler({ filename: '  ', sheets }, ctx))).toMatch(
      /filename is required/,
    );
    expect(errorOf(await build.handler({ filename: 'exports/', sheets }, ctx))).toMatch(
      /filename is required/,
    );
    expect(buildSheet).not.toHaveBeenCalled();
  });

  it('refuses a non-array `sheets` before building', async () => {
    expect(errorOf(await build.handler({ filename: 'q.xlsx', sheets: {} }, ctx))).toMatch(
      /sheets must be an array/,
    );
    expect(buildSheet).not.toHaveBeenCalled();
  });

  it('strips any folder prefix and normalises the extension', async () => {
    await build.handler({ filename: 'reports/2026/Q1 Pack.XLSX', sheets }, ctx);
    // The destination is where an export lands, never the model's path.
    expect(saveExport).toHaveBeenCalledWith(expect.objectContaining({ filename: 'Q1 Pack.xlsx' }));
    expect(Object.keys(vi.mocked(saveExport).mock.calls[0]![0]).sort()).toEqual([
      'bytes',
      'filename',
      'ownerId',
    ]);
  });

  it('passes a spec error through VERBATIM and saves nothing', async () => {
    vi.mocked(buildSheet).mockRejectedValue(new SheetSpecError("sheet 'Quote': unknown key 'amt'"));
    const res = await build.handler({ filename: 'q', sheets }, ctx);
    expect(errorOf(res)).toBe("sheet 'Quote': unknown key 'amt'");
    expect(saveExport).not.toHaveBeenCalled();
  });

  it('prefixes any other build failure so it is distinguishable from a spec error', async () => {
    vi.mocked(buildSheet).mockRejectedValue(new Error('out of memory'));
    expect(errorOf(await build.handler({ filename: 'q', sheets }, ctx))).toBe(
      'sheet build failed: out of memory',
    );
    expect(saveExport).not.toHaveBeenCalled();
  });

  it('saves the bytes owner-scoped where an export lands and reports the file', async () => {
    const res = await build.handler({ filename: 'q1', sheets }, ctx);
    expect(buildSheet).toHaveBeenCalledWith({ sheets });
    expect(saveExport).toHaveBeenCalledWith({ ownerId: 'o1', filename: 'q1.xlsx', bytes: BYTES });
    expect(outputOf(res)).toEqual({
      file_id: 'file_1',
      filename: 'q1.xlsx',
      path: 'files.exports.2026_09_03/q1.xlsx',
      size_bytes: BYTES.length,
      sheets: [
        { name: 'Quote', columns: 2, rows: 2 },
        { name: 'Notes', columns: 1, rows: 1 },
      ],
    });
  });

  it('names where a sheet landed when the store says (landedIn)', async () => {
    vi.mocked(saveExport).mockResolvedValueOnce({
      file: { id: 'file_2', filename: 'q2.xlsx', parentPath: 'files', sizeBytes: 3 },
      autoFiled: false,
      landedIn: { id: 'ws1', name: 'Mine' },
    } as never);
    const res = await build.handler({ filename: 'q2', sheets }, ctx);
    expect(outputOf(res)).toMatchObject({
      path: 'files/q2.xlsx',
      landedIn: { id: 'ws1', name: 'Mine' },
    });
  });

  it('records the ingest against the new file with the row total across sheets', async () => {
    await build.handler({ filename: 'q1', sheets }, ctx);
    expect(recordIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'o1',
        nodeId: 'file_1',
        payload: expect.objectContaining({ via: 'sheet_build_tool', sheets: 2, rows: 3 }),
      }),
    );
  });

  it('surfaces a store failure instead of reporting a file id', async () => {
    vi.mocked(saveExport).mockRejectedValue(new Error('minio unreachable'));
    expect(errorOf(await build.handler({ filename: 'q1', sheets }, ctx))).toBe('minio unreachable');
    expect(recordIngest).not.toHaveBeenCalled();
  });
});
