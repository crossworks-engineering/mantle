/**
 * A made-up PDF for scripts/probe-parser-large-image.sh: one A4 landscape
 * page whose only content is one embedded image of 11880 x 8400 pixels
 * (99.8 M, under PDF_WINDOW_MAX_IMAGE_PIXELS), RGB with a soft mask, Flate
 * with a PNG predictor: the shape of a CAD sheet exported as one large
 * picture. White with a black grid, so a picture of it is not blank.
 *
 *   bun --no-env-file scripts/probe-parser-large-image.ts <out.pdf>
 *
 * The rows are made and compressed in parts: this process never holds the
 * 300 MB of raw pixels.
 */
import { promises as fs } from 'node:fs';
import { once } from 'node:events';
import zlib from 'node:zlib';

const W = 11_880;
const H = 8_400;
const GRID = 200;

/** One Flate stream of `H` rows, each a PNG predictor byte (0, none) and
 *  the row `rowOf(y)` gives. */
async function flateRows(rowOf: (y: number) => Buffer): Promise<Buffer> {
  const deflate = zlib.createDeflate({ level: 1 });
  const out: Buffer[] = [];
  deflate.on('data', (c: Buffer) => out.push(c));
  const ended = once(deflate, 'end');
  const none = Buffer.from([0]);
  for (let y = 0; y < H; y++) {
    deflate.write(none);
    if (!deflate.write(rowOf(y))) await once(deflate, 'drain');
  }
  deflate.end();
  await ended;
  return Buffer.concat(out);
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error('usage: probe-parser-large-image.ts <out.pdf>');
  // A grid line row is black; any other row is white with a black dot every GRID.
  const line = Buffer.alloc(W * 3, 0);
  const plain = Buffer.alloc(W * 3, 255);
  for (let x = 0; x < W; x += GRID) plain.fill(0, x * 3, x * 3 + 3);
  const rgb = await flateRows((y) => (y % GRID === 0 ? line : plain));
  const opaque = Buffer.alloc(W, 255);
  const mask = await flateRows(() => opaque);

  const parms = (colors: number) =>
    `/DecodeParms << /Predictor 15 /Colors ${colors} /BitsPerComponent 8 /Columns ${W} >>`;
  const content = Buffer.from('q 842 0 0 595 0 0 cm /Im1 Do Q\n');
  const objects: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>',
    ),
    Buffer.concat([
      Buffer.from(`<< /Length ${content.length} >>\nstream\n`),
      content,
      Buffer.from('\nendstream'),
    ]),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask 6 0 R /Filter /FlateDecode ${parms(3)} /Length ${rgb.length} >>\nstream\n`,
      ),
      rgb,
      Buffer.from('\nendstream'),
    ]),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode ${parms(1)} /Length ${mask.length} >>\nstream\n`,
      ),
      mask,
      Buffer.from('\nendstream'),
    ]),
  ];
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n')];
  let at = parts[0]!.length;
  const offsets: number[] = [];
  for (const [i, body] of objects.entries()) {
    offsets.push(at);
    const obj = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
    parts.push(obj);
    at += obj.length;
  }
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(at),
    '%%EOF',
    '',
  ].join('\n');
  parts.push(Buffer.from(xref));
  await fs.writeFile(file, Buffer.concat(parts));
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
