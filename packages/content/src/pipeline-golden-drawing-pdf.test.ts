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
 * One column is masked, on both sides (CLOCK_COLUMNS of @mantle/files):
 * `Read ms` of the Pages tab is the time the read of a page took, a clock
 * value, another number on every read of the same bytes. The golden files hold null in its place. It is
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
  readerFor,
  BUILTIN_PIPELINES,
  CLOCK_COLUMNS,
  effectiveOptions,
  optionsHash,
  pipelineStampOf,
  resetParserFailures,
  pdfDrawingSheets,
  sketchMarkdown,
  sketchPageRead,
  sketchPagesOf,
  titleBlockOf,
  type PdfKindDecision,
  type SketchPagePieces,
  type SketchRead,
} from '@mantle/files';
import { readPdfDrawingInJob } from '@mantle/files/readers/pdf-drawing';
import { inProcessPipelineFetch, inProcessStepJob } from '@mantle/files/pipelines/test-job';
import { goldenOf } from './pipeline-golden';
import { boxPipelines } from './pipeline-registry';
/** The box's pipelines (the registry): the built-ins. */
const pipelines = await boxPipelines('made-up-owner');

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
const READER = readerFor(BUILTIN_PIPELINES, 'pdf')!;
const dir = mkdtempSync(path.join(os.tmpdir(), 'drawing-pdf-golden-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const fixture = (name: string) => readFileSync(path.join(PKG, 'fixtures', name));
const golden = (name: string) =>
  JSON.parse(readFileSync(path.join(PKG, 'golden', name), 'utf8')) as Record<string, unknown>;
const count = { ownerId: 'owner', fileId: 'file' };

/** The clock columns (CLOCK_COLUMNS): null in their place, as in the golden files. */
function masked(parsed: ParsedFile): ParsedFile {
  if (parsed.kind !== 'sheets') return parsed;
  return {
    ...parsed,
    sheets: parsed.sheets.map((s) => {
      const clock = CLOCK_COLUMNS.get(s.name) ?? [];
      const hit = s.columns.map((c) => clock.includes(c.name));
      return { ...s, rows: s.rows.map((r) => r.map((v, j) => (hit[j] ? null : v))) };
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
    pipelines,
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
    expect(READER.needs).toEqual({ weight: 'light', timeMs: 240_000 });
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
  pieces: (Omit<SketchPagePieces, 'pictures'> & { pictures: number })[];
};
const SKETCH = JSON.parse(
  readFileSync(path.join(PKG, 'fixtures', 'scan.sketch-input.json'), 'utf8'),
) as SketchInput;

describe('the sketch read: a core path with the reader kit, as before the move', () => {
  it('scan.pdf: the same database and the same text of the scan as the old sketch read', async () => {
    // The core path (server/api/src/agent/extract/pdf-sketch.ts) after its
    // two kit jobs: the page facts (here the reader's read in this process,
    // as the plain golden compare above proves it equal), the made-up pieces
    // in place of the cutter's job, the made-up answers in place of the
    // vision calls, then the rows and the text in this process, with the
    // stored kind (`scan`).
    const titleBlock = titleBlockOf({});
    const drawing = await readPdfDrawingInJob(
      fixture('scan.pdf'),
      inProcessStepJob(Buffer.alloc(0), dir),
      titleBlock,
    );
    const { pages, pastCap } = sketchPagesOf(drawing, 'scan');
    expect(pages).toEqual(SKETCH.pieces.map((p) => p.page));
    const read: SketchRead['pages'] = SKETCH.pieces.map((p, i) =>
      sketchPageRead(
        { ...p, pictures: Array.from({ length: p.pictures }, () => Buffer.alloc(1)) },
        SKETCH.answers[i]!,
      ),
    );
    const sketch: SketchRead = {
      model: SKETCH.model,
      pages: read,
      pagesPastCap: pastCap,
      titleBlock,
    };
    const built = pdfDrawingSheets(drawing, null, sketch, 'scan');
    expect(gold({ kind: 'sheets', sheets: built.sheets, description: built.description })).toEqual(
      golden('scan.pdf.sketch.json'),
    );
    const text = sketchMarkdown(drawing, sketch);
    expect({
      sha256: createHash('sha256').update(text).digest('hex'),
      length: text.length,
      scanPages: pages,
      pastCap,
    }).toEqual(golden('scan.pdf.sketch.text.json'));
  });
});
