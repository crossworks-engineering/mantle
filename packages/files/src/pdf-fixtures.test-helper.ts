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
  return assemblePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]);
}

/**
 * Number the objects 1..n, write the xref table and trailer (object 1 is the
 * catalog). An object is PDF syntax, or `[dict, streamBytes]` for a stream
 * whose bytes are binary.
 */
export function assemblePdf(objs: (string | [string, Buffer])[]): Buffer {
  // Latin-1: the offsets are byte offsets, and PDF syntax is 8-bit.
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  let length = parts[0]!.length;
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(length);
    const part = Buffer.concat(
      typeof body === 'string'
        ? [Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, 'latin1')]
        : [
            Buffer.from(`${i + 1} 0 obj\n${body[0]}\nstream\n`, 'latin1'),
            body[1],
            Buffer.from('\nendstream\nendobj\n', 'latin1'),
          ],
    );
    parts.push(part);
    length += part.length;
  });
  let tail = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) tail += `${String(o).padStart(10, '0')} 00000 n \n`;
  tail += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  parts.push(Buffer.from(tail, 'latin1'));
  return Buffer.concat(parts);
}

/** An embedded RGB 8-bit image: its size and its Flate-compressed samples. */
export type FixtureImage = { width: number; height: number; flate: Buffer };

/**
 * A one-page PDF of the given size (points) with a caption line in Helvetica
 * and the given images, each drawn into its own box down the page. A huge
 * image declared here costs nothing to build: only its compressed bytes exist.
 */
export function imagePagePdf(opts: {
  pageWidth?: number;
  pageHeight?: number;
  caption?: string;
  images: FixtureImage[];
}): Buffer {
  const { pageWidth = 612, pageHeight = 792, caption = 'Figure 1: test', images } = opts;
  const draws = images
    .map((_, i) => `q 200 0 0 150 50 ${pageHeight - 250 - i * 170} cm /Im${i + 1} Do Q`)
    .join(' ');
  const content = `BT /F1 12 Tf 50 ${pageHeight - 60} Td (${caption}) Tj ET ${draws}`;
  const xobjects = images.map((_, i) => `/Im${i + 1} ${i + 6} 0 R`).join(' ');
  return assemblePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
      `/Resources << /Font << /F1 5 0 R >> /XObject << ${xobjects} >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...images.map((img): [string, Buffer] => [
      `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${img.flate.length} >>`,
      img.flate,
    ]),
  ]);
}

/**
 * A many-page PDF (US Letter) drawing from one shared set of images: each
 * page draws the images whose indexes it lists, so an image listed on several
 * pages is ONE object referenced from each (pdfjs then caches it across
 * pages, in the document-wide store). A page carries a caption line unless
 * its `caption` is null.
 */
export function imagePagesPdf(opts: {
  images: FixtureImage[];
  /** `caption: null` leaves the page without text: a scan's page. */
  pages: { draw: number[]; caption?: string | null }[];
}): Buffer {
  const { images, pages } = opts;
  // 1 catalog, 2 page tree, 3 font, then the images, then page + content
  // pairs.
  const imageObj = (i: number) => 4 + i;
  const pageObj = (p: number) => 4 + images.length + p * 2;
  const objs: (string | [string, Buffer])[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, p) => `${pageObj(p)} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...images.map((img): [string, Buffer] => [
      `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${img.flate.length} >>`,
      img.flate,
    ]),
  ];
  pages.forEach((page, p) => {
    const draws = page.draw
      .map((i, k) => `q 200 0 0 150 50 ${542 - k * 170} cm /Im${i + 1} Do Q`)
      .join(' ');
    const text =
      page.caption === null
        ? ''
        : `BT /F1 12 Tf 50 732 Td (${page.caption ?? `Page ${p + 1}`}) Tj ET `;
    const content = `${text}${draws}`;
    const xobjects = [...new Set(page.draw)].map((i) => `/Im${i + 1} ${imageObj(i)} 0 R`);
    objs.push(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        `/Resources << /Font << /F1 3 0 R >> /XObject << ${xobjects.join(' ')} >> >> ` +
        `/Contents ${pageObj(p) + 1} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  });
  return assemblePdf(objs);
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
