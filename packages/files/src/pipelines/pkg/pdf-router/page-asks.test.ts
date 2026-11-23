/**
 * The router's part 2 (./step.ts pageAsks; plan page c607711a, M3): one
 * window of a made-up fixture, the step real, the pictures drawn by the real
 * pdfjs in this process. Each page with ink gives one `decider` call keyed by
 * its page of the ORIGINAL file, with the 8 fields of the page ask (and
 * nothing else), and its picture: a grey JPEG of 1,024 px long side in the
 * job folder. A run that may not ask gives no call.
 *
 * The blank test (M4): a page is blank (free, no ask) only when its picture
 * is white AND no image covers it. A white picture of a scan is an image
 * that did not draw (a faint scanned isometric on NATREF was called blank),
 * so it is `not drawn`, never blank. Pictures are drawn with `largeImages`.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { afterAll, describe, expect, it } from 'vitest';
import { sniffImage } from '../../../image-probe';
import { pdfPageAskOf, PDF_PAGE_PICTURE } from '../../../pdf-page-kinds';
import { renderPdfWindows } from '../../../rasterize';
import { inProcessStepJob } from '../../test-job';
import type { PipelineStepRequest } from '../../contract';
import { step } from './step';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const pdf = (name: string) => readFileSync(path.join(HERE, '..', 'drawing-pdf', 'fixtures', name));
const dir = mkdtempSync(path.join(os.tmpdir(), 'page-asks-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A window of the original file (the fixture's 2 pages): its page 1 is
 *  page 26 of 80. */
const req = (asks: boolean): PipelineStepRequest => ({
  api: 1,
  step: 1,
  file: { name: 'file.pdf', ext: 'pdf', size: 1, sha256: 'a'.repeat(64) },
  options: {},
  asks,
  pageFrom: 26,
  pageTo: 27,
  pagesTotal: 80,
});

describe('a page window of the router (part 2)', () => {
  it('gives one decider ask a page, by its page of the original file, with its grey picture', async () => {
    const body = pdf('pid.pdf');
    const jobDir = mkdtempSync(path.join(dir, 'job-'));
    const job = inProcessStepJob(body, jobDir, {
      pdfPictures: (windows, deadline) => renderPdfWindows(body, windows, { deadline }),
    });
    const out = await step(req(true), job);
    expect(out.status).toBe('ok');
    expect(out.kind).toBeUndefined();
    expect(out.calls).toHaveLength(2);
    for (const [i, call] of out.calls!.entries()) {
      expect(call).toMatchObject({ call: 'worker', worker: 'decider', key: `page-${26 + i}` });
      const input = (call as { input: Record<string, unknown> }).input;
      // The one check takes it whole: the step sends the 8 fields, no more.
      expect(pdfPageAskOf(input)).toEqual(input);
      expect(input.page).toBe(26 + i);
      const picture = readFileSync(path.join(jobDir, String(input.picture)));
      const probed = sniffImage(picture);
      expect(probed?.ext).toBe('jpg');
      expect(Math.max(probed!.width!, probed!.height!)).toBe(PDF_PAGE_PICTURE.maxSide);
      // Grey: every pixel's three channels are one value (a JPEG's rounding
      // aside).
      const img = await loadImage(picture);
      const canvas = createCanvas(img.width, img.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, img.width, img.height).data;
      let worst = 0;
      for (let k = 0; k < px.length; k += 4 * 97) {
        worst = Math.max(worst, Math.abs(px[k]! - px[k + 1]!), Math.abs(px[k + 1]! - px[k + 2]!));
      }
      expect(worst).toBeLessThanOrEqual(3);
    }
    expect(out.state).toEqual({
      pages: [
        [26, expect.any(String), null],
        [27, expect.any(String), null],
      ],
    });
  });

  it('a run that may not ask gives no call and draws nothing', async () => {
    let drawn = 0;
    const job = inProcessStepJob(pdf('pid.pdf'), mkdtempSync(path.join(dir, 'job-')), {
      pdfPictures: async (windows) => {
        drawn += windows.length;
        return windows.map(() => null);
      },
    });
    const out = await step(req(false), job);
    expect(out.calls).toEqual([]);
    expect(drawn).toBe(0);
  });

  it('a page that cannot be drawn gets no ask: `not drawn`, its rules kind', async () => {
    const job = inProcessStepJob(pdf('pid.pdf'), mkdtempSync(path.join(dir, 'job-')));
    const out = await step(req(true), job);
    expect(out.calls).toEqual([]);
    expect(out.state).toEqual({
      pages: [
        [26, expect.any(String), 'not drawn'],
        [27, expect.any(String), 'not drawn'],
      ],
    });
  });

  /** A job whose pictures all come back white (`blank`), of a valid size. */
  const whiteJob = (body: Buffer, seen: Array<Record<string, unknown>> = []) =>
    inProcessStepJob(body, mkdtempSync(path.join(dir, 'job-')), {
      pdfPictures: async (windows) => {
        seen.push(...(windows as unknown as Array<Record<string, unknown>>));
        return windows.map(() => ({
          png: Buffer.from('jpeg'),
          widthPx: 1024,
          heightPx: 724,
          scale: 1,
          widthMm: 420,
          heightMm: 297,
          blank: true as const,
        }));
      },
    });

  it('a white picture of a page no image covers is blank: free, no ask', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const out = await step(req(true), whiteJob(pdf('pid.pdf'), seen));
    expect(out.calls).toEqual([]);
    expect(out.state).toEqual({
      pages: [
        [26, expect.any(String), 'blank'],
        [27, expect.any(String), 'blank'],
      ],
    });
    // Every page is drawn, with large images (as the Agents draw them).
    expect(seen).toHaveLength(2);
    for (const w of seen) expect(w.largeImages).toBe(true);
  });

  it('a white picture of a scan is an image that did not draw: `not drawn`, never blank', async () => {
    const out = await step(req(true), whiteJob(pdf('scan.pdf')));
    expect(out.calls).toEqual([]);
    expect(out.state).toEqual({ pages: [[26, expect.any(String), 'not drawn']] });
  });
});
