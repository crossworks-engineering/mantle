/**
 * The golden compare of the move of the PDF set, `pdf-router` and
 * `drawing-pdf` (docs/pipelines.md, "The same-result proof of a move"). The
 * golden files in packages/files/src/pipelines/pkg/drawing-pdf/golden/ were
 * written by the OLD path (parsePdfDrawing through a real parser's
 * pdfDrawing job) before the move, in their own commit. Here the core's own
 * read runs (parseFileSheets: the router's job, then the reader's), with the
 * parser's `pipelineRun` job run in this process (inProcessPipelineFetch),
 * and it must give the same golden text, the same kind and the same router
 * count. A golden file is never changed to make this pass.
 *
 * One column is masked, on both sides: `Read ms` of the Pages tab is the
 * time the read of a page took, a clock value, another number on every
 * read of the same bytes. The golden files hold null in its place. It is
 * not a "same word, other shape" case: it is a time.
 *
 * The eye: the in-process job answers as a parser with no OpenCV (no
 * picture, no eye), as the host lane that wrote the golden files had none.
 * A raster page's kind is the rules' own there.
 *
 * The cost changed, as the design says: a PDF drawing is two jobs now (the
 * router's and the reader's), an unsure one the decider is asked about
 * three (the router's second step takes the answer), a document and a
 * damaged file one.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  builtinForExt,
  effectiveOptions,
  optionsHash,
  PIPELINE_API,
  pipelineStampOf,
  resetParserFailures,
  type PdfKindDecision,
} from '@mantle/files';
import { PIPELINE_PACKAGES } from '@mantle/files/pipelines/pkg';
import { inProcessPipelineFetch, inProcessStepJob } from '@mantle/files/pipelines/test-job';
import type { PipelineCallAnswer, PipelineStepRequest } from '@mantle/files/pipelines/contract';
import type { ParsedSheet } from '@mantle/files/sheet-to-grid';
import { goldenOf } from './pipeline-golden';

const counted = vi.hoisted(() => [] as string[]);
vi.mock('./pipeline-state', () => ({
  countPipelineRun: vi.fn(async (_owner: string, pipelineId: string) => {
    counted.push(pipelineId);
  }),
  pipelineStateOf: vi.fn(),
}));

const { parseFileSheets } = await import('./file-database');
type ParsedFile = Awaited<ReturnType<typeof parseFileSheets>>;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(HERE, '..', '..', 'files', 'src', 'pipelines', 'pkg', 'drawing-pdf');
const FIXTURES = readdirSync(path.join(PKG, 'fixtures'))
  .filter((n) => n.endsWith('.pdf'))
  .sort();
const READER = builtinForExt('pdf')!;
const dir = mkdtempSync(path.join(os.tmpdir(), 'drawing-pdf-golden-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const fixture = (name: string) => readFileSync(path.join(PKG, 'fixtures', name));
const golden = (name: string) =>
  JSON.parse(readFileSync(path.join(PKG, 'golden', name), 'utf8')) as Record<string, unknown>;
const count = { ownerId: 'owner', fileId: 'file' };

/** `Read ms` is a clock value: null in its place, as in the golden files. */
function masked(parsed: ParsedFile): ParsedFile {
  if (parsed.kind !== 'sheets') return parsed;
  return {
    ...parsed,
    sheets: parsed.sheets.map((s) => {
      const i = s.columns.findIndex((c) => c.name === 'Read ms');
      return i < 0 ? s : { ...s, rows: s.rows.map((r) => r.map((v, j) => (j === i ? null : v))) };
    }),
  };
}
const gold = (parsed: ParsedFile) => JSON.parse(goldenOf(masked(parsed))) as unknown;

/** The core's read, with the parser's job run in this process: the
 *  ParsedFile, the parser jobs it took, and the router's count. */
async function read(
  bytes: Buffer,
  opts: { decide?: PdfKindDecision; options?: Record<string, unknown> } = {},
) {
  const inner = inProcessPipelineFetch();
  let jobs = 0;
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    jobs += 1;
    return inner(input, init);
  });
  const asked: unknown[] = [];
  const parsed = await parseFileSheets(bytes, 'pdf', {
    count,
    ...(opts.options ? { options: opts.options } : {}),
    ...(opts.decide
      ? {
          pdfKind: async (state) => {
            asked.push(state);
            return opts.decide!;
          },
        }
      : {}),
  });
  return { parsed, jobs, asked, routed: counted.filter((id) => id === 'pdf-router').length };
}

const DECISIONS: Record<string, PdfKindDecision> = {
  'decider-live-pfd': {
    kind: 'pfd',
    confidence: 0.912,
    model: 'made-up-model',
    mode: 'live',
    used: true,
  },
  'decider-shadow': {
    kind: 'pid',
    confidence: 0.77,
    model: 'made-up-model',
    mode: 'shadow',
    used: false,
  },
  'decider-document': {
    kind: 'document',
    confidence: 0.95,
    model: 'made-up-model',
    mode: 'live',
    used: true,
  },
};

beforeEach(() => {
  vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
  vi.stubEnv('PARSER_TOKEN', 't');
  counted.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetParserFailures();
});

describe('drawing-pdf and pdf-router: the packages give what the old path gave', () => {
  it('the fixed set is the nine made-up PDF files, and the manifests are packages', () => {
    expect(FIXTURES).toEqual([
      'damaged.pdf',
      'document.pdf',
      'isometric.pdf',
      'odd-values.pdf',
      'other-drawing.pdf',
      'pid.pdf',
      'scan.pdf',
      'unsure-vector.pdf',
      'unsure.pdf',
    ]);
    expect(READER).toMatchObject({ id: 'drawing-pdf', runtime: 'bun', entry: 'step.ts' });
    expect(READER.needs).toEqual({ weight: 'light', timeMs: 240_000, workers: { vision: 40 } });
  });

  for (const name of FIXTURES) {
    it(`${name}: the same ParsedFile, the same kind, the same router count`, async () => {
      const kind = golden(`${name}.kind.json`);
      const r = await read(fixture(name));
      expect(gold(r.parsed)).toEqual(golden(`${name}.json`));
      expect(r.parsed.kind).toBe(kind.parsed);
      const fileKind =
        r.parsed.kind === 'sheets'
          ? (r.parsed.sheets.find((s) => s.name === 'File')?.rows[0]?.[0] ?? null)
          : null;
      expect(fileKind).toBe(kind.kind);
      expect(r.routed).toBe(kind.routerCounted);
      expect(createHash('sha256').update(fixture(name)).digest('hex')).toBe(kind.sha256);
      // The cost of the move: two jobs for a drawing, one for a document
      // and for a file the router cannot open.
      expect(r.jobs).toBe(r.parsed.kind === 'sheets' ? 2 : 1);
      expect(r.asked).toEqual([]);
    });
  }

  for (const name of ['unsure.pdf', 'unsure-vector.pdf']) {
    for (const [tag, decision] of Object.entries(DECISIONS)) {
      it(`${name}, ${tag}: the decider's answer gives the same tabs and File tab`, async () => {
        const r = await read(fixture(name), { decide: decision });
        expect(gold(r.parsed)).toEqual(golden(`${name}.${tag}.json`));
        // One ask, one router count; the router's second step is a job.
        expect(r.asked).toHaveLength(1);
        expect(r.routed).toBe(1);
        expect(r.jobs).toBe(r.parsed.kind === 'sheets' ? 3 : 2);
      });
    }
  }

  it('pid.pdf: a decider is never asked for a kind the rules named', async () => {
    const r = await read(fixture('pid.pdf'), { decide: DECISIONS['decider-live-pfd'] });
    expect(gold(r.parsed)).toEqual(golden('pid.pdf.decider-not-asked.json'));
    expect(r.asked).toEqual([]);
  });

  it('pid.pdf: a title block box that is not the default, and its stamp', async () => {
    const box = { title_block_width_mm: 120, title_block_height_mm: 45 };
    const r = await read(fixture('pid.pdf'), { options: box });
    expect(gold(r.parsed)).toEqual(golden('pid.pdf.title-block.json'));
    if (r.parsed.kind !== 'sheets') throw new Error('no sheets');
    const hash = optionsHash(READER, effectiveOptions(READER, box));
    expect(r.parsed.optionsHash).toBe(hash);
    expect(
      pipelineStampOf(
        READER,
        r.parsed.sheets.map((s) => ({ name: s.name, columns: s.columns.map((c) => c.name) })),
        hash,
      ),
    ).toMatchObject({
      pipeline_id: 'drawing-pdf',
      pipeline_version: '1.0.0',
      pipeline_api: '1',
      shapes: 'pdf-file-v1',
      pipeline_options: hash,
    });
  });
});

/** The made-up pieces and answers the golden sketch read was made of. */
type SketchInput = {
  model: string;
  answers: (string | null)[][];
  pieces: {
    page: number;
    status: string;
    dpi: number;
    pictures: number;
    pieces: { box: number[]; picture: number; scale: number }[];
    notSent: number[][];
  }[];
};
const SKETCH = JSON.parse(
  readFileSync(path.join(PKG, 'fixtures', 'scan.sketch-input.json'), 'utf8'),
) as SketchInput;

/** The stored File tab's facts of scan.pdf, from its golden database. */
function storedScan() {
  const file = (golden('scan.pdf.json').sheets as ParsedSheet[]).find((s) => s.name === 'File')!;
  const at = (n: string) => file.rows[0]![file.columns.findIndex((c) => c.name === n)];
  return { rulesKind: String(at('Rules kind')), notReadWhole: Number(at('Pages not read whole')) };
}

/** The reader's step in this process, with the made-up pieces of the
 *  golden sketch read in place of the cutter. */
async function sketchStep(request: Partial<PipelineStepRequest>) {
  const { step } = await PIPELINE_PACKAGES['drawing-pdf']!();
  const cuts: string[] = [];
  const job = inProcessStepJob(fixture('scan.pdf'), dir, {
    pdfPictures: async (windows) =>
      windows.map((w) => ({
        png: Buffer.from(`page ${w.pageNumber}`),
        widthPx: 1,
        heightPx: 1,
        scale: w.scale,
        widthMm: 841,
        heightMm: 594,
      })) as never,
    pdfPagePieces: async (_png, _mm, name) => {
      cuts.push(name);
      const p = SKETCH.pieces[cuts.length - 1]!;
      return {
        dpi: p.dpi,
        pieces: p.pieces,
        notSent: p.notSent,
        pictures: Array.from({ length: p.pictures }, (_, k) => Buffer.from(`picture ${k}`)),
      };
    },
  });
  const result = await step(
    { api: PIPELINE_API, step: 1, options: effectiveOptions(READER, {}), ...request },
    job,
  );
  return { result: JSON.parse(JSON.stringify(result)) as typeof result, cuts };
}

describe('the sketch read: the later steps of drawing-pdf', () => {
  it('scan.pdf: the same database and the same text of the scan as the old sketch read', async () => {
    const state = { decision: null, ...storedScan() };
    const one = await sketchStep({ asks: true, kind: 'scan', state });
    const calls = one.result.calls ?? [];
    expect(calls.map((c) => c.call === 'worker' && c.worker)).toEqual(['vision', 'vision']);
    expect(
      calls.map((c) => (c.call === 'worker' ? (c.input as { pieces: number }).pieces : -1)),
    ).toEqual([2, 1]);
    // The answers as the core gives them: a call that did not run is no answer.
    const answers: PipelineCallAnswer[] = SKETCH.answers[0]!.map((text) =>
      text === null
        ? { ok: false, error: 'failed' }
        : { ok: true, output: { text, model: SKETCH.model } },
    );
    const two = await sketchStep({
      step: 2,
      asks: true,
      kind: 'scan',
      state: one.result.state,
      answers,
    });
    const write = two.result.calls?.find((c) => c.call === 'tool');
    const input = write?.input as { tabs: ParsedSheet[]; description: string; text: string };
    expect(gold({ kind: 'sheets', sheets: input.tabs, description: input.description })).toEqual(
      golden('scan.pdf.sketch.json'),
    );
    const text = golden('scan.pdf.sketch.text.json');
    expect({
      sha256: createHash('sha256').update(input.text).digest('hex'),
      length: input.text.length,
    }).toEqual({ sha256: text.sha256, length: text.length });
  });

  it('a read poorer than the first asks nothing and writes nothing: no vision call is paid', async () => {
    const stored = storedScan();
    for (const state of [
      { decision: null, ...stored, rulesKind: 'pid' },
      { decision: null, ...stored, notReadWhole: stored.notReadWhole - 1 },
      // No stored facts: nothing to keep a read against.
      { decision: null },
    ]) {
      const r = await sketchStep({ asks: true, kind: 'scan', state });
      expect(r.result).toEqual({ status: 'ok' });
      expect(r.cuts).toEqual([]);
    }
  });

  it('no picture read by the model: step 2 writes nothing', async () => {
    const one = await sketchStep({
      asks: true,
      kind: 'scan',
      state: { decision: null, ...storedScan() },
    });
    const two = await sketchStep({
      step: 2,
      asks: true,
      kind: 'scan',
      state: one.result.state,
      answers: [
        { ok: false, error: 'failed' },
        { ok: false, error: 'not_available' },
      ],
    });
    expect(two.result).toEqual({ status: 'ok' });
  });

  it('a kind that is no sketch kind cuts nothing and asks nothing', async () => {
    const r = await sketchStep({
      asks: true,
      kind: 'pid',
      state: { decision: null, ...storedScan(), rulesKind: 'scan' },
    });
    expect(r.result).toEqual({ status: 'ok' });
    expect(r.cuts).toEqual([]);
  });
});
