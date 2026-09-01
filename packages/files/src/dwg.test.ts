import { describe, expect, it, vi } from 'vitest';
import { explainDwgImageMiss, extractDwgImages, parseDwg, parseDwgToGrids, sniffDwg } from './dwg';
import { parseDocumentBytes } from './parse';

/** Synthesized header-only fixture — never real drawing bytes (public repo).
 *  The render memo is keyed by CONTENT HASH now, so each test that stubs its
 *  own sidecar reply must use a distinct `seed` or it would replay another
 *  test's memoised exchange. */
function dwgFixture(seed: number): Buffer {
  return Buffer.concat([Buffer.from('AC1027', 'latin1'), Buffer.from([seed]), Buffer.alloc(63)]);
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
      // ATTRIB-harvested values (block attributes) ride the same list.
      { text: '90-20-07', layer: 'TITLE_BLOCK', x: 400, y: 5 },
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
      await expect(parseDwg(dwgFixture(1))).rejects.toThrow(/media sidecar CAD tier/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('propagates the sidecar-missing throw through parseDocumentBytes (no title fallback)', async () => {
    // Finding 2: the extract must surface a real, retryable error — the parse
    // dispatcher must never swallow this into '' (which reads as "no parser").
    vi.stubEnv('MEDIA_SIDECAR_URL', '');
    vi.stubEnv('MEDIA_SIDECAR_TOKEN', '');
    try {
      await expect(parseDocumentBytes(dwgFixture(2), 'dwg')).rejects.toThrow(
        /media sidecar CAD tier/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('builds the digest from the sidecar registry, ATTRIB values included', async () => {
    stubSidecar();
    try {
      const digest = await parseDwg(dwgFixture(3));
      expect(digest).toContain('AC1027 / AutoCAD 2013');
      expect(digest).toContain('42 model-space entities');
      expect(digest).toContain('Converted via dwg2dxf');
      expect(digest).toContain('PIPE_CENTRELINE (30)');
      // Dedupe with counts: DN150 appears twice in the entities, once here.
      expect(digest).toContain('DN150 (×2)');
      expect(digest).toContain('90-10-01');
      // Finding 1: block-attribute text and its ATTRIB count both surface.
      expect(digest).toContain('90-20-07');
      expect(digest).toContain('ATTRIB 4');
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('shares ONE sidecar exchange across digest, grids and images', async () => {
    const fetchMock = stubSidecar();
    try {
      const bytes = dwgFixture(4);
      await parseDwg(bytes);
      const grids = await parseDwgToGrids(bytes);
      const images = await extractDwgImages(bytes);
      const renders = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/dwg/render'));
      expect(renders).toHaveLength(1);
      expect(grids.sheets.map((g) => g.name)).toEqual(['Layers', 'Texts', 'Counts']);
      expect(images).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('shares the exchange across DISTINCT Buffers of the same bytes (hash memo)', async () => {
    // Finding 14: the extractor's byte cache can evict + re-read between
    // passes; a fresh Buffer of identical content must not pay a second upload.
    const fetchMock = stubSidecar();
    try {
      await parseDwg(dwgFixture(5));
      await extractDwgImages(dwgFixture(5));
      const renders = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/dwg/render'));
      expect(renders).toHaveLength(1);
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
      const grids = await parseDwgToGrids(dwgFixture(6));
      const texts = grids.sheets.find((g) => g.name === 'Texts')!;
      expect(texts.columns.map((c) => c.name)).toEqual(['Text', 'Layer', 'X', 'Y']);
      expect(texts.rows[0]).toEqual(['90-10-01', 'ANNOTATION', 10.5, 20.1]);
      expect(grids.capped).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('threads the registry cap bit through (finding 12)', async () => {
    stubSidecar({ ...sidecarReply(), capped: true });
    try {
      const grids = await parseDwgToGrids(dwgFixture(7));
      expect(grids.capped).toBe(true);
      expect(grids.sheets.length).toBeGreaterThan(0);
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
      expect(await extractDwgImages(dwgFixture(8))).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('ships the render as one essential, provenance-stamped image', async () => {
    stubSidecar();
    try {
      const images = await extractDwgImages(dwgFixture(9));
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
      expect(await extractDwgImages(dwgFixture(10))).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('explains a failed render from the reply render_error (finding 7)', async () => {
    stubSidecar({
      ...sidecarReply(),
      png_base64: '',
      render_error: 'MemoryError: rasteriser blew the budget',
    });
    try {
      const bytes = dwgFixture(11);
      expect(await extractDwgImages(bytes)).toEqual([]);
      expect(await explainDwgImageMiss(bytes)).toContain('MemoryError');
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('explains a sniff miss and a disabled sidecar without an exchange', async () => {
    expect(await explainDwgImageMiss(Buffer.from('junk'))).toContain('sniff miss');
    vi.stubEnv('MEDIA_SIDECAR_URL', '');
    vi.stubEnv('MEDIA_SIDECAR_TOKEN', '');
    try {
      expect(await explainDwgImageMiss(dwgFixture(12))).toContain('not enabled');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('render retry provenance (render_converter)', () => {
  it('parses renderConverter when the pixels came from the ezdwg retry', async () => {
    // Worker semantics: registry from dwg2dxf's DXF, render retried from
    // ezdwg's DXF after a block-definition failure — the reply carries both
    // the primary converter and the render's provenance.
    stubSidecar({ ...sidecarReply(), render_converter: 'ezdwg' });
    try {
      const { mediaDwgRender } = await import('./media-sidecar');
      const res = await mediaDwgRender(dwgFixture(13));
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.converter).toBe('dwg2dxf');
        expect(res.value.renderConverter).toBe('ezdwg');
        expect(res.value.png).not.toBeNull();
      }
      // The image pass ships the render like any other.
      expect(await extractDwgImages(dwgFixture(13))).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('renderConverter stays null on a first-shot render', async () => {
    stubSidecar();
    try {
      const { mediaDwgRender } = await import('./media-sidecar');
      const res = await mediaDwgRender(dwgFixture(14));
      expect(res.ok && res.value.renderConverter).toBe(null);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});
