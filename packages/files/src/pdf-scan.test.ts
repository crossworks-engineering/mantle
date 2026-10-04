/**
 * A PDF with no text layer (a scan) must parse to '' so the extractor takes
 * the OCR path. pdf-parse v2 ends every page with a `-- N of M --` marker,
 * text or no text, so a 1-page scan came back as `-- 1 of 1 --` (12 chars:
 * `body_too_short`, no OCR, and re-queued by the boot drain on every restart)
 * and a longer one cleared the 20-char minimum and was indexed as its own page
 * markers. NATREF, 2026-10-04: 75 scanned PDFs, each with a 12-char body.
 */
import { describe, expect, it } from 'vitest';
import { helveticaPdf } from './pdf-fixtures.test-helper';
import { parsePdf } from './pdf';

/** A valid PDF of `pages` blank pages: no content stream, no text. */
function blankPdf(pages: number): Buffer {
  const kids = Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(' ');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
    ...Array.from(
      { length: pages },
      () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
    ),
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const startxref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

describe('parsePdf: no text layer', () => {
  it('returns empty for a 1-page scan, not its page marker', async () => {
    expect(await parsePdf(blankPdf(1))).toBe('');
  });

  it('returns empty for a multi-page scan, whose markers clear 20 chars', async () => {
    expect(await parsePdf(blankPdf(3))).toBe('');
  });

  it('keeps a real text layer, markers and all', async () => {
    const text = await parsePdf(helveticaPdf('Hello Mantle'));
    expect(text).toContain('Hello Mantle');
  });
});
