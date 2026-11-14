/**
 * The sniffs of a CAD drawing (kit, ./pipelines/kit.ts): whether bytes are
 * the format their extension names. The step of `drawing-cad`
 * (./pipelines/pkg/drawing-cad) asks them, and so does the core before any
 * parser job: a sniff miss is the free hollow skip on every pass (the
 * database, the text, the picture, the readings of dwg-reindex). No imports:
 * a package may read this file.
 */

/** The CAD extensions: the one list. ./slug.ts builds every set, route and
 *  name pattern of a drawing from it, and the step of `drawing-cad` checks
 *  its request with it. Each has its sniff in `CAD_SNIFFS` below, so a new
 *  CAD format is one line here and one sniff. */
export const CAD_EXT_LIST = ['dwg', 'dxf', 'dgn'] as const;
export type CadExt = (typeof CAD_EXT_LIST)[number];

/** True when the bytes open with a DWG version magic (`AC1012`…`AC1032`). */
export function sniffDwg(bytes: Buffer): boolean {
  return /^AC1\d{3}$/.test(bytes.subarray(0, 6).toString('latin1'));
}

/** The binary-DXF sentinel, byte-exact per the DXF reference. */
const DXF_BINARY_SENTINEL = 'AutoCAD Binary DXF\r\n\x1a\x00';

/**
 * True when the bytes look like a DXF. Binary DXF is the fixed 22-byte
 * sentinel. ASCII DXF is group-code/value line pairs from the top: the first
 * non-comment pair must be `0` / `SECTION` (group codes may be space-padded;
 * `999` pairs are comments and legitimately lead the file; a UTF-8 BOM is
 * tolerated). A DWG (binary, starts `AC1…`) and arbitrary text both fail the
 * pair check, which is the point: the hollow skip keys off this.
 */
export function sniffDxf(bytes: Buffer): boolean {
  if (bytes.subarray(0, 22).toString('latin1') === DXF_BINARY_SENTINEL) return true;
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const lines = bytes
    .subarray(start, start + 8192)
    .toString('latin1')
    .split(/\r?\n/);
  for (let i = 0; i + 1 < lines.length; i += 2) {
    if (lines[i]!.trim() === '999') continue; // leading comment pair
    return lines[i]!.trim() === '0' && lines[i + 1]!.trim().toUpperCase() === 'SECTION';
  }
  return false;
}

/** A DGN V8 is an OLE compound file that holds a `Dgn~H` stream (ezdgn
 *  refuses one without it; a directory entry's name is UTF-16LE). A DGN V7
 *  opens with a type-9 header element (2D or 3D). */
const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const DGN_V8_HEADER_NAME = Buffer.from('Dgn~H', 'utf16le');
const DGN_V7_HEADS = [Buffer.from([0x08, 0x09, 0xfe, 0x02]), Buffer.from([0xc8, 0x09, 0xfe, 0x02])];

/** True when the bytes are a DGN: a V7 signature, or a compound file that
 *  names the DGN header stream. Any other compound file named `.dgn` (an old
 *  Word or Excel file) is a sniff miss: the free hollow skip with the
 *  "renamed or mislabelled" hint, never a parser run. */
export function sniffDgn(bytes: Buffer): boolean {
  if (bytes.subarray(0, 8).equals(CFB_MAGIC)) return bytes.includes(DGN_V8_HEADER_NAME);
  const head = bytes.subarray(0, 4);
  return DGN_V7_HEADS.some((h) => head.equals(h));
}

/** The sniff of each CAD extension: one for every entry of the list. */
const CAD_SNIFFS: Record<CadExt, (bytes: Buffer) => boolean> = {
  dwg: sniffDwg,
  dxf: sniffDxf,
  dgn: sniffDgn,
};

/** True when the bytes are the format their CAD extension names; false for
 *  any other extension. */
export function sniffCad(bytes: Buffer, ext: string): boolean {
  return (CAD_EXT_LIST as readonly string[]).includes(ext) && CAD_SNIFFS[ext as CadExt](bytes);
}
