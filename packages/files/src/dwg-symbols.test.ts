/**
 * A drawing's symbols in its database: the Symbols and Placements tabs from
 * the CAD tier's reply (cad/dwg_symbols.py), what the description says of
 * them, and the guard of `dwg-reindex --symbols`. The reply is made up: no
 * drawing's bytes, no client data.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cadRegistryWorkbook, parseDwgToGrids, symbolsReading } from './dwg';

/** A header-only DWG; each test its own seed, as the render memo is keyed by
 *  the bytes. */
function dwgFixture(seed: number): Buffer {
  return Buffer.concat([Buffer.from('AC1032', 'latin1'), Buffer.from([seed]), Buffer.alloc(63)]);
}

const SVG =
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000000 500000"/>';

function reply(extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    converter: 'ezdwg',
    version: 'AC1032',
    entities: 5,
    capped: false,
    layers: [{ name: 'VALVES', count: 5 }],
    texts: [],
    counts: { INSERT: 3 },
    render_error: null,
    png_base64: '',
    symbols: [
      {
        key: 'aaaaaaaaaaaaaaaa',
        shape: 'ssssssssssssssss',
        name: 'GATE',
        kind: 'symbol',
        svg: SVG,
        x0: -2,
        y0: -1,
        width: 4,
        height: 2,
        hidden: true,
        tags: ['TAG'],
        placements: 2,
      },
      {
        key: 'bbbbbbbbbbbbbbbb',
        shape: 'tttttttttttttttt',
        name: 'LINENO',
        kind: 'label',
        svg: null,
        x0: null,
        y0: null,
        width: null,
        height: null,
        tags: ['LINENO'],
        placements: 1,
      },
    ],
    placements: [
      {
        key: 'aaaaaaaaaaaaaaaa',
        x: 10,
        y: 20,
        rotation: 90,
        xscale: 1,
        yscale: 1,
        layer: 'VALVES',
        handle: '1A',
        tags: { TAG: 'V-101' },
      },
      {
        key: 'aaaaaaaaaaaaaaaa',
        x: 30,
        y: 20,
        rotation: 0,
        xscale: -1,
        yscale: 1,
        layer: 'VALVES',
        handle: '1B',
        tags: {},
      },
      {
        key: 'bbbbbbbbbbbbbbbb',
        x: 0,
        y: 40,
        rotation: 0,
        xscale: 1,
        yscale: 1,
        layer: 'TEXT',
        handle: '1C',
        // An own key named __proto__, as a parsed reply can hold.
        tags: JSON.parse('{"LINENO":"4-P-101","__proto__":"x"}') as Record<string, string>,
      },
    ],
    placements_capped: false,
    symbol_facts: {
      inserts: 4,
      unkeyed: 1,
      symbols: 2,
      drawn: 1,
      labels: 1,
      draw_errors: 0,
      not_drawn: { too_large: 0, total_cap: 0, time: 0 },
      svg_bytes: SVG.length,
    },
    symbols_error: null,
    ...extra,
  };
}

function stubParser(body: Record<string, unknown>) {
  vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
  vi.stubEnv('PARSER_TOKEN', 'secret');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(body)),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('the Symbols and Placements tabs', () => {
  it('holds one row per symbol and one per placement, tags as JSON', async () => {
    stubParser(reply());
    const grids = await parseDwgToGrids(dwgFixture(201));
    const symbols = grids.sheets.find((s) => s.name === 'Symbols')!;
    const placements = grids.sheets.find((s) => s.name === 'Placements')!;
    expect(symbols.columns.map((c) => c.name)).toEqual([
      'Key',
      'Shape',
      'Name',
      'Kind',
      'SVG',
      'X0',
      'Y0',
      'Width',
      'Height',
      'Hidden',
      'Tags',
      'Placements',
    ]);
    expect(symbols.rows).toEqual([
      [
        'aaaaaaaaaaaaaaaa',
        'ssssssssssssssss',
        'GATE',
        'symbol',
        SVG,
        -2,
        -1,
        4,
        2,
        1,
        '["TAG"]',
        2,
      ],
      [
        'bbbbbbbbbbbbbbbb',
        'tttttttttttttttt',
        'LINENO',
        'label',
        null,
        null,
        null,
        null,
        null,
        0,
        '["LINENO"]',
        1,
      ],
    ]);
    expect(placements.rows).toHaveLength(3);
    expect(placements.rows[1]).toEqual([
      'aaaaaaaaaaaaaaaa',
      30,
      20,
      0,
      -1,
      1,
      'VALVES',
      '1B',
      '{}',
    ]);
    // A tag named __proto__ is just a tag.
    expect(placements.rows[2]![8]).toBe('{"LINENO":"4-P-101","__proto__":"x"}');
    expect(grids.symbols?.facts?.unkeyed).toBe(1);
  });

  it('says in the description how to place an SVG and what has no row', async () => {
    stubParser(reply());
    const { description } = await cadRegistryWorkbook(dwgFixture(202), 'dwg');
    expect(description).toContain('Symbols has one row per block shape');
    expect(description).toContain('viewBox (0 0 W H) maps to the box X0 Y0 Width Height');
    expect(description).toContain('Placements has one row per model-space INSERT');
    expect(description).toContain(
      '1 INSERTs of an empty or missing block have no row in either tab.',
    );
    expect(description).not.toContain('SVG is empty where');
    expect(description).not.toContain('TRUNCATED');
  });

  it('says TRUNCATED and the caps when the CAD tier cut', async () => {
    stubParser(
      reply({
        placements_capped: true,
        symbol_facts: {
          inserts: 3,
          unkeyed: 0,
          symbols: 2,
          drawn: 0,
          labels: 1,
          draw_errors: 1,
          not_drawn: { too_large: 0, total_cap: 0, time: 3 },
          svg_bytes: 0,
        },
      }),
    );
    const { description } = await cadRegistryWorkbook(dwgFixture(203), 'dwg');
    expect(description).toContain('1 failed to draw, 3 not drawn at a cap');
    expect(description?.match(/TRUNCATED/g)).toHaveLength(1);
  });

  it('has no symbols tabs from an image before the symbols pass', async () => {
    const old: Record<string, unknown> = reply();
    for (const k of Object.keys(old)) {
      if (k.startsWith('symbol') || k.startsWith('placements')) delete old[k];
    }
    stubParser(old);
    const grids = await parseDwgToGrids(dwgFixture(204));
    expect(grids.sheets.map((s) => s.name)).not.toContain('Symbols');
    expect(grids.symbols).toBeUndefined();
  });

  it('leaves them out for a Table', async () => {
    stubParser(reply());
    const { grids, description } = await cadRegistryWorkbook(dwgFixture(207), 'dwg', {
      symbols: false,
    });
    expect(grids.sheets.map((s) => s.name)).not.toContain('Symbols');
    expect(grids.sheets.map((s) => s.name)).not.toContain('Placements');
    expect(description).not.toContain('Symbols');
  });

  it('says why when the symbols pass failed', async () => {
    stubParser(
      reply({ symbols: [], placements: [], symbol_facts: null, symbols_error: 'ValueError: x' }),
    );
    const { grids, description } = await cadRegistryWorkbook(dwgFixture(205), 'dwg');
    expect(grids.sheets.map((s) => s.name)).not.toContain('Symbols');
    expect(description).toContain('The symbols pass failed (ValueError: x)');
  });

  it('drops an SVG past its cap and a row with no key', async () => {
    const big = reply();
    (big.symbols as Record<string, unknown>[])[0]!.svg = 'x'.repeat(256 * 1024 + 1);
    (big.placements as Record<string, unknown>[]).push({ x: 1, y: 1 });
    stubParser(big);
    const grids = await parseDwgToGrids(dwgFixture(206));
    expect(grids.sheets.find((s) => s.name === 'Symbols')!.rows[0]![4]).toBeNull();
    expect(grids.sheets.find((s) => s.name === 'Placements')!.rows).toHaveLength(3);
  });
});

describe('symbolsReading, the guard of dwg-reindex --symbols', () => {
  it('reads data when the reply has symbols, even none', async () => {
    stubParser(reply());
    expect(await symbolsReading(dwgFixture(210), 'dwg')).toBe('data');
    stubParser(reply({ symbols: [], placements: [] }));
    expect(await symbolsReading(dwgFixture(211), 'dwg')).toBe('data');
  });

  it('reads old-reader when the reply has no symbols', async () => {
    const old: Record<string, unknown> = reply();
    delete old.symbols;
    stubParser(old);
    expect(await symbolsReading(dwgFixture(212), 'dwg')).toBe('old-reader');
  });

  it('reads not-cad with no parser call when the bytes are not the format', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await symbolsReading(Buffer.from('not a drawing'), 'dwg')).toBe('not-cad');
    expect(await symbolsReading(dwgFixture(213), 'dgn')).toBe('not-cad');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the Shapes tab', () => {
  const circle = {
    kind: 'CIRCLE',
    layer: 'EQUIP',
    handle: '2A',
    path: 'M12 10C12 11 11 12 10 12',
    minx: 8,
    miny: 8,
    maxx: 12,
    maxy: 12,
  };

  it('holds one row per shape, with its path and box, beside the symbols', async () => {
    stubParser(
      reply({
        shapes: [
          circle,
          // Not a path the CAD tier writes, or no box: no row.
          { ...circle, handle: '2B', path: 'M0 0" onload="x' },
          { ...circle, handle: '2C', minx: null },
        ],
        shapes_capped: false,
      }),
    );
    const { grids, description } = await cadRegistryWorkbook(dwgFixture(220), 'dwg');
    const shapes = grids.sheets.find((s) => s.name === 'Shapes')!;
    expect(shapes.columns.map((c) => c.name)).toEqual([
      'Kind',
      'Layer',
      'Handle',
      'Path',
      'Min X',
      'Min Y',
      'Max X',
      'Max Y',
    ]);
    expect(shapes.rows).toEqual([
      ['CIRCLE', 'EQUIP', '2A', 'M12 10C12 11 11 12 10 12', 8, 8, 12, 12],
    ]);
    expect(description).toContain('Shapes has one row per model-space CIRCLE');
    expect(description).not.toContain('Max Y (TRUNCATED');
  });

  it('says TRUNCATED when the CAD tier cut, and a Table gets none', async () => {
    stubParser(reply({ shapes: [circle], shapes_capped: true }));
    const { description } = await cadRegistryWorkbook(dwgFixture(221), 'dwg');
    expect(description).toContain('Min X Min Y Max X Max Y (TRUNCATED');
    stubParser(reply({ shapes: [circle], shapes_capped: false }));
    const table = await cadRegistryWorkbook(dwgFixture(222), 'dwg', { symbols: false });
    expect(table.grids.sheets.map((s) => s.name)).not.toContain('Shapes');
  });

  it('a reply from before the shapes gives no tab', async () => {
    stubParser(reply());
    const grids = await parseDwgToGrids(dwgFixture(223));
    expect(grids.sheets.map((s) => s.name)).not.toContain('Shapes');
  });
});
