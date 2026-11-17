/**
 * The step of the Agent `pdf-sheet-read` in a parser job: its pictures are
 * drawn by the real pdfjs child of the job handle (./pictures-child.ts), on
 * a made-up PDF this test writes itself. What is pinned:
 *  - a two-page drawing gives three asks: the title block corner of page 1,
 *    page 1 whole, page 2 whole;
 *  - the job sends the bytes of each picture the asks name, PNGs of the
 *    asked size;
 *  - the longest side and the JPEG past a size reach the child;
 *  - a kind that is not the Agent's draws nothing.
 * No model. No client file.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PIPELINE_API, type PipelineStepRequest } from '@mantle/files/pipelines/contract';
import { PIPELINE_PACKAGES, stepLoaderOf } from '@mantle/files/pipelines/pkg';
import { jobPaths } from './jobs';
import { PICTURES_RESERVE_MS } from './pictures';
import { jobHandle, picturesOf } from './pipeline-job';

/** A made-up drawing: `pages` pages of 420 by 297 mm, a line and a word. */
function drawing(pages: number): Buffer {
  const w = 1190.55;
  const h = 841.89;
  const content = 'BT /F1 14 Tf 100 600 Td (6-P-1001-A1A) Tj ET 0 0 0 RG 100 500 m 900 500 l S';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${4 + 2 * i} 0 R`).join(' ')}] /Count ${pages} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (let i = 0; i < pages; i++) {
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  }
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const root = mkdtempSync(path.join(os.tmpdir(), 'parser-sheet-read-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const request = (kind: string): PipelineStepRequest => ({
  api: PIPELINE_API,
  step: 1,
  file: { name: 'file.pdf', ext: 'pdf', size: 1, sha256: '0'.repeat(64) },
  options: {},
  asks: true,
  kind,
  state: { readerOptions: {} },
});

async function run(kind: string, pages: number) {
  const p = jobPaths(mkdtempSync(path.join(root, 'job-')));
  writeFileSync(p.input, drawing(pages));
  const job = jobHandle(p, Date.now() + PICTURES_RESERVE_MS + 120_000);
  const { step } = await stepLoaderOf(PIPELINE_PACKAGES, 'pdf-sheet-read')!();
  return { result: await step(request(kind), job), dir: p.dir, job };
}

describe('pdf-sheet-read in a parser job', () => {
  it('a two-page drawing: the whole pages and their halves, and the job sends their pictures', async () => {
    const { result, dir } = await run('isometric', 2);
    const calls = result.calls ?? [];
    // This made-up sheet has nothing in its title block corner: that
    // picture is blank, and is not asked.
    expect(result.warnings).toEqual(['The picture page-1-title-block is blank, and is not read.']);
    const keys = [
      'page-1',
      'page-1-half-1',
      'page-1-half-2',
      'page-2',
      'page-2-half-1',
      'page-2-half-2',
    ];
    expect(calls.map((c) => (c as { key: string }).key)).toEqual(keys);
    const sent = await picturesOf(dir, calls);
    expect(sent.map((s) => s.file)).toEqual(keys.map((k) => `${k}.png`));
    const png = Buffer.from(sent[0]!.bytes_base64, 'base64');
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    // 420 mm at 200 DPI.
    expect(png.readUInt32BE(16)).toBe(Math.floor((1190.55 * 200) / 72));
  }, 120_000);

  it('the longest side and the JPEG past a size reach the child', async () => {
    const p = jobPaths(mkdtempSync(path.join(root, 'job-')));
    writeFileSync(p.input, drawing(1));
    const job = jobHandle(p, Date.now() + PICTURES_RESERVE_MS + 120_000);
    const [small, jpeg] = await job.pdfPictures(
      [
        { pageNumber: 1, scale: 4, maxSide: 500 },
        { pageNumber: 1, scale: 1, maxBytes: 1 },
      ],
      Date.now() + 60_000,
    );
    expect(small!.widthPx).toBe(500);
    expect([...jpeg!.png.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  }, 120_000);

  it('a blank picture says so through the child', async () => {
    const p = jobPaths(mkdtempSync(path.join(root, 'job-')));
    writeFileSync(p.input, drawing(1));
    const job = jobHandle(p, Date.now() + PICTURES_RESERVE_MS + 120_000);
    // A window of the empty top left corner, and the whole page.
    const [empty, whole] = await job.pdfPictures(
      [
        { pageNumber: 1, scale: 1, box: [0, 0, 0.05, 0.05] },
        { pageNumber: 1, scale: 1 },
      ],
      Date.now() + 60_000,
    );
    expect(empty!.blank).toBe(true);
    expect(whole!.blank).toBeUndefined();
  }, 120_000);

  it('a kind that is not the Agent’s: not_mine, and nothing drawn', async () => {
    const { result } = await run('pid', 1);
    expect(result).toEqual({ status: 'not_mine' });
  });
});
