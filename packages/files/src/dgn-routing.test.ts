/**
 * DGN takes the CAD route, and DWG and DXF keep theirs. Made-up bytes only
 * (public repo): a signature and padding, never a real drawing. The CAD
 * tier's reply is faked at the fetch, as in ./dwg.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cadRegistryWorkbook,
  dwgTableDescription,
  sniffCad,
  sniffDgn,
  sniffDwg,
  sniffDxf,
} from './dwg';
import { FILE_DB_EXTS } from './file-dbs';
import { parseDocumentBytes } from './parse';
import {
  CAD_EXTS,
  CAD_NAME_PATTERN,
  exportHintForExt,
  INGESTABLE_EXTS,
  isCadExt,
  isVisionImage,
  mimeForExt,
  parserRouteForExt,
} from './slug';

const CFB = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** A compound-file head, padding and the DGN header stream's directory name
 *  (UTF-16LE); `seed` keeps the content hash, and so the render memo, apart
 *  per test. */
function dgnV8(seed: number): Buffer {
  return Buffer.concat([
    Buffer.from(CFB),
    Buffer.from([seed]),
    Buffer.alloc(55),
    Buffer.from('Dgn~H', 'utf16le'),
  ]);
}
/** A compound file with no DGN stream: an old Word or Excel file. */
function otherCompound(): Buffer {
  return Buffer.concat([
    Buffer.from(CFB),
    Buffer.alloc(56),
    Buffer.from('WordDocument', 'utf16le'),
  ]);
}
function dgnV7(three: boolean): Buffer {
  return Buffer.concat([Buffer.from([three ? 0xc8 : 0x08, 0x09, 0xfe, 0x02]), Buffer.alloc(60)]);
}
function dwg(seed: number): Buffer {
  return Buffer.concat([Buffer.from('AC1027', 'latin1'), Buffer.from([seed]), Buffer.alloc(57)]);
}
const DXF = Buffer.from('0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n', 'latin1');

function reply(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    ok: true,
    dpi: 300,
    version: 'AC1027',
    entities: 7,
    capped: false,
    layers: [{ name: 'PIPE', count: 7 }],
    texts: [{ text: 'P-001', layer: 'PIPE', x: 1, y: 2 }],
    counts: { LINE: 6, TEXT: 1 },
    render_error: null,
    ...extra,
  };
}

function stubParser(body: Record<string, unknown>) {
  vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
  vi.stubEnv('PARSER_TOKEN', 'secret');
  const fetchMock = vi.fn(async () => Response.json(body));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('CAD extension routing', () => {
  it.each(['dwg', 'dxf', 'dgn'])('%s is a CAD drawing on every list', (ext) => {
    expect(CAD_EXTS.has(ext)).toBe(true);
    expect(isCadExt(ext)).toBe(true);
    expect(INGESTABLE_EXTS.has(ext)).toBe(true);
    expect(FILE_DB_EXTS.has(ext)).toBe(true);
    expect(parserRouteForExt(ext)).toBe(ext);
    expect(exportHintForExt(ext)).toBeUndefined();
    expect(mimeForExt(ext).startsWith('image/')).toBe(false);
    // A claimed image mime never sends a drawing to the vision worker.
    expect(isVisionImage(ext, `image/vnd.${ext}`)).toBe(false);
  });

  it('keeps the DWG and DXF mime types', () => {
    expect(mimeForExt('dwg')).toBe('application/acad');
    expect(mimeForExt('dxf')).toBe('application/dxf');
    expect(mimeForExt('dgn')).toBe('application/x-dgn');
  });

  it('keeps DWF and other formats off the CAD list', () => {
    for (const ext of ['dwf', 'dwfx', 'pdf', 'doc', 'vsd']) expect(isCadExt(ext)).toBe(false);
    expect(parserRouteForExt('dwf')).toBe('dwf');
  });

  it('builds the CAD name pattern from the one list', () => {
    const re = new RegExp(CAD_NAME_PATTERN, 'i');
    for (const name of ['a.dwg', 'b.DXF', 'c.dgn', 'd.Dgn']) expect(re.test(name)).toBe(true);
    for (const name of ['a.dwf', 'b.dgn.pdf', 'dgn', 'c.dgnx']) expect(re.test(name)).toBe(false);
    expect(CAD_NAME_PATTERN).toBe('\\.(dwg|dxf|dgn)$');
  });
});

describe('sniffDgn', () => {
  it('knows a V8 compound file and a V7 header, 2D and 3D', () => {
    expect(sniffDgn(dgnV8(1))).toBe(true);
    expect(sniffDgn(dgnV7(false))).toBe(true);
    expect(sniffDgn(dgnV7(true))).toBe(true);
  });

  it('takes a compound file with no DGN stream for a sniff miss (an old Office file)', async () => {
    expect(sniffDgn(otherCompound())).toBe(false);
    const fetchMock = stubParser(reply({ converter: 'ezdgn' }));
    expect(await parseDocumentBytes(otherCompound(), 'dgn')).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the three sniffs apart', () => {
    expect(sniffDgn(dwg(1))).toBe(false);
    expect(sniffDgn(DXF)).toBe(false);
    expect(sniffDgn(Buffer.from('not a drawing'))).toBe(false);
    expect(sniffDwg(dgnV8(1))).toBe(false);
    expect(sniffDxf(dgnV8(1))).toBe(false);
    expect(sniffCad(dwg(1), 'dwg')).toBe(true);
    expect(sniffCad(DXF, 'dxf')).toBe(true);
    expect(sniffCad(dgnV7(false), 'dgn')).toBe(true);
    expect(sniffCad(dwg(1), 'dgn')).toBe(false);
  });
});

describe('the DGN digest', () => {
  it('returns "" on a sniff miss and asks the parser nothing', async () => {
    const fetchMock = stubParser(reply({ converter: 'ezdgn' }));
    expect(await parseDocumentBytes(Buffer.from('not a drawing'), 'dgn')).toBe('');
    const book = await cadRegistryWorkbook(dwg(9), 'dgn');
    expect(book.grids.sheets).toEqual([]);
    expect(book.description).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names the DGN, its converter, and what was not converted', async () => {
    stubParser(
      reply({
        converter: 'ezdgn',
        dgn: {
          format: 'V8',
          dimension: 3,
          elements: 100,
          converted: 84,
          not_converted_total: 16,
          not_converted: [
            { kind: 'Other', type: 33, name: 'dimension', count: 12 },
            { kind: 'Other', type: 37, name: 'tag', count: 4 },
          ],
          models: [
            { name: 'Main', space: 'model', elements: 100 },
            { name: 'Sheet', space: 'empty', elements: 0 },
          ],
          note: '3D model: drawn in plan.',
        },
      }),
    );
    const text = await parseDocumentBytes(dgnV8(2), 'dgn');
    const lines = text.split('\n');
    expect(lines[0]).toBe(
      'MicroStation DGN drawing (V8, 3D) — 7 model-space entities, 1 layers. Converted via ezdgn.',
    );
    expect(text).toContain(
      'Not converted: 16 of 100 DGN elements (dimension (type 33) 12, tag (type 37) 4).',
    );
    expect(text).toContain('Models: Main (model, 100 elements); Sheet (empty, 0 elements).');
    expect(text).toContain('3D model: drawn in plan.');
    expect(text).toContain('P-001');
  });

  it('says the V7 dimension once', async () => {
    stubParser(
      reply({
        converter: 'ezdgn',
        dgn: { format: 'V7 2D', dimension: 2, elements: 7, converted: 7, not_converted_total: 0 },
      }),
    );
    const text = await parseDocumentBytes(dgnV7(false), 'dgn');
    expect(text.split('\n')[0]).toBe(
      'MicroStation DGN drawing (V7 2D) — 7 model-space entities, 1 layers. Converted via ezdgn.',
    );
    expect(text).not.toContain('Not converted');
  });

  it('keeps a converter name it does not know as unknown, never dwg2dxf', async () => {
    stubParser(reply({ converter: 'ezdgn2' }));
    const text = await parseDocumentBytes(dwg(4), 'dwg');
    expect(text.split('\n')[0]).toContain('Converted via unknown.');
    expect(text).not.toContain('dwg2dxf');
  });

  it('a DGN reply with no DGN facts names no AutoCAD release', async () => {
    stubParser(reply({ converter: 'ezdgn' }));
    const text = await parseDocumentBytes(dgnV8(5), 'dgn');
    expect(text.split('\n')[0]).toBe(
      'MicroStation DGN drawing — 7 model-space entities, 1 layers. Converted via ezdgn.',
    );
  });

  it('a DGN registry is described as MicroStation, a DWG as before', () => {
    const grids = { sheets: [], capped: false };
    expect(dwgTableDescription('dgn', grids)).toMatch(/^MicroStation DGN model-space registry\./);
    expect(dwgTableDescription('dwg', grids)).toMatch(/^AutoCAD DWG model-space registry\./);
    expect(dwgTableDescription('dxf', grids)).toMatch(/^AutoCAD DXF model-space registry\./);
  });

  it('leaves the DWG and DXF digest as it was', async () => {
    stubParser(reply({ converter: 'dwg2dxf' }));
    const dwgText = await parseDocumentBytes(dwg(3), 'dwg');
    expect(dwgText.split('\n')[0]).toBe(
      'AutoCAD DWG drawing (AC1027 / AutoCAD 2013) — 7 model-space entities, 1 layers. Converted via dwg2dxf.',
    );
    expect(dwgText).not.toContain('Not converted');
    vi.unstubAllGlobals();
    stubParser(reply({ converter: 'none', version: 'AC1015' }));
    const dxfText = await parseDocumentBytes(DXF, 'dxf');
    expect(dxfText.split('\n')[0]).toBe(
      'AutoCAD DXF drawing (AC1015 / AutoCAD 2000) — 7 model-space entities, 1 layers. Parsed natively as DXF.',
    );
  });
});
