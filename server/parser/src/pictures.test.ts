/**
 * Pictures drawn in a child process (./pictures.ts, ./pictures-child.ts),
 * on a PDF this test writes itself. What is pinned:
 *  - each window comes back as its own PNG with its size, in order;
 *  - a window that cannot be drawn is null, and the others still come back;
 *  - with no time left no child is started, and every window is null;
 *  - nothing of a run stays in the job's directory.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { picturesIn, pdfPictures } from './pictures';

/** A PDF of `pages` pages, 200 by 100 points, each with one filled box. */
function pdf(pages: number): Buffer {
  const content = '0.2 g 20 20 100 50 re f';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${3 + 2 * i} 0 R`).join(' ')}] /Count ${pages} >>`,
  ];
  for (let i = 0; i < pages; i++) {
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << >> /Contents ${4 + 2 * i} 0 R >>`,
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

const dir = mkdtempSync(path.join(os.tmpdir(), 'parser-pictures-'));
const input = path.join(dir, 'in.bin');
writeFileSync(input, pdf(2));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('pdfPictures', () => {
  it('draws each window in a child, and a window that cannot be drawn is null', async () => {
    const render = pdfPictures(input, dir, Date.now() + 120_000);
    const out = await render(
      [
        { pageNumber: 1, scale: 1 },
        { pageNumber: 9, scale: 1 },
        { pageNumber: 2, scale: 2, box: [0, 0, 0.5, 1] },
      ],
      Date.now() + 60_000,
    );
    expect(out[0]).toMatchObject({ widthPx: 200, heightPx: 100, scale: 1 });
    expect(out[0]!.png.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(out[1]).toBeNull();
    // The left half of page 2 at twice the scale.
    expect(out[2]).toMatchObject({ widthPx: 200, heightPx: 200, scale: 2 });
    expect(Math.round(out[2]!.widthMm * 10)).toBe(Math.round((100 / 72) * 25.4 * 10));
    // Only the input is left in the job's directory.
    expect(readdirSync(dir)).toEqual(['in.bin']);
  }, 60_000);

  it('with no time left it starts no child: every window is null', async () => {
    const windows = [{ pageNumber: 1, scale: 1 }];
    // The caller's deadline has passed.
    const soon = Date.now() + 120_000;
    expect(await pdfPictures(input, dir, soon)(windows, Date.now() - 1)).toEqual([null]);
    // The job ends in 21 s and 20 s are kept back for its answer: no time,
    // whatever the caller's deadline.
    expect(await pdfPictures(input, dir, Date.now() + 21_000)(windows, soon)).toEqual([null]);
    expect(readdirSync(dir)).toEqual(['in.bin']);
  });

  it('a file that is no PDF gives no picture, and no error', async () => {
    const bad = path.join(dir, 'bad.bin');
    writeFileSync(bad, 'not a pdf at all');
    const out = await pdfPictures(
      bad,
      dir,
      Date.now() + 120_000,
    )([{ pageNumber: 1, scale: 1 }], Date.now() + 60_000);
    expect(out).toEqual([null]);
    rmSync(bad);
  }, 60_000);

  it('takes only the pictures a killed child finished: both files, whole', async () => {
    const left = mkdtempSync(path.join(os.tmpdir(), 'parser-pictures-left-'));
    const size = { widthPx: 10, heightPx: 5, scale: 1, widthMm: 3.5, heightMm: 1.8 };
    // Window 0: finished. Window 1: the picture with no size file yet (the
    // child was killed between the two). Window 2: nothing. Window 3: a
    // size file that is not whole.
    writeFileSync(path.join(left, '0.png'), 'png bytes');
    writeFileSync(path.join(left, '0.json'), JSON.stringify(size));
    writeFileSync(path.join(left, '1.png'), 'png bytes');
    writeFileSync(path.join(left, '3.png'), 'png bytes');
    writeFileSync(path.join(left, '3.json'), '{"widthPx": 10, "heightPx"');
    const out = await picturesIn(left, 4);
    expect(out.map((p) => p !== null)).toEqual([true, false, false, false]);
    expect(out[0]).toMatchObject(size);
    rmSync(left, { recursive: true, force: true });
  });
});
