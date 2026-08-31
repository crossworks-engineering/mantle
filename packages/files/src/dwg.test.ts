import { describe, expect, it, vi } from 'vitest';
import { extractDwgImages, parseDwg, parseDwgToGrids, sniffDwg } from './dwg';

/** Synthesized header-only fixture — never real drawing bytes (public repo). */
function dwgFixture(): Buffer {
  return Buffer.concat([Buffer.from('AC1027', 'latin1'), Buffer.alloc(64)]);
}

const RENDER_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082',
  'hex',
);

/** One reply shape for every test — the 90-xx decoy series, like dwf.test.ts. */
function sidecarReply() {
  return {
    ok: true,
    dpi: 300,
    converter: 'dwg2dxf',
    version: 'AC1027',
    entities: 42,
    capped: false,
    layers: [
      { name: 'PIPE_CENTRELINE', count: 30 },
      { name: 'ANNOTATION', count: 12 },
    ],
    texts: [
      { text: '90-10-01', layer: 'ANNOTATION', x: 10.5, y: 20.1 },
      { text: 'DN150', layer: 'ANNOTATION', x: 11, y: 21 },
      { text: 'DN150', layer: 'ANNOTATION', x: 12, y: 22 },
    ],
    counts: { LINE: 30, TEXT: 12 },
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

describe('sniffDwg', () => {
  it('accepts every AC1xxx version magic', () => {
    for (const v of ['AC1012', 'AC1015', 'AC1027', 'AC1032']) {
      expect(sniffDwg(Buffer.concat([Buffer.from(v), Buffer.alloc(16)]))).toBe(true);
    }
  });
  it('rejects non-DWG bytes', () => {
    expect(sniffDwg(Buffer.from('PK\x03\x04'))).toBe(false);
    expect(sniffDwg(Buffer.from('(DWF V06.20)'))).toBe(false);
    expect(sniffDwg(Buffer.alloc(3))).toBe(false);
  });
});

describe('parseDwg', () => {
  it('returns "" on a sniff miss (hollow-skip contract)', async () => {
    expect(await parseDwg(Buffer.from('not a drawing'))).toBe('');
  });

  it('throws a typed pointer when the sidecar is not configured', async () => {
    vi.stubEnv('MEDIA_SIDECAR_URL', '');
    vi.stubEnv('MEDIA_SIDECAR_TOKEN', '');
    try {
      await expect(parseDwg(dwgFixture())).rejects.toThrow(/media sidecar CAD tier/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('builds the digest from the sidecar registry', async () => {
    stubSidecar();
    try {
      const digest = await parseDwg(dwgFixture());
      expect(digest).toContain('AC1027 / AutoCAD 2013');
      expect(digest).toContain('42 model-space entities');
      expect(digest).toContain('Converted via dwg2dxf');
      expect(digest).toContain('PIPE_CENTRELINE (30)');
      // Dedupe with counts: DN150 appears twice in the entities, once here.
      expect(digest).toContain('DN150 (×2)');
      expect(digest).toContain('90-10-01');
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('shares ONE sidecar exchange across digest, grids and images', async () => {
    const fetchMock = stubSidecar();
    try {
      const bytes = dwgFixture();
      await parseDwg(bytes);
      const grids = await parseDwgToGrids(bytes);
      const images = await extractDwgImages(bytes);
      const renders = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/dwg/render'));
      expect(renders).toHaveLength(1);
      expect(grids.map((g) => g.name)).toEqual(['Layers', 'Texts', 'Counts']);
      expect(images).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});

describe('parseDwgToGrids', () => {
  it('keeps text coordinates for the geometry phase', async () => {
    stubSidecar();
    try {
      const grids = await parseDwgToGrids(dwgFixture());
      const texts = grids.find((g) => g.name === 'Texts')!;
      expect(texts.columns.map((c) => c.name)).toEqual(['Text', 'Layer', 'X', 'Y']);
      expect(texts.rows[0]).toEqual(['90-10-01', 'ANNOTATION', 10.5, 20.1]);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});

describe('extractDwgImages', () => {
  it('returns [] on a sniff miss and when the sidecar is off', async () => {
    expect(await extractDwgImages(Buffer.from('junk'))).toEqual([]);
    vi.stubEnv('MEDIA_SIDECAR_URL', '');
    vi.stubEnv('MEDIA_SIDECAR_TOKEN', '');
    try {
      expect(await extractDwgImages(dwgFixture())).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('ships the render as one essential, provenance-stamped image', async () => {
    stubSidecar();
    try {
      const images = await extractDwgImages(dwgFixture());
      expect(images).toHaveLength(1);
      expect(images[0]!.bytes.equals(RENDER_PNG)).toBe(true);
      expect(images[0]!.essential).toBe(true);
      expect(images[0]!.provenance).toBe('sidecar_render');
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('returns [] (not a throw) when the render is missing from the reply', async () => {
    stubSidecar({ ...sidecarReply(), png_base64: '' });
    try {
      expect(await extractDwgImages(dwgFixture())).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});
