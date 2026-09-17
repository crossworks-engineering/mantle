import { describe, expect, it, vi } from 'vitest';
import { explainDxfImageMiss, extractDxfImages, parseDxf, parseDxfToGrids, sniffDxf } from './dxf';
import { parseDocumentBytes } from './parse';

/** Synthesized minimal ASCII DXF — never real drawing bytes (public repo).
 *  The render memo is keyed by CONTENT HASH, so each test that stubs its own
 *  sidecar reply must use a distinct `seed` (a 999 comment pair keeps the
 *  bytes unique without breaking the sniff). */
function dxfFixture(seed: number): Buffer {
  return Buffer.from(
    `999\nseed-${seed}\n0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n`,
  );
}

const BINARY_SENTINEL = Buffer.from('AutoCAD Binary DXF\r\n\x1a\x00', 'latin1');

const RENDER_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082',
  'hex',
);

/** One reply shape for every test — the 90-xx decoy series, like dwg.test.ts.
 *  converter "none" is the native-DXF marker the sidecar reports. */
function sidecarReply() {
  return {
    ok: true,
    dpi: 300,
    converter: 'none',
    version: 'AC1027',
    entities: 42,
    capped: false,
    layers: [
      { name: 'PIPE_CENTRELINE', count: 30 },
      { name: 'ANNOTATION', count: 12 },
    ],
    texts: [
      { text: '90-10-02', layer: 'ANNOTATION', x: 10.5, y: 20.1 },
      { text: 'DN200', layer: 'ANNOTATION', x: 11, y: 21 },
      { text: 'DN200', layer: 'ANNOTATION', x: 12, y: 22 },
      // ATTRIB-harvested values (block attributes) ride the same list.
      { text: '90-20-08', layer: 'TITLE_BLOCK', x: 400, y: 5 },
    ],
    counts: { LINE: 30, TEXT: 12, ATTRIB: 4 },
    render_error: null,
    png_base64: RENDER_PNG.toString('base64'),
  };
}

function stubSidecar(reply: Record<string, unknown> = sidecarReply()) {
  vi.stubEnv('MEDIA_SIDECAR_URL', 'http://media.test:8095');
  vi.stubEnv('MEDIA_SIDECAR_TOKEN', 'secret');
  const fetchMock = vi.fn(async (url: unknown) => {
    if (String(url).endsWith('/healthz')) {
      return Response.json({
        ok: true,
        versions: {
          yt_dlp: null,
          ffmpeg: '8.1',
          ezdwf: '0.0.3',
          dwg2dxf: '0.13.3',
          ezdxf: '1.4.4',
        },
      });
    }
    return Response.json(reply);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('sniffDxf', () => {
  it('accepts a plain ASCII DXF (0/SECTION lead pair)', () => {
    expect(sniffDxf(Buffer.from('0\nSECTION\n2\nHEADER\n'))).toBe(true);
  });

  it('accepts leading 999 comment pairs, CRLF, space-padded codes, and a BOM', () => {
    expect(sniffDxf(dxfFixture(0))).toBe(true);
    expect(sniffDxf(Buffer.from('999\nwritten by a plotter\r\n  0\r\nSECTION\r\n'))).toBe(true);
    expect(
      sniffDxf(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('0\nSECTION\n')])),
    ).toBe(true);
  });

  it('accepts the binary-DXF sentinel', () => {
    expect(sniffDxf(Buffer.concat([BINARY_SENTINEL, Buffer.alloc(32)]))).toBe(true);
  });

  it('rejects DWG bytes and junk', () => {
    expect(sniffDxf(Buffer.concat([Buffer.from('AC1027', 'latin1'), Buffer.alloc(64)]))).toBe(
      false,
    );
    expect(sniffDxf(Buffer.from('PK\x03\x04'))).toBe(false);
    expect(sniffDxf(Buffer.from('just some text\nwith lines\n'))).toBe(false);
    expect(sniffDxf(Buffer.alloc(3))).toBe(false);
  });
});

describe('parseDxf', () => {
  it('returns "" on a sniff miss (hollow-skip contract)', async () => {
    expect(await parseDxf(Buffer.from('not a drawing'))).toBe('');
  });

  it('throws a typed pointer when the sidecar is not configured', async () => {
    vi.stubEnv('MEDIA_SIDECAR_URL', '');
    vi.stubEnv('MEDIA_SIDECAR_TOKEN', '');
    try {
      await expect(parseDxf(dxfFixture(1))).rejects.toThrow(/media sidecar CAD tier/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('propagates the sidecar-missing throw through parseDocumentBytes (no title fallback)', async () => {
    // The extract must surface a real, retryable error — the parse dispatcher
    // must never swallow this into '' (which reads as "no parser").
    vi.stubEnv('MEDIA_SIDECAR_URL', '');
    vi.stubEnv('MEDIA_SIDECAR_TOKEN', '');
    try {
      await expect(parseDocumentBytes(dxfFixture(2), 'dxf')).rejects.toThrow(
        /media sidecar CAD tier/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('returns "" through parseDocumentBytes on a sniff miss, sidecar or not', async () => {
    // A renamed non-DXF must take the hollow skip, never a junk digest.
    expect(await parseDocumentBytes(Buffer.from('just some text\n'), 'dxf')).toBe('');
  });

  it('builds the digest from the sidecar registry, native-DXF wording included', async () => {
    stubSidecar();
    try {
      const digest = await parseDxf(dxfFixture(3));
      expect(digest).toContain('AutoCAD DXF drawing');
      expect(digest).toContain('AC1027 / AutoCAD 2013');
      expect(digest).toContain('42 model-space entities');
      // converter "none" reads as native parsing, not "Converted via none".
      expect(digest).toContain('Parsed natively as DXF.');
      expect(digest).toContain('PIPE_CENTRELINE (30)');
      expect(digest).toContain('DN200 (×2)');
      expect(digest).toContain('90-10-02');
      // Block-attribute text and its ATTRIB count both surface, like dwg.
      expect(digest).toContain('90-20-08');
      expect(digest).toContain('ATTRIB 4');
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('shares ONE sidecar exchange across digest, grids and images', async () => {
    const fetchMock = stubSidecar();
    try {
      const bytes = dxfFixture(4);
      await parseDxf(bytes);
      const grids = await parseDxfToGrids(bytes);
      const images = await extractDxfImages(bytes);
      const renders = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/dwg/render'));
      expect(renders).toHaveLength(1);
      expect(grids.sheets.map((g) => g.name)).toEqual(['Layers', 'Texts', 'Counts']);
      expect(images).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});

describe('parseDxfToGrids', () => {
  it('keeps text coordinates and threads the cap bit through', async () => {
    stubSidecar({ ...sidecarReply(), capped: true });
    try {
      const grids = await parseDxfToGrids(dxfFixture(5));
      const texts = grids.sheets.find((g) => g.name === 'Texts')!;
      expect(texts.columns.map((c) => c.name)).toEqual(['Text', 'Layer', 'X', 'Y']);
      expect(texts.rows[0]).toEqual(['90-10-02', 'ANNOTATION', 10.5, 20.1]);
      expect(grids.capped).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});

describe('extractDxfImages', () => {
  it('returns [] on a sniff miss and when the sidecar is off', async () => {
    expect(await extractDxfImages(Buffer.from('junk'))).toEqual([]);
    vi.stubEnv('MEDIA_SIDECAR_URL', '');
    vi.stubEnv('MEDIA_SIDECAR_TOKEN', '');
    try {
      expect(await extractDxfImages(dxfFixture(6))).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('ships the render as one essential, provenance-stamped image', async () => {
    stubSidecar();
    try {
      const images = await extractDxfImages(dxfFixture(7));
      expect(images).toHaveLength(1);
      expect(images[0]!.bytes.equals(RENDER_PNG)).toBe(true);
      expect(images[0]!.essential).toBe(true);
      expect(images[0]!.provenance).toBe('sidecar_render');
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('explains a failed render from the reply render_error', async () => {
    stubSidecar({
      ...sidecarReply(),
      png_base64: '',
      render_error: 'MemoryError: rasteriser blew the budget',
    });
    try {
      const bytes = dxfFixture(8);
      expect(await extractDxfImages(bytes)).toEqual([]);
      expect(await explainDxfImageMiss(bytes)).toContain('MemoryError');
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('explains a sniff miss and a disabled sidecar without an exchange', async () => {
    expect(await explainDxfImageMiss(Buffer.from('junk'))).toContain('sniff miss');
    vi.stubEnv('MEDIA_SIDECAR_URL', '');
    vi.stubEnv('MEDIA_SIDECAR_TOKEN', '');
    try {
      expect(await explainDxfImageMiss(dxfFixture(9))).toContain('not enabled');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
