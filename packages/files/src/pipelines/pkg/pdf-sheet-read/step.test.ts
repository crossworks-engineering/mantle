/**
 * The step of the Agent `pdf-sheet-read`, on made-up PDFs drawn by the real
 * pdfjs in this process (the parser draws them in its child): the asks of a
 * one-page and a three-page drawing, the title block corner from the
 * Reader's box, the kinds it takes, the page cap and the fields of a site.
 * No parser, no model. No client file: every PDF is built here.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assemblePdf } from '../../../pdf-fixtures.test-helper';
import { renderPdfWindows } from '../../../rasterize';
import { BUILTIN_PIPELINES, asksMaxOf } from '../../builtin';
import {
  PIPELINE_API,
  PIPELINE_ASK_FIELDS_MAX,
  VISION_WORKER,
  type PictureAskInput,
  type PipelineStepRequest,
} from '../../contract';
import { checkStepResult } from '../../step-check';
import { inProcessStepJob } from '../../test-job';
import {
  ASKS_MAX,
  CORNER_DPI,
  FIELDS,
  KINDS,
  MAX_SIDE,
  PAGES_MAX,
  PAGE_DPI,
  cornerOf,
  fieldsOf,
  pagesOf,
  step,
} from './step';

/** An A3 landscape sheet in points, and a made-up drawing of `n` pages:
 *  a line number on the sheet and a title block line in its lower right. */
const A3 = { w: 1190.55, h: 841.89 };
const A1 = { w: 2383.94, h: 1683.78 };
function drawingPdf(n: number, size = A3): Buffer {
  const pageObj = (p: number) => 4 + p * 2;
  const objs: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: n }, (_, p) => `${pageObj(p)} 0 R`).join(' ')}] /Count ${n} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (let p = 0; p < n; p++) {
    const content =
      `BT /F1 14 Tf 100 600 Td (6-P-10${p}1-A1A) Tj ET ` +
      `BT /F1 10 Tf 1000 60 Td (MADE-UP-DWG-00${p + 1} SHEET ${p + 1} OF ${n}) Tj ET ` +
      `0 0 0 RG 2 w 100 500 m 900 500 l S`;
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size.w} ${size.h}] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageObj(p) + 1} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  }
  return assemblePdf(objs);
}

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A job on `bytes` that draws with the real pdfjs, and keeps what it was
 *  asked to draw. */
function jobOf(bytes: Buffer) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pdf-sheet-read-'));
  dirs.push(dir);
  const drawn: Parameters<
    Parameters<typeof inProcessStepJob>[2] extends infer H
      ? NonNullable<H> extends { pdfPictures?: infer F }
        ? NonNullable<F>
        : never
      : never
  >[0][] = [];
  const job = inProcessStepJob(bytes, dir, {
    pdfPictures: async (windows) => {
      drawn.push(windows);
      // The parser's child ends with no picture for a file pdfjs cannot open.
      return renderPdfWindows(bytes, windows).catch(() => windows.map(() => null));
    },
  });
  return { job, dir, drawn };
}

const request = (
  kind: string | undefined,
  options: Record<string, unknown> = {},
  state?: unknown,
): PipelineStepRequest => ({
  api: PIPELINE_API,
  step: 1,
  file: { name: 'file.pdf', ext: 'pdf', size: 1, sha256: '0'.repeat(64) },
  options,
  asks: true,
  ...(kind !== undefined ? { kind } : {}),
  ...(state !== undefined ? { state } : {}),
});

const inputs = (calls: readonly unknown[] | undefined) =>
  (calls ?? []).map((c) => {
    const call = c as { key: string; worker: string; input: PictureAskInput };
    return { key: call.key, worker: call.worker, ...call.input, fields: call.input.fields.length };
  });

describe('the step of pdf-sheet-read', () => {
  it('a three-page drawing: the corner of page 1 first, then each page whole, with the list on the whole pages', async () => {
    const { job, dir, drawn } = jobOf(drawingPdf(3));
    const result = await step(request('isometric'), job);
    expect(result.status).toBe('ok');
    expect(inputs(result.calls)).toEqual([
      {
        key: 'page-1-title-block',
        worker: VISION_WORKER,
        picture: 'page-1-title-block.png',
        fields: 10,
        page: 1,
      },
      {
        key: 'page-1',
        worker: VISION_WORKER,
        picture: 'page-1.png',
        fields: 10,
        page: 1,
        list: true,
      },
      {
        key: 'page-2',
        worker: VISION_WORKER,
        picture: 'page-2.png',
        fields: 10,
        page: 2,
        list: true,
      },
      {
        key: 'page-3',
        worker: VISION_WORKER,
        picture: 'page-3.png',
        fields: 10,
        page: 3,
        list: true,
      },
    ]);
    // Two draws: page 1 alone (its size places the corner), then the
    // corner and the pages after it that are there, up to the cap.
    expect(drawn.map((w) => w.map((x) => x.pageNumber))).toEqual([[1], [1, 2, 3]]);
    expect(drawn[0]![0]).toMatchObject({ scale: PAGE_DPI / 72, maxSide: MAX_SIDE });
    expect(drawn[1]![0]).toMatchObject({ scale: CORNER_DPI / 72, maxSide: MAX_SIDE });
    // The corner is the default box of drawing-pdf (190 x 70 mm) on an A3.
    const [x0, y0, x1, y1] = drawn[1]![0]!.box!;
    expect([x0, y0, x1, y1].map((v) => Math.round(v * 1000))).toEqual([548, 764, 1000, 1000]);
    // The pictures are in the job's folder, as PNGs of the right size: the
    // whole A3 at 200 DPI (3307 pixels wide, under the cap of 4800).
    const page1 = readFileSync(path.join(dir, 'page-1.png'));
    expect(page1.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(page1.readUInt32BE(16)).toBe(Math.floor((A3.w * PAGE_DPI) / 72));
    const corner = readFileSync(path.join(dir, 'page-1-title-block.png'));
    // 190 mm at 300 DPI.
    expect(Math.abs(corner.readUInt32BE(16) - Math.round((190 / 25.4) * 300))).toBeLessThan(3);
    // The result passes the one check of a step's result.
    expect(checkStepResult(JSON.parse(JSON.stringify(result))).ok).toBe(true);
    expect(result.calls!.length).toBeLessThanOrEqual(ASKS_MAX);
  });

  it('a one-page drawing: two asks', async () => {
    const { job } = jobOf(drawingPdf(1));
    const result = await step(request('scan'), job);
    expect(inputs(result.calls).map((c) => c.key)).toEqual(['page-1-title-block', 'page-1']);
  });

  it('the corner follows the box of the Reader that the core hands over', async () => {
    const { job, drawn } = jobOf(drawingPdf(1));
    await step(
      request(
        'unsure',
        {},
        { readerOptions: { title_block_width_mm: 420, title_block_height_mm: 100 } },
      ),
      job,
    );
    const [x0, y0] = drawn[1]![0]!.box!;
    expect(x0).toBe(0);
    expect(Math.round(y0 * 1000)).toBe(Math.round((1 - 100 / 297) * 1000));
  });

  it.each(['pid', 'pfd', 'document', 'equipment_drawing', '', undefined])(
    'the kind %s is not mine: nothing is drawn',
    async (kind) => {
      const { job, drawn } = jobOf(drawingPdf(1));
      expect(await step(request(kind), job)).toEqual({ status: 'not_mine' });
      expect(drawn).toHaveLength(0);
    },
  );

  it('takes the four kinds of its plan', () => {
    expect(KINDS).toEqual(['scan', 'isometric', 'unsure', 'other_drawing']);
  });

  it('a file that is no PDF is not mine', async () => {
    const { job } = jobOf(drawingPdf(1));
    const req = {
      ...request('scan'),
      file: { name: 'file.tif', ext: 'tif', size: 1, sha256: '0'.repeat(64) },
    };
    expect(await step(req, job)).toEqual({ status: 'not_mine' });
  });

  it('the option pages caps the pages drawn', async () => {
    const { job, drawn } = jobOf(drawingPdf(3));
    const result = await step(request('scan', { pages: 2 }), job);
    expect(drawn[1]!.map((w) => w.pageNumber)).toEqual([1, 2]);
    expect(inputs(result.calls).map((c) => c.key)).toEqual([
      'page-1-title-block',
      'page-1',
      'page-2',
    ]);
    const one = jobOf(drawingPdf(3));
    const only = await step(request('scan', { pages: 1 }), one.job);
    expect(inputs(only.calls).map((c) => c.key)).toEqual(['page-1-title-block', 'page-1']);
  });

  it('a file that cannot be opened: no ask, a warning', async () => {
    const result = await step(request('scan'), jobOf(Buffer.from('not a pdf')).job);
    expect(result).toEqual({
      status: 'ok',
      calls: [],
      warnings: ['The file could not be opened.'],
    });
  });

  /** A job whose child draws no picture for the pages in `lost`, and whose
   *  deadline is `left` ms away. */
  function lossyJob(bytes: Buffer, lost: number[], left: number, corner = true) {
    const { job } = jobOf(bytes);
    return {
      ...job,
      deadline: Date.now() + left,
      pdfPictures: async (windows: Parameters<typeof job.pdfPictures>[0]) => {
        const out = await renderPdfWindows(bytes, windows);
        return out.map((p, i) =>
          lost.includes(windows[i]!.pageNumber) && (corner || !windows[i]!.box) ? null : p,
        );
      },
    };
  }

  it('a picture the time ran out for fails the run: nothing is asked or written', async () => {
    const result = await step(request('scan'), lossyJob(drawingPdf(3), [3], 1_000));
    expect(result).toEqual({
      status: 'failed',
      warnings: ['The time ran out before the pictures.'],
    });
    const first = await step(request('scan'), lossyJob(drawingPdf(1), [1], 1_000));
    expect(first.status).toBe('failed');
  });

  it('a page that cannot be drawn with time left is left out, with a warning', async () => {
    const result = await step(request('scan'), lossyJob(drawingPdf(3), [2], 120_000));
    expect(result.status).toBe('ok');
    expect(inputs(result.calls).map((c) => c.key)).toEqual([
      'page-1-title-block',
      'page-1',
      'page-3',
    ]);
    expect(result.warnings).toEqual(['The picture page-2 could not be drawn.']);
    const none = await step(request('scan'), lossyJob(drawingPdf(1), [1], 120_000));
    expect(none).toEqual({ status: 'ok', calls: [], warnings: ['Page 1 could not be drawn.'] });
  });

  it('the asks of a file stay under its cap: page 1 two, each page after it one', () => {
    const agent = BUILTIN_PIPELINES.find((p) => p.id === 'pdf-sheet-read')!;
    expect(asksMaxOf(agent)).toBe(ASKS_MAX);
    expect(ASKS_MAX).toBe(PAGES_MAX + 1);
  });
});

describe('the fields and the pages of a site', () => {
  it('the ten fields, then the words of more_fields, with _ as a space', () => {
    expect(fieldsOf({}).map((f) => f.name)).toEqual([
      'Drawing number',
      'Title',
      'Revision',
      'Date',
      'Sheet',
      'Line number',
      'Unit or area',
      'Project',
      'Drawn by',
      'Checked by',
    ]);
    expect(FIELDS).toHaveLength(10);
    const more = fieldsOf({ more_fields: ['PAINT_SYSTEM', 'TML', 'DATE', 'KEY', 'MODEL', 'TML'] });
    expect(more.slice(10).map((f) => f.name)).toEqual(['PAINT SYSTEM', 'TML']);
    expect(more[10]!.hint).toContain('paint system');
  });

  it('never more fields than an ask may name', () => {
    const words = Array.from({ length: 30 }, (_, i) => `F${i}`);
    expect(fieldsOf({ more_fields: words })).toHaveLength(PIPELINE_ASK_FIELDS_MAX);
  });

  it('the page cap: 1 to 10, default 10', () => {
    expect(pagesOf({})).toBe(10);
    expect(pagesOf({ pages: 3 })).toBe(3);
    expect(pagesOf({ pages: 0 })).toBe(1);
    expect(pagesOf({ pages: 99 })).toBe(10);
    expect(pagesOf({ pages: 2.5 })).toBe(10);
  });

  it('the corner of a sheet smaller than the box is the whole sheet', () => {
    expect(cornerOf(100, 50, { width: 190, height: 70 })).toEqual([0, 0, 1, 1]);
  });
});

describe('the page render of the step (renderPdfWindows)', () => {
  it('an A1 sheet at 200 DPI is longer than the cap: its longest side is 4800', async () => {
    const [picture] = await renderPdfWindows(drawingPdf(1, A1), [
      { pageNumber: 1, scale: PAGE_DPI / 72, maxSide: MAX_SIDE },
    ]);
    expect(picture!.widthPx).toBe(MAX_SIDE);
    expect(picture!.heightPx).toBe(Math.floor((A1.h * MAX_SIDE) / A1.w));
  });

  it('a PNG past maxBytes is given as a JPEG of the same pixels; with no maxBytes, a PNG', async () => {
    const bytes = drawingPdf(1);
    const [jpeg, png] = await renderPdfWindows(bytes, [
      { pageNumber: 1, scale: 1, maxBytes: 1 },
      { pageNumber: 1, scale: 1 },
    ]);
    expect([...jpeg!.png.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(png!.png.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(jpeg!.widthPx).toBe(png!.widthPx);
  });
});
