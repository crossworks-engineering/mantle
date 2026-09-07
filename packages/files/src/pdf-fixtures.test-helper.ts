/**
 * Test-only PDF fixtures and the shared PDF-stack smoke sequence.
 *
 * The PDF is hand-assembled rather than produced by a library on purpose: the
 * thing under test is which pdfjs the READERS load, so a fixture built by one
 * of them would drag that library's copy into the very process the test is
 * trying to observe. A one-page Helvetica text object is also the smallest
 * input that exercises both halves of the stack — it has a text layer for
 * `parsePdf` and renderable content for `rasterizePdfToPngs`.
 */

/** A valid one-page PDF with a single Helvetica text object. */
export function helveticaPdf(text = 'Hello Mantle'): Buffer {
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
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
  // Latin-1: the offsets above are byte offsets, and PDF syntax is 8-bit.
  return Buffer.from(pdf, 'latin1');
}

/**
 * True once any pdf-stack test file has loaded THIS module instance.
 *
 * Module scope, so its lifetime is the module registry's — which is exactly
 * the thing the two-file split depends on. See `claimPdfStackProcess`.
 */
let processClaimed = false;

/**
 * Claim this module registry for one pdf-stack test file. Returns false if
 * another file already claimed it.
 *
 * The order-dependent smoke tests are split across two files because a pdfjs
 * version collision poisons a process permanently — only the entry point that
 * ran FIRST can be observed to work, so testing both orders needs two clean
 * starts. Vitest's per-file isolation is what supplies them.
 *
 * That is an assumption about the test runner, not something the tests
 * control, and vitest 5 actively advertises turning it off ("at least ~3s
 * faster with isolate: false") on every run. Take that advice and the second
 * file silently inherits the first one's modules: still green, no longer
 * testing a second order, and the pdfjs collision it exists to catch walks
 * straight through. This turns that into a loud failure.
 *
 * A tripwire, not a proof: with `isolate: false` vitest still spreads files
 * over several workers, so the two may land in different registries and the
 * guard stays quiet. It fires when they land together, which is the case that
 * would otherwise mislead.
 */
export function claimPdfStackProcess(): boolean {
  if (processClaimed) return false;
  processClaimed = true;
  return true;
}

/**
 * Every pdfjs-backed entry point in the package, as `[name, run]` pairs.
 *
 * Callers run these in ONE process and in a chosen order — that is the whole
 * point. See `pdf-stack.test.ts`.
 */
export function pdfStackSteps(bytes: Buffer): [string, () => Promise<unknown>][] {
  return [
    [
      'rasterizePdfToPngs',
      async () => {
        const { rasterizePdfToPngs } = await import('./rasterize');
        const pages = await rasterizePdfToPngs(bytes, { maxPages: 1 });
        if (pages.length !== 1 || !pages[0]?.png.length) throw new Error('no page rendered');
        return pages;
      },
    ],
    [
      'parsePdf',
      async () => {
        const { parsePdf } = await import('./pdf');
        const text = await parsePdf(bytes);
        if (!text.includes('Hello Mantle')) throw new Error(`no text layer: ${text.slice(0, 60)}`);
        return text;
      },
    ],
    [
      'extractPdfTextWithPassword',
      async () => {
        const { extractPdfTextWithPassword } = await import('./pdf-password');
        const r = await extractPdfTextWithPassword(bytes, '');
        if (!r.ok) throw new Error(`failed: ${r.reason} ${r.message ?? ''}`);
        return r;
      },
    ],
    [
      'extractPdfImages',
      async () => {
        const { extractPdfImages } = await import('./pdf');
        // A text-only page has no figures; reaching a clean [] is the signal
        // that pdfjs opened the document at all.
        return await extractPdfImages(bytes);
      },
    ],
  ];
}
