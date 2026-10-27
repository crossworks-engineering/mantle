import { describe, expect, it, vi } from 'vitest';
import {
  dwgRenderDpi,
  dwgTableDescription,
  explainDwgImageMiss,
  extractDwgImages,
  parseDwg,
  parseDwgToGrids,
  sniffDwg,
} from './dwg';
import { parseDocumentBytes } from './parse';
import { isParserError, resetParserFailures } from './parser-client';

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

/** The parser's CAD tier, faked at the fetch: every /dwg/render answers
 *  `reply`. */
function stubSidecar(reply: Record<string, unknown> = sidecarReply()) {
  vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
  vi.stubEnv('PARSER_TOKEN', 'secret');
  const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => Response.json(reply));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The parser not running: the connection is refused. */
function stubParserDown() {
  vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      });
    }),
  );
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

  it('throws a typed, retryable error when the parser cannot be reached', async () => {
    stubParserDown();
    try {
      const err = await parseDwg(dwgFixture(1)).catch((e: unknown) => e);
      expect(isParserError(err)).toBe(true);
      expect(err).toMatchObject({ code: 'unavailable', retryable: true, terminal: false });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('propagates the parser failure through parseDocumentBytes (no title fallback)', async () => {
    // Finding 2: the extract must surface a real, retryable error — the parse
    // dispatcher must never swallow this into '' (which reads as "no parser").
    stubParserDown();
    try {
      await expect(parseDocumentBytes(dwgFixture(2), 'dwg')).rejects.toMatchObject({
        code: 'unavailable',
        retryable: true,
      });
    } finally {
      vi.unstubAllGlobals();
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

  it('keeps a block’s attribute tags together on the Blocks tab', async () => {
    // The circuitized-P&ID shape: LINENO and CIRCUIT on one LineNumber block.
    // Flattened into Texts they are two unrelated rows; here they share one.
    stubSidecar({
      ...sidecarReply(),
      blocks: [
        {
          block: 'LineNumber',
          layer: 'LINE_TAGS',
          handle: '9A1',
          x: 10,
          y: 20,
          attribs: { LINENO: 'N90010-10-6"', CIRCUIT: 'Circuit 90000-010-01', STANDARD: '' },
        },
        {
          block: 'LineNumber',
          layer: 'LINE_TAGS',
          handle: '9A2',
          x: 30,
          y: 40,
          attribs: { LINENO: 'N90011-10-4"', CIRCUIT: 'Circuit 90000-011-01' },
        },
        // A tag named like a fixed column is renamed, never merged into it.
        { block: 'Valve', layer: 'VALVES', handle: '9A3', x: 5, y: 6, attribs: { X: 'gate' } },
        // A block whose attributes are all blank is not a row.
        { block: 'Empty', layer: 'L', handle: '9A4', x: 0, y: 0, attribs: { TAG: '' } },
      ],
    });
    try {
      const bytes = dwgFixture(15);
      const grids = await parseDwgToGrids(bytes);
      expect(grids.sheets.map((g) => g.name)).toEqual(['Layers', 'Texts', 'Blocks', 'Counts']);
      const blocks = grids.sheets.find((g) => g.name === 'Blocks')!;
      expect(blocks.columns.map((c) => c.name)).toEqual([
        'Block',
        'Layer',
        'Handle',
        'X',
        'Y',
        'CIRCUIT',
        'LINENO',
        'X (attribute)',
      ]);
      expect(blocks.rows).toEqual([
        ['LineNumber', 'LINE_TAGS', '9A1', 10, 20, 'Circuit 90000-010-01', 'N90010-10-6"', ''],
        ['LineNumber', 'LINE_TAGS', '9A2', 30, 40, 'Circuit 90000-011-01', 'N90011-10-4"', ''],
        ['Valve', 'VALVES', '9A3', 5, 6, '', '', 'gate'],
      ]);
      expect(grids.capped).toBe(false);

      // The digest carries the pair as one retrievable line.
      const digest = await parseDwg(bytes);
      expect(digest).toContain('Block attributes (3 blocks, 3 unique):');
      expect(digest).toContain('LineNumber: LINENO=N90010-10-6", CIRCUIT=Circuit 90000-010-01');
      expect(digest).not.toContain('STANDARD=');
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('keeps a blocks cap apart from the Texts cap', async () => {
    // A title block alone can carry dozens of tags; past the column cap the
    // Blocks tab is incomplete, but Texts is not, and must not say so.
    const attribs: Record<string, string> = {};
    for (let i = 0; i < 45; i++) attribs[`T${String(i).padStart(2, '0')}`] = `v${i}`;
    stubSidecar({
      ...sidecarReply(),
      blocks: [{ block: 'Title', layer: 'TB', handle: '9B1', x: 0, y: 0, attribs }],
    });
    try {
      const grids = await parseDwgToGrids(dwgFixture(16));
      expect(grids.capped).toBe(false);
      expect(grids.blocksCapped).toBe(true);
      const blocks = grids.sheets.find((g) => g.name === 'Blocks')!;
      expect(blocks.columns).toHaveLength(5 + 40);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
    stubSidecar({ ...sidecarReply(), blocks_capped: true });
    try {
      const grids = await parseDwgToGrids(dwgFixture(17));
      expect(grids.capped).toBe(false);
      expect(grids.blocksCapped).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('reads a tag named like an object built-in as a plain tag', async () => {
    stubSidecar({
      ...sidecarReply(),
      blocks: [
        { block: 'A', layer: 'L', handle: '9C1', x: 1, y: 1, attribs: { constructor: 'c1' } },
        { block: 'B', layer: 'L', handle: '9C2', x: 2, y: 2, attribs: { LINENO: 'N90020' } },
      ],
    });
    try {
      const grids = await parseDwgToGrids(dwgFixture(18));
      const blocks = grids.sheets.find((g) => g.name === 'Blocks')!;
      const col = blocks.columns.findIndex((c) => c.name === 'constructor');
      expect(col).toBeGreaterThan(-1);
      expect(blocks.rows[0]![col]).toBe('c1');
      // Block B has no such tag: an empty cell, not Object's constructor.
      expect(blocks.rows[1]![col]).toBe('');
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('lists block lines in drawing order so unique pairs are not pushed out', async () => {
    stubSidecar({
      ...sidecarReply(),
      blocks: [
        {
          block: 'LineNumber',
          layer: 'L',
          handle: '9D1',
          x: 1,
          y: 1,
          attribs: { LINENO: 'N90031' },
        },
        { block: 'Title', layer: 'TB', handle: '9D2', x: 0, y: 0, attribs: { SHEET: '1' } },
        { block: 'Title', layer: 'TB', handle: '9D3', x: 0, y: 0, attribs: { SHEET: '1' } },
      ],
    });
    try {
      const digest = await parseDwg(dwgFixture(19));
      const line = digest.indexOf('LineNumber: LINENO=N90031');
      const title = digest.indexOf('Title: SHEET=1 (×2)');
      expect(line).toBeGreaterThan(-1);
      expect(title).toBeGreaterThan(line);
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

/** The bones half of a reply (dwg_bones.py), on the 90-xx decoy series. */
function bonesReply(extra: Record<string, unknown> = {}) {
  const main = 'Circuit 90000-030-01';
  return {
    ...sidecarReply(),
    segments: [
      {
        layer: main,
        handle: '7A1',
        type: 'LINE',
        part: 0,
        x1: 0,
        y1: 0,
        x2: 40,
        y2: 0,
        length: 40,
        n1: 1,
        n2: 2,
        run: 1,
      },
      {
        layer: main,
        handle: '7A1',
        type: 'LINE',
        part: 0,
        x1: 40,
        y1: 0,
        x2: 100,
        y2: 0,
        length: 60,
        n1: 2,
        n2: 3,
        run: 1,
      },
      {
        layer: `${main}-DL`,
        handle: '7A2',
        type: 'LWPOLYLINE',
        part: 1,
        x1: 40,
        y1: 0,
        x2: 40,
        y2: -30,
        length: 30,
        n1: 2,
        n2: 4,
        run: 1,
      },
    ],
    nodes: [
      { id: 1, x: 0, y: 0, degree: 1, kind: 'end', block: '', block_handle: '', layers: main },
      {
        id: 2,
        x: 40,
        y: 0,
        degree: 3,
        kind: 'tee',
        block: '',
        block_handle: '',
        layers: `${main}; ${main}-DL`,
      },
      {
        id: 3,
        x: 100,
        y: 0,
        degree: 1,
        kind: 'block',
        block: 'GATE_VALVE',
        block_handle: '7B1',
        layers: main,
      },
      {
        id: 4,
        x: 40,
        y: -30,
        degree: 1,
        kind: 'end',
        block: '',
        block_handle: '',
        layers: `${main}-DL`,
      },
    ],
    inserts: [
      {
        block: 'GATE_VALVE',
        layer: 'VALVES',
        handle: '7B1',
        x: 100,
        y: 0,
        rotation: 0,
        sx: 1,
        sy: 1,
        minx: 100,
        miny: -1,
        maxx: 102,
        maxy: 1,
        attribs: 0,
      },
      {
        block: 'LineNumber',
        layer: 'TAGS',
        handle: '7B2',
        x: 20,
        y: 2,
        rotation: 0,
        sx: 1,
        sy: 1,
        minx: null,
        miny: null,
        maxx: null,
        maxy: null,
        attribs: 2,
      },
    ],
    circuits: [
      {
        circuit: '90000-030-01',
        parent: '',
        kind: 'circuit',
        layers: `${main}; ${main}-DL`,
        entities: 1,
        segments: 2,
        length: 100,
        deadleg_segments: 1,
        deadleg_length: 30,
        runs: 1,
        tees: 1,
        ends: 3,
        end_points: '#1 (0.0, 0.0) open; #4 (40.0, -30.0) open',
        line_numbers: 'N90030-10-6 [7B2]',
        nearby_text: 'N90030-10-6; DN150',
      },
    ],
    geometry: {
      snap_tolerance: 0.0213,
      near_distance: 1.06,
      extent_diagonal: 106.3,
      segments: 3,
      nodes: 4,
      node_kinds: { end: 2, tee: 1, block: 1 },
      inserts: 2,
      runs: 1,
      circuits: 1,
      skipped: { SPLINE: 2 },
    },
    segments_capped: false,
    nodes_capped: false,
    inserts_capped: false,
    circuits_capped: false,
    geometry_error: null,
    ...extra,
  };
}

describe('the bones tabs', () => {
  it('adds Segments, Nodes, Inserts and Circuits after the registry tabs', async () => {
    stubSidecar(bonesReply());
    try {
      const grids = await parseDwgToGrids(dwgFixture(30));
      // The registry tabs keep their names, order and columns.
      expect(grids.sheets.map((g) => g.name)).toEqual([
        'Layers',
        'Texts',
        'Counts',
        'Segments',
        'Nodes',
        'Inserts',
        'Circuits',
      ]);
      const texts = grids.sheets.find((g) => g.name === 'Texts')!;
      expect(texts.columns.map((c) => c.name)).toEqual(['Text', 'Layer', 'X', 'Y']);

      const segments = grids.sheets.find((g) => g.name === 'Segments')!;
      expect(segments.columns.map((c) => c.name)).toEqual([
        'Layer',
        'Handle',
        'Type',
        'Part',
        'X1',
        'Y1',
        'X2',
        'Y2',
        'Length',
        'Node 1',
        'Node 2',
        'Run',
      ]);
      // A header split by a tee: two rows, one handle.
      expect(segments.rows.filter((r) => r[1] === '7A1')).toHaveLength(2);
      expect(segments.rows[2]).toEqual([
        'Circuit 90000-030-01-DL',
        '7A2',
        'LWPOLYLINE',
        1,
        40,
        0,
        40,
        -30,
        30,
        2,
        4,
        1,
      ]);

      const nodes = grids.sheets.find((g) => g.name === 'Nodes')!;
      expect(nodes.columns.map((c) => c.name)).toEqual([
        'Node',
        'X',
        'Y',
        'Degree',
        'Kind',
        'Block',
        'Block handle',
        'Layers',
      ]);
      expect(nodes.rows[2]).toEqual([
        3,
        100,
        0,
        1,
        'block',
        'GATE_VALVE',
        '7B1',
        'Circuit 90000-030-01',
      ]);

      const inserts = grids.sheets.find((g) => g.name === 'Inserts')!;
      expect(inserts.columns.map((c) => c.name)).toEqual([
        'Block',
        'Layer',
        'Handle',
        'X',
        'Y',
        'Rotation',
        'Scale X',
        'Scale Y',
        'Min X',
        'Min Y',
        'Max X',
        'Max Y',
        'Attributes',
      ]);
      expect(inserts.rows[1]).toEqual([
        'LineNumber',
        'TAGS',
        '7B2',
        20,
        2,
        0,
        1,
        1,
        null,
        null,
        null,
        null,
        2,
      ]);

      const circuits = grids.sheets.find((g) => g.name === 'Circuits')!;
      expect(circuits.columns.map((c) => c.name)).toEqual([
        'Circuit',
        'Parent',
        'Kind',
        'Layers',
        'Entities',
        'Segments',
        'Length',
        'Deadleg segments',
        'Deadleg length',
        'Runs',
        'Tees',
        'Ends',
        'End points',
        'Line numbers',
        'Nearby text',
      ]);
      expect(circuits.rows[0]!.slice(0, 12)).toEqual([
        '90000-030-01',
        '',
        'circuit',
        'Circuit 90000-030-01; Circuit 90000-030-01-DL',
        1,
        2,
        100,
        1,
        30,
        1,
        1,
        3,
      ]);
      expect(grids.geometry).toMatchObject({
        snapTolerance: 0.0213,
        segmentsCapped: false,
        circuitsCapped: false,
        error: null,
      });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('says the tolerance is per sheet when the model space tiles several sheets', async () => {
    const base = bonesReply();
    stubSidecar({ ...base, geometry: { ...base.geometry, sheets: 3 } });
    try {
      const d = dwgTableDescription('dwg', await parseDwgToGrids(dwgFixture(93)));
      expect(d).toContain(
        'ends within 0.0213 drawing units are one node (this model space holds 3 sheets and' +
          " each sheet scales its own tolerance; 0.0213 is the largest sheet's),",
      );
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('says what each new tab holds and what it does not', async () => {
    stubSidecar(bonesReply());
    try {
      const d = dwgTableDescription('dwg', await parseDwgToGrids(dwgFixture(31)));
      expect(d).toMatch(/^AutoCAD DWG model-space registry\. Layers counts entities per layer;/);
      expect(d).toContain('Segments is every LINE on every layer');
      expect(d).toContain('recorded by its chord, with its true arc Length');
      expect(d).toContain(
        'SPLINE, ELLIPSE, CIRCLE, hatches and the lines inside blocks are not segments',
      );
      expect(d).toContain('(this drawing has 2 SPLINE left out)');
      expect(d).toContain('ends within 0.0213 drawing units are one node');
      expect(d).toContain('lines that only cross, with no end at the crossing, are NOT joined');
      expect(d).toContain('Inserts is every block reference, with or without attributes');
      expect(d).toContain("the -DL (-DLn) and -Bnn-DL layers are that circuit's deadlegs");
      expect(d).toContain('a -Dnn layer is read as a deadleg too but that is a GUESS');
      expect(d).toContain('Segments is every LINE on every layer (pipe, leader, border and all)');
      expect(d).toContain('within 1.06 drawing units');
      expect(d).not.toContain('TRUNCATED');
      expect(d).not.toContain(
        'Vector geometry beyond text and block positions is not in this table',
      );
      expect(d).not.toContain('\u2014');
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('claims no Circuits on a drawing without circuit layers', async () => {
    stubSidecar(bonesReply({ circuits: [] }));
    try {
      const grids = await parseDwgToGrids(dwgFixture(32));
      expect(grids.sheets.map((g) => g.name)).not.toContain('Circuits');
      const d = dwgTableDescription('dxf', grids);
      expect(d).not.toContain('Circuits has');
      expect(d).toContain('Segments is every LINE on every layer');
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('marks only the capped tab TRUNCATED', async () => {
    stubSidecar(bonesReply({ segments_capped: true }));
    try {
      const grids = await parseDwgToGrids(dwgFixture(33));
      expect(grids.geometry!.segmentsCapped).toBe(true);
      expect(grids.geometry!.nodesCapped).toBe(false);
      expect(grids.capped).toBe(false);
      expect(grids.blocksCapped).toBe(false);
      const d = dwgTableDescription('dwg', grids);
      expect(d.match(/TRUNCATED/g)).toHaveLength(1);
      expect(d).toContain('Run numbers the connected runs (TRUNCATED at its cap');
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
    stubSidecar(bonesReply({ circuits_capped: true, nodes_capped: true }));
    try {
      const d = dwgTableDescription('dwg', await parseDwgToGrids(dwgFixture(34)));
      expect(d.match(/TRUNCATED/g)).toHaveLength(2);
      expect(d).toContain('sheet ends here (TRUNCATED');
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('keeps the old wording for a sidecar without geometry, and says why when it failed', async () => {
    stubSidecar();
    try {
      const grids = await parseDwgToGrids(dwgFixture(35));
      expect(grids.geometry).toBeUndefined();
      expect(dwgTableDescription('dwg', grids)).toBe(
        'AutoCAD DWG model-space registry. Layers counts entities per layer; Texts is every' +
          ' annotation string with its layer and model-space X/Y (drawing units); Counts totals' +
          ' entities by type. Vector geometry beyond text and block positions is not in this table.',
      );
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
    stubSidecar({
      ...sidecarReply(),
      geometry_error: 'more than 400000 segments: geometry not built',
    });
    try {
      const grids = await parseDwgToGrids(dwgFixture(36));
      expect(grids.sheets.map((g) => g.name)).toEqual(['Layers', 'Texts', 'Counts']);
      expect(dwgTableDescription('dwg', grids)).toContain(
        'is not in this table (the geometry pass failed: more than 400000 segments',
      );
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('reads a non-number coordinate as null and lists circuits in the digest', async () => {
    const reply = bonesReply();
    reply.segments[0] = { ...reply.segments[0]!, x1: 'NaN' as unknown as number };
    stubSidecar(reply);
    try {
      const bytes = dwgFixture(37);
      const grids = await parseDwgToGrids(bytes);
      const segments = grids.sheets.find((g) => g.name === 'Segments')!;
      expect(segments.rows[0]![4]).toBeNull();
      const digest = await parseDwg(bytes);
      expect(digest).toContain(
        'Geometry: 3 segments, 4 nodes (2 ends, 0 joints, 1 tees, 1 block joins), 1 runs, 2 inserts.',
      );
      expect(digest).toContain(
        'Circuit 90000-030-01: 2 segments (100 long), 1 deadleg segments (30), 1 run, 1 tee, 3 ends; line numbers N90030-10-6 [7B2]',
      );
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});

describe('extractDwgImages', () => {
  it('returns [] on a sniff miss, and throws a retryable error when the parser is down', async () => {
    expect(await extractDwgImages(Buffer.from('junk'))).toEqual([]);
    stubParserDown();
    try {
      await expect(extractDwgImages(dwgFixture(8))).rejects.toMatchObject({
        code: 'unavailable',
        retryable: true,
      });
    } finally {
      vi.unstubAllGlobals();
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

  it('explains a sniff miss and a failed exchange without a new exchange', async () => {
    expect(await explainDwgImageMiss(Buffer.from('junk'))).toContain('sniff miss');
    stubParserDown();
    try {
      await extractDwgImages(dwgFixture(12)).catch(() => null);
      expect(await explainDwgImageMiss(dwgFixture(12))).toContain('parser exchange failed');
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      resetParserFailures();
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
      const { parserDwgRender } = await import('./parser-cad');
      const res = await parserDwgRender(dwgFixture(13));
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
      const { parserDwgRender } = await import('./parser-cad');
      const res = await parserDwgRender(dwgFixture(14));
      expect(res.ok && res.value.renderConverter).toBe(null);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});

describe('dwgRenderDpi', () => {
  // The compose anchor is `DWG_RENDER_DPI: ${DWG_RENDER_DPI:-}`, so an unset
  // dial arrives as the EMPTY STRING — and Number('') is 0, which is finite.
  // Treating that as 50 (the clamp floor) rendered every DWG on every default
  // box at 800×500, small enough that the image gate dropped it outright.
  it('falls back to 300 for unset, empty and non-numeric values', () => {
    vi.stubEnv('DWG_RENDER_DPI', '');
    expect(dwgRenderDpi()).toBe(300);
    vi.stubEnv('DWG_RENDER_DPI', '   ');
    expect(dwgRenderDpi()).toBe(300);
    vi.stubEnv('DWG_RENDER_DPI', 'high');
    expect(dwgRenderDpi()).toBe(300);
    vi.stubEnv('DWG_RENDER_DPI', '0');
    expect(dwgRenderDpi()).toBe(300);
    vi.stubEnv('DWG_RENDER_DPI', '-100');
    expect(dwgRenderDpi()).toBe(300);
    vi.unstubAllEnvs();
  });

  it('honours a real value and clamps it to the sidecar range', () => {
    vi.stubEnv('DWG_RENDER_DPI', '600');
    expect(dwgRenderDpi()).toBe(600);
    vi.stubEnv('DWG_RENDER_DPI', '20');
    expect(dwgRenderDpi()).toBe(50);
    vi.stubEnv('DWG_RENDER_DPI', '5000');
    expect(dwgRenderDpi()).toBe(600);
    vi.unstubAllEnvs();
  });
});
