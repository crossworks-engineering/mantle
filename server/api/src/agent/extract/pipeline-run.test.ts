/**
 * The job of a run on demand (pipeline-run.ts), with the build, the patch
 * and the file read as stand-ins:
 *  - a reader's job builds with no parse result and no decider: the PDF
 *    decider and the sketch read are spies that fail when called;
 *  - an `after` job is the patch, and reads no bytes;
 *  - the reader of a PDF drawing is refused with the word `pdf`;
 *  - a throw of the patch ("the database changed during the patch") is a
 *    failed run: the job does not throw, so the queue sends nothing again;
 *  - the job starts no extract and changes no summary: it never calls the
 *    re-index doors.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  builds: [] as Record<string, unknown>[],
  patches: [] as Record<string, unknown>[],
  reads: 0,
  patchThrows: false,
}));

vi.mock('@mantle/files', async (orig) => ({
  ...(await orig<typeof import('@mantle/files')>()),
  fileDataRow: vi.fn(async (_o: string, id: string) => ({
    id,
    path: 'files',
    title: id.startsWith('d') ? 'P-101.dxf' : id.startsWith('p') ? 'plan.pdf' : 'notes.txt',
    data: {
      filename: id.startsWith('d') ? 'P-101.dxf' : id.startsWith('p') ? 'plan.pdf' : 'notes.txt',
      sha256: 'b'.repeat(64),
    },
  })),
  readFileNodeBytes: vi.fn(async () => {
    h.reads += 1;
    return { bytes: Buffer.from('made-up'), filename: 'P-101.dxf', ext: 'dxf', mime: '' };
  }),
}));

vi.mock('@mantle/content/file-database', () => ({
  buildFileDatabase: vi.fn(async (args: Record<string, unknown>) => {
    h.builds.push(args);
    return { status: 'built', tabs: 2, rows: 10 };
  }),
  patchFileDatabase: vi.fn(async (args: Record<string, unknown>) => {
    h.patches.push(args);
    if (h.patchThrows) throw new Error('the database changed during the patch');
    return { status: 'patched', tabs: 1, rows: 3, warnings: [] };
  }),
}));

// No trace store here: the trace and its step run their bodies.
vi.mock('@mantle/tracing', async (orig) => ({
  ...(await orig<typeof import('@mantle/tracing')>()),
  startTrace: vi.fn((_init: unknown, fn: () => Promise<unknown>) => fn()),
  step: vi.fn((_init: unknown, fn: (h: unknown) => Promise<unknown>) =>
    fn({ setMeta: () => {}, setError: () => {}, setOutput: () => {}, setSkipped: () => {} }),
  ),
}));

// A model ask of any kind fails the test.
const spend = vi.hoisted(() => () => {
  throw new Error('a run on demand asked a model');
});
vi.mock('./pdf-kind', () => ({ askPdfKind: vi.fn(spend) }));
vi.mock('./pdf-sketch', () => ({ readPdfSketch: vi.fn(spend), maybePdfSketch: vi.fn(spend) }));
vi.mock('../extractor.js', () => ({ extractNode: vi.fn(spend) }));
vi.mock('@mantle/db', async (orig) => ({
  ...(await orig<typeof import('@mantle/db')>()),
  notifyNodeIngested: vi.fn(spend),
  resignalNode: vi.fn(spend),
  markContentChanged: vi.fn(spend),
}));

const { runPipelineJob, isAfterRun } = await import('./pipeline-run');
const { startTrace } = await import('@mantle/tracing');

const OWNER = '00000000-0000-4000-8000-000000000000';
const DXF = 'd0000000-0000-4000-8000-000000000000';
const PDF = 'p0000000-0000-4000-8000-000000000000';

beforeEach(() => {
  h.builds = [];
  h.patches = [];
  h.reads = 0;
  h.patchThrows = false;
});

describe('the job of a run on demand', () => {
  it("a reader's job builds with no parse result and no decider", async () => {
    expect(await runPipelineJob(OWNER, DXF, 'drawing-cad')).toEqual({
      status: 'built',
      tabs: 2,
      rows: 10,
    });
    expect(h.builds).toHaveLength(1);
    expect(Object.keys(h.builds[0]!).sort()).toEqual([
      'bytes',
      'fileId',
      'filename',
      'ownerId',
      'sha256',
    ]);
    expect(h.patches).toEqual([]);
    // A run is no extract: its trace has a kind of its own (0374).
    expect(vi.mocked(startTrace).mock.calls.at(-1)?.[0]).toMatchObject({ kind: 'pipeline_run' });
  });

  it('a reader runs only on a file it reads', async () => {
    expect(await runPipelineJob(OWNER, DXF, 'sheet')).toEqual({
      status: 'skipped',
      reason: 'no-reader',
    });
    expect(h.builds).toEqual([]);
  });

  it('an after job is the patch, and reads no bytes', async () => {
    expect(await runPipelineJob(OWNER, DXF, 'site-tags')).toMatchObject({ status: 'patched' });
    expect(h.patches).toHaveLength(1);
    expect(h.reads).toBe(0);
    expect(isAfterRun('site-tags')).toBe(true);
    expect(isAfterRun('drawing-cad')).toBe(false);
  });

  it('the reader of a PDF drawing is refused: pdf', async () => {
    expect(await runPipelineJob(OWNER, PDF, 'drawing-pdf')).toEqual({
      status: 'skipped',
      reason: 'pdf',
    });
    expect([h.builds, h.patches]).toEqual([[], []]);
  });

  it('a throw of the patch is a failed run, and the job does not throw', async () => {
    h.patchThrows = true;
    await expect(runPipelineJob(OWNER, DXF, 'site-tags')).resolves.toEqual({ status: 'failed' });
  });

  it('an unknown pipeline writes nothing', async () => {
    expect(await runPipelineJob(OWNER, DXF, 'no-such')).toEqual({
      status: 'skipped',
      reason: 'unknown-pipeline',
    });
    expect([h.builds, h.patches]).toEqual([[], []]);
  });
});
