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

import { deflateSync } from 'node:zlib';

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

/** An embedded RGB 8-bit image: its size and its samples, Flate-compressed or a
 *  whole JPEG file. */
export type FixtureImage = { width: number; height: number } & (
  { flate: Buffer } | { jpeg: Buffer }
);

/** An image's PDF stream object. */
function imageObject(img: FixtureImage): [string, Buffer] {
  const [filter, bytes] = 'jpeg' in img ? ['/DCTDecode', img.jpeg] : ['/FlateDecode', img.flate];
  return [
    `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter ${filter} /Length ${bytes.length} >>`,
    bytes,
  ];
}

/**
 * A baseline JPEG of a flat gray, built by hand so a 27 MP scan page costs
 * 300 KB to build and the full decode to read. Each Huffman table holds one
 * symbol, whose code is a single 0 bit: "no DC change" and "end of block". So
 * a block is two 0 bits, and the scan is that many zero bytes.
 */
export function flatJpeg(width: number, height: number): Buffer {
  const u16 = (n: number) => [n >> 8, n & 0xff];
  const segment = (marker: number, body: number[]) => [
    0xff,
    marker,
    ...u16(body.length + 2),
    ...body,
  ];
  const huffman = (tableId: number) => [tableId, 1, ...Array<number>(15).fill(0), 0];
  const header = [
    0xff,
    0xd8, // start of image
    ...segment(0xdb, [0, ...Array<number>(64).fill(1)]), // quantization table
    // Baseline frame: 8 bits, three components, no subsampling, table 0.
    ...segment(0xc0, [8, ...u16(height), ...u16(width), 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]),
    ...segment(0xc4, huffman(0x00)), // DC table
    ...segment(0xc4, huffman(0x10)), // AC table
    ...segment(0xda, [3, 1, 0, 2, 0, 3, 0, 0, 63, 0]), // start of scan
  ];
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8) * 3;
  return Buffer.concat([
    Buffer.from(header),
    Buffer.alloc(Math.ceil(blocks / 4)),
    Buffer.from([0xff, 0xd9]), // end of image
  ]);
}

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
    ...images.map(imageObject),
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
    ...images.map(imageObject),
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

/** The image codecs a scan comes in, beside plain Flate. */
export type ScanCodec = 'jpx' | 'ccitt' | 'jbig2' | 'flate';

/** Width and height of the page and of its one image, in points and pixels. */
export const SCAN_SIZE = { width: 120, height: 90 };

/** The test image: black up to x 40, three-wide stripes every six to x 80, then
 *  white. Dark on the left and light on the right, so a page drawn inverted
 *  or not at all fails the same check. */
function scanSampleIsBlack(x: number): boolean {
  return x < 40 || (x >= 44 && x < 80 && (x - 44) % 6 < 3);
}

/** The test image as 8-bit grayscale samples. */
function scanSamples(): Buffer {
  const { width, height } = SCAN_SIZE;
  const row = Buffer.alloc(width, 255);
  for (let x = 0; x < width; x++) if (scanSampleIsBlack(x)) row[x] = 0;
  return Buffer.concat(Array.from({ length: height }, () => row));
}

/**
 * The test image as real encoders write it, not bytes built by hand: a decoder
 * bug or a fixture bug must not cancel out. Each one was checked with decoders
 * that are not pdfjs (Poppler, Ghostscript).
 *  - jpx: Pillow (OpenJPEG), `quality_layers=[20]`, lossy.
 *  - ccitt: the strip of a Group 4 TIFF, from Pillow (libtiff), of the image
 *    inverted: its TIFF is BlackIsZero, so libtiff codes the black pixels as
 *    white runs, and in a PDF that reads back inverted.
 *  - jbig2: `jbig2 -p` (jbig2enc 0.30), an arithmetic-coded generic region.
 */
const SCAN_STREAMS: Record<Exclude<ScanCodec, 'flate'>, { dict: string; base64: string }> = {
  jpx: {
    dict: '/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /JPXDecode',
    base64:
      'AAAADGpQICANCocKAAAAFGZ0eXBqcDIgAAAAAGpwMiAAAAAtanAyaAAAABZpaGRyAAAAWgAAAHgAAQcHAAAAAAAPY29scgEAAAAAABEAAAGganAyY/9P/1EAKQAAAAAAeAAAAFoAAAAAAAAAAAAAAHgAAABaAAAAAAAAAAAAAQcBAf9SAAwAAAABAAIEBAAA/1wAEUJfUlAFUAVQR1fTV9NXYv9kACUAAUNyZWF0ZWQgYnkgT3BlbkpQRUcgdmVyc2lvbiAyLjUuMP+QAAoAAAAAASEAAf+Tz5tAABFQU/MTQ1niDbK6Cr//f/6TSkV+TUTVVdABXKqINF9A3803UGk4AAgOe04Bn/9MHmnjeCJnpuWreCJnphDfeCJnpYsC8EKFz+EP6ukBc6k0svyaUMygXOpNLL8mlDMoFzqTSy/JpQzKBc6k0svyaUMygXOpNLL8mkSziAk4j+gs3014VWHWQH9txXUckwnAYQF2fYdf+TCCA6VGXxXUPjVY4NQ+NVjg1D41WODUPjU5oKbjjp0C9j+l4fi2/2Y2/xjb+F1XCrRHAGTEiXvxRJ6YvxRJ6YvxRJ6YvxRJ6Yt4FcfErHN7gOCNrc/1R/1buAWYnslvRCYxxr//cAmHzzgAAAAwkJf/Ueugz0VBwy3/2Q==',
  },
  ccitt: {
    dict:
      '/ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /CCITTFaxDecode ' +
      `/DecodeParms << /K -1 /Columns ${SCAN_SIZE.width} /Rows ${SCAN_SIZE.height} /BlackIs1 false >>`,
    base64:
      'JqDYbjEYjEYjF//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////4AIAI',
  },
  jbig2: {
    dict: '/ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /JBIG2Decode',
    base64:
      'AAAAADAAAQAAABMAAAB4AAAAWgAAAAAAAAAAAQAAAAAAASYAAQAAAD8AAAB4AAAAWgAAAAAAAAAAAAAD//3/Av7+/v9YcQQBzb+OlLMr68tlZlgwP1fX8/9//3//f/9//3//f/9//6w=',
  },
};

/**
 * A one-page scan: one image filling the page in the given codec, no text
 * layer. The test image (`scanSampleIsBlack`) is the same in each codec, and
 * `flate` needs no decoder module, so it is the control.
 */
export function scanPdf(codec: ScanCodec): Buffer {
  const { width, height } = SCAN_SIZE;
  const { dict, stream } =
    codec === 'flate'
      ? {
          dict: '/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode',
          stream: deflateSync(scanSamples()),
        }
      : {
          dict: SCAN_STREAMS[codec].dict,
          stream: Buffer.from(SCAN_STREAMS[codec].base64, 'base64'),
        };
  const content = `q ${width} 0 0 ${height} 0 0 cm /Im1 Do Q`;
  return assemblePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
      '/Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    [
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ${dict} ` +
        `/Length ${stream.length} >>`,
      stream,
    ],
  ]);
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
