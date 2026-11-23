/**
 * Links on a made-up piping specification (./fixture.ts) and on small
 * made-up files: the two tabs, each rule kind, the piping pack and its
 * switch, the id rules, the coverage lines, idempotence, and the step with
 * an empty file. Pure: no file, no parser.
 */
import { describe, expect, it } from 'vitest';
import { AFTER_CELL_MAX_CHARS, SHAPES } from '../../shapes';
import { bodyCutLine } from '../../tabs-body';
import type { StepJob } from '../../contract';
import type { ParsedSheet } from '../../../sheet-to-grid';
import { bodyOf, specSheets, TEMP_LINES } from './fixture';
import {
  buildLinks,
  codesOfCell,
  linkInputOf,
  LINK_NODES_TAB,
  LINKS_FTS_SKIP,
  LINKS_TAB,
  pageList,
  pageOf,
  pagesOfCell,
} from './links';
import { LINK_PACKS } from './packs';
import { addendumRevision, classOfPage, coverFacts, materialsOf } from './piping-spec';
import { bodyTabsOf, step } from './step';

const SHAPE_TABS = Object.fromEntries(SHAPES['pages-v1'].tabs.map((t) => [t.name, t.columns]));

const built = (sheets: readonly ParsedSheet[]) =>
  buildLinks(linkInputOf(bodyTabsOf(bodyOf(sheets, SHAPE_TABS)).tabs), LINK_PACKS);

type Link = { from: string; to: string; kind: string; page: number | null; source: string };
const linksOf = (sheets: ParsedSheet[]): Link[] =>
  (sheets[0]?.rows ?? []).map(([from, to, kind, page, source]) => ({
    from: String(from),
    to: String(to),
    kind: String(kind),
    page: page as number | null,
    source: String(source),
  }));
const nodesOf = (sheets: ParsedSheet[]) =>
  new Map((sheets[1]?.rows ?? []).map((r) => [String(r[0]), r]));
const pairs = (links: Link[], kind: string) =>
  links.filter((l) => l.kind === kind).map((l) => `${l.from} > ${l.to}`);

const spec = built(specSheets());
const links = linksOf(spec.sheets);
const nodes = nodesOf(spec.sheets);

describe('the two tabs', () => {
  it('are Links and Link nodes, with id columns the writer indexes', () => {
    expect(spec.sheets.map((s) => s.name)).toEqual([LINKS_TAB, LINK_NODES_TAB]);
    expect(spec.sheets[0]!.columns).toEqual([
      { name: 'from_id', type: 'select' },
      { name: 'to_id', type: 'select' },
      { name: 'kind', type: 'select' },
      { name: 'page', type: 'number' },
      { name: 'source', type: 'text' },
    ]);
    expect(spec.sheets[1]!.columns).toEqual([
      { name: 'id', type: 'select' },
      { name: 'kind', type: 'select' },
      { name: 'label', type: 'text' },
      { name: 'page', type: 'number' },
      { name: 'text', type: 'text' },
    ]);
    // Only the label is searched: ids, kinds, sources and row texts are not.
    expect([...LINKS_FTS_SKIP].sort()).toEqual([
      'from_id',
      'id',
      'kind',
      'source',
      'text',
      'to_id',
    ]);
    expect(spec.warnings).toEqual([]);
  });

  it('every link names nodes that are there, and no column is a SQL keyword', () => {
    for (const l of links) {
      expect(nodes.has(l.from), l.from).toBe(true);
      expect(nodes.has(l.to), l.to).toBe(true);
      expect(l.source).toMatch(/^[a-z][a-z ]*: /);
    }
    for (const sheet of spec.sheets) {
      for (const c of sheet.columns) expect(c.name).not.toMatch(/^(from|to|select|order|group)$/i);
    }
  });

  it('the exact set of link kinds of the made-up spec', () => {
    expect([...new Set(links.map((l) => l.kind))].sort()).toEqual([
      'ADDENDUM_CODE',
      'ADDENDUM_MATERIAL',
      'ADDENDUM_PAGE',
      'ADDENDUM_ROW',
      'CHANGES_CLASS',
      'CLASS_CODE',
      'CLASS_MATERIAL',
      'CLASS_PAGE',
      'CLASS_ROW',
      'CLASS_TABLE',
      'HAS_BASE_MATERIAL',
      'HAS_CHANGE',
      'HAS_PAGE',
      'HAS_RATING',
      'HAS_ROW',
      'IN_GROUP',
      'NAMES_CODE',
      'NAMES_LINE',
      'NAMES_MATERIAL',
      'NAMES_TAG',
      'TABLE_ON_PAGE',
    ]);
  });

  it('the same tabs make the same links (a run again replaces, never adds)', () => {
    expect(built(specSheets()).sheets).toEqual(spec.sheets);
  });

  it('a file with no page and no table gives no tab and no error', () => {
    expect(built([]).sheets).toEqual([]);
    expect(
      built([{ name: 'Pages', columns: [{ name: 'Page', type: 'number' }], rows: [] }]).sheets,
    ).toEqual([]);
  });
});

describe('the generic rules', () => {
  it('HAS_PAGE: the file to each page, scans too', () => {
    expect(pairs(links, 'HAS_PAGE')).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((p) => `file > page:${p}`),
    );
  });

  it('TABLE_ON_PAGE: a table to each page it spans', () => {
    expect(pairs(links, 'TABLE_ON_PAGE')).toEqual(
      expect.arrayContaining([
        'table:SPEC K2 ITEMS p2-3 > page:2',
        'table:SPEC K2 ITEMS p2-3 > page:3',
      ]),
    );
    expect(pairs(links, 'TABLE_ON_PAGE')).toHaveLength(6);
  });

  it('HAS_ROW: a table to its rows, with the row page', () => {
    const rows = links.filter((l) => l.kind === 'HAS_ROW');
    expect(rows).toHaveLength(18);
    expect(rows).toContainEqual({
      from: 'table:Table [sizes] (2) p4',
      to: 'row:Table [sizes] (2) p4#2',
      kind: 'HAS_ROW',
      page: 4,
      source: 'row: Table [sizes] (2) p4 #2',
    });
  });

  it('NAMES_CODE: a code column by its header or its cells, and the same codes in any row or page text', () => {
    const codes = pairs(links, 'NAMES_CODE');
    // The header ITEM CODE: a number cell is the code as digits, never 5551234.0.
    expect(codes).toContain('row:SPEC K2 ITEMS p2-3#2 > code:5551234');
    // A trailing star is no part of a code.
    expect(codes).toContain('row:SPEC K2 ITEMS p2-3#5 > code:ZX20002');
    // A headerless column known by its cells.
    expect(codes).toContain('row:Table p5#1 > code:4411223');
    // A known code in a description, and in a page's text.
    expect(codes).toContain('row:SPEC K2 ITEMS p2-3#3 > code:ZX10001');
    expect(codes).toContain('page:3 > code:ZX10001');
    expect(codes).toContain('page:8 > code:ZX10001');
    // Row numbers and sizes are no codes, nor a short note number or a
    // rating a misread row put in the code column.
    expect(codes.filter((c) => /code:(1|2|3|4|80|SCH|QN4|3000)$/.test(c))).toEqual([]);
    expect([...nodes.keys()].filter((id) => /\.0($|#)/.test(id))).toEqual([]);
  });

  it('NAMES_TAG and NAMES_LINE: the cells of a tag or line column, by the tag grammar', () => {
    expect(pairs(links, 'NAMES_TAG')).toEqual([
      'row:Line list p4#1 > tag:FIC-101',
      'row:Line list p4#2 > tag:PT-102',
    ]);
    expect(pairs(links, 'NAMES_LINE')).toEqual([
      'row:Line list p4#1 > line:4"-CW-2001-K2',
      'row:Line list p4#2 > line:6"-CW-2002-K2',
    ]);
  });

  it("NAMES_TAG and NAMES_LINE: a drawing's own Tags and Lines rows", () => {
    const drawing = built([
      {
        name: 'Pages',
        columns: [
          { name: 'Page', type: 'number' },
          { name: 'Kind', type: 'text' },
        ],
        rows: [[1, 'pid']],
      },
      {
        name: 'Tags',
        columns: ['Page', 'Tag', 'Type', 'Region'].map((name) => ({
          name,
          type: name === 'Page' ? ('number' as const) : ('text' as const),
        })),
        rows: [[1, 'LIC-201', 'instrument', null]],
      },
      {
        name: 'Lines',
        columns: [
          { name: 'Page', type: 'number' },
          { name: 'Line number', type: 'text' },
        ],
        rows: [[1, '3-P-1001-B2']],
      },
    ]);
    const l = linksOf(drawing.sheets);
    expect(pairs(l, 'NAMES_TAG')).toEqual(['page:1 > tag:LIC-201']);
    expect(pairs(l, 'NAMES_LINE')).toEqual(['page:1 > line:3-P-1001-B2']);
    expect(drawing.packsOn).toEqual([]);
  });
});

describe('the piping specification pack', () => {
  it('switches itself on by its class headers, and off for a book of no classes', () => {
    expect(spec.packsOn).toEqual(['piping-spec']);
    expect(String(nodes.get('coverage:pack:piping-spec')?.[2])).toMatch(/: on \(3 of its patterns/);
    const plain = built([
      {
        name: 'Pages',
        columns: [
          { name: 'Page', type: 'number' },
          { name: 'Text', type: 'text' },
        ],
        rows: [1, 2, 3, 4].map((p) => [p, `Chapter ${p}\nA plain report page with steel prices.`]),
      },
    ]);
    expect(plain.packsOn).toEqual([]);
    expect(linksOf(plain.sheets).map((l) => l.kind)).toEqual([
      'HAS_PAGE',
      'HAS_PAGE',
      'HAS_PAGE',
      'HAS_PAGE',
    ]);
    expect(String(nodesOf(plain.sheets).get('coverage:pack:piping-spec')?.[2])).toMatch(
      /: off \(0 of/,
    );
  });

  it('CLASS_PAGE: the header (two layouts and no spaces), a page between two of one class, the title box; one title box page alone is dropped', () => {
    expect(pairs(links, 'CLASS_PAGE')).toEqual([
      'class:K2 > page:2',
      'class:K2 > page:3',
      'class:K2 > page:4',
      'class:Q3X > page:5',
      'class:Q1R1 > page:6',
      'class:Q1R1 > page:7',
      'class:K2 > page:8',
    ]);
    expect(links.find((l) => l.to === 'page:3' && l.kind === 'CLASS_PAGE')?.source).toBe(
      'class between: Pages #3',
    );
    expect(nodes.has('class:Z9Z9')).toBe(false);
  });

  it('class rows, tables, codes and materials; a row on an addendum page goes to the addendum', () => {
    expect(pairs(links, 'CLASS_TABLE')).toEqual(
      expect.arrayContaining(['class:K2 > table:SPEC K2 ITEMS p2-3', 'class:Q3X > table:Table p5']),
    );
    expect(pairs(links, 'CLASS_TABLE').some((p) => p.includes('Changes p8'))).toBe(false);
    expect(pairs(links, 'CLASS_ROW')).toContain('class:K2 > row:SPEC K2 ITEMS p2-3#2');
    expect(pairs(links, 'CLASS_CODE')).toEqual(
      expect.arrayContaining([
        'class:K2 > code:5551234',
        'class:K2 > code:ZX10001',
        'class:Q3X > code:4411223',
      ]),
    );
    // The addendum's row: ADDENDUM_*, never CLASS_* (an addendum only changes a class).
    expect(
      links.filter((l) => l.from.startsWith('class:') && l.page === 8 && l.kind !== 'CLASS_PAGE'),
    ).toEqual([]);
    expect(pairs(links, 'ADDENDUM_ROW')).toEqual(['addendum:K2:1 > row:Changes p8#1']);
    expect(pairs(links, 'ADDENDUM_CODE')).toEqual(['addendum:K2:1 > code:ZX10001']);
    expect(pairs(links, 'ADDENDUM_MATERIAL').sort()).toEqual([
      'addendum:K2:1 > mat:A193',
      'addendum:K2:1 > mat:A194',
    ]);
    expect(pairs(links, 'CLASS_MATERIAL')).toEqual(
      expect.arrayContaining([
        'class:K2 > mat:A193',
        'class:K2 > mat:A194',
        'class:K2 > mat:A105',
        'class:Q3X > mat:A193',
      ]),
    );
  });

  it('NAMES_MATERIAL: the specification number, in spaced text and in text with no spaces', () => {
    expect(
      pairs(links, 'NAMES_MATERIAL')
        .filter((p) => p.startsWith('row:Table p5'))
        .sort(),
    ).toEqual([
      'row:Table p5#1 > mat:A193',
      'row:Table p5#1 > mat:A194',
      'row:Table p5#2 > mat:A106',
      'row:Table p5#3 > mat:A234',
      'row:Table p5#4 > mat:A182',
    ]);
  });

  it('IN_GROUP: an item row under a group header row', () => {
    expect(pairs(links, 'IN_GROUP')).toEqual([
      'row:SPEC K2 ITEMS p2-3#2 > group:BOLTING',
      'row:SPEC K2 ITEMS p2-3#3 > group:BOLTING',
      'row:SPEC K2 ITEMS p2-3#5 > group:GASKETS',
      // An item with a name and no code is an item too.
      'row:SPEC K2 ITEMS p2-3#6 > group:GASKETS',
      'row:SPEC K2 ITEMS p2-3#9 > group:GASKETS',
    ]);
  });

  it('IN_GROUP: a table whose title is exactly a group name of the book starts in that group, up to its own header row', () => {
    const withTable = (title: string) => {
      const sheets = specSheets();
      const tab = `${title} p3`;
      sheets.find((s) => s.name === 'Tables')!.rows.push([tab, title, '3', 3]);
      sheets.push({
        name: tab,
        columns: [
          { name: 'Page', type: 'number' },
          { name: 'ITEM NAME', type: 'text' },
          { name: 'ITEM CODE', type: 'text' },
          { name: 'DESCRIPTION', type: 'text' },
        ],
        rows: [
          [3, 'NUT', 'ZX30003', 'HEX NUT A194 GR 2H'],
          [3, null, null, '****GASKETS****'],
          [3, 'RING', 'ZX30004', 'RING JOINT OVAL'],
        ],
      });
      return pairs(linksOf(built(sheets).sheets), 'IN_GROUP').filter((p) => p.includes(tab));
    };
    // Less its numbered lead words and its page mark, the title is BOLTING.
    expect(withTable('12 K2 BOLTING p3')).toEqual([
      'row:12 K2 BOLTING p3 p3#1 > group:BOLTING',
      'row:12 K2 BOLTING p3 p3#3 > group:GASKETS',
    ]);
    // Not exactly a group name: the group before goes on.
    for (const title of ['12 K2 BOLTING NUTS', '12 K2 BOLT', 'MORE BOLTING']) {
      expect(withTable(title)[0]).toBe(`row:${title} p3#1 > group:GASKETS`);
    }
  });

  it('IN_GROUP: a group from a title holds for that table only; the next table with no header row gets no group', () => {
    const sheets = specSheets();
    const index = sheets.find((s) => s.name === 'Tables')!;
    const columns = [
      { name: 'Page', type: 'number' as const },
      { name: 'ITEM NAME', type: 'text' as const },
      { name: 'ITEM CODE', type: 'text' as const },
      { name: 'DESCRIPTION', type: 'text' as const },
    ];
    index.rows.push(['30 K2 BOLTING p3', '30 K2 BOLTING', '3', 1], ['Next p3', null, '3', 1]);
    sheets.push(
      { name: '30 K2 BOLTING p3', columns, rows: [[3, 'NUT', 'ZX30003', 'HEX NUT A194 GR 2H']] },
      { name: 'Next p3', columns, rows: [[3, 'WASHER', 'ZX30005', 'FLAT WASHER CS']] },
    );
    const l = pairs(linksOf(built(sheets).sheets), 'IN_GROUP');
    expect(l).toContain('row:30 K2 BOLTING p3#1 > group:BOLTING');
    expect(l.filter((p) => p.startsWith('row:Next p3'))).toEqual([]);
  });

  it('the class facts: rating, base material, service and limits, the frame of the sheet left out', () => {
    expect(pairs(links, 'HAS_RATING')).toEqual([
      'class:K2 > rating:300',
      'class:Q3X > rating:600',
      'class:Q1R1 > rating:150',
    ]);
    expect(pairs(links, 'HAS_BASE_MATERIAL')).toEqual([
      'class:K2 > basemat:CARBON STEEL',
      'class:Q3X > basemat:KILLED CARBON STEEL',
      'class:Q1R1 > basemat:FULLY KILLED STEEL',
    ]);
    expect(JSON.parse(String(nodes.get('class:K2')?.[4]))).toEqual({
      corr: '0.125',
      rating: '300',
      face: 'RF',
      material: 'CARBON STEEL',
      temp: '-20/400 °F',
      service: 'CAUSTIC',
    });
    expect(JSON.parse(String(nodes.get('class:Q3X')?.[4]))).toMatchObject({
      service: 'STEAM',
      temp: '0/750 °F',
    });
  });

  it('an addendum: its page, its class, its numbered changes, at its current revision', () => {
    expect(pairs(links, 'ADDENDUM_PAGE')).toEqual(['addendum:K2:1 > page:8']);
    expect(pairs(links, 'CHANGES_CLASS')).toEqual(['addendum:K2:1 > class:K2']);
    expect(pairs(links, 'HAS_CHANGE')).toEqual([
      'addendum:K2:1 > change:K2:1:1.1',
      'addendum:K2:1 > change:K2:1:2.1',
    ]);
    expect(nodes.get('change:K2:1:1.1')?.[2]).toBe(
      'Revise upper temperature limit from 400 to 450.',
    );
    expect(nodes.has('addendum:K2:B')).toBe(false);
  });
});

describe('coverage: what the links are and what was not read', () => {
  const cov = (id: string) => String(nodes.get(`coverage:${id}`)?.[2] ?? '');
  it('says what the tabs are, each kind with its count, and the pages with no text', () => {
    expect(cov('links')).toMatch(/^Links holds \d+ links \(from_id, to_id, kind, page, source\)/);
    expect(cov('kind:HAS_PAGE')).toBe('HAS_PAGE: 10 links');
    expect(cov('pages-no-text')).toMatch(/^1 of 10 pages have no text/);
    expect(nodes.get('coverage:pages-no-text')?.[4]).toBe('9');
    expect(cov('pack:piping-spec:classes')).toMatch(
      /^3 classes on 7 pages; 2 pages with text have no class/,
    );
    expect(cov('pack:piping-spec:covers')).toMatch(
      /, temperature limits for 2 \(2 with the unit their line states\)\./,
    );
  });

  it('a page text at the cell cap was cut before the read, and says so', () => {
    const long = built([
      {
        name: 'Pages',
        columns: [
          { name: 'Page', type: 'number' },
          { name: 'Text', type: 'text' },
        ],
        rows: [
          [1, 'x'.repeat(AFTER_CELL_MAX_CHARS)],
          [2, 'short'],
        ],
      },
    ]);
    expect(String(nodesOf(long.sheets).get('coverage:pages-text-cut')?.[2])).toMatch(
      /^1 page texts were cut/,
    );
  });

  it('a body the core cut says so once, with its warnings; a table the body did not hold says so', () => {
    const sheets = specSheets();
    sheets.find((s) => s.name === 'Tables')!.rows.push(['Not in the body p9', null, '9', 4]);
    const body = bodyOf(sheets, SHAPE_TABS) + bodyCutLine(['Only the first 10 pages were read.']);
    const { tabs, cut } = bodyTabsOf(body);
    expect(cut).toEqual(['Only the first 10 pages were read.']);
    const out = nodesOf(buildLinks(linkInputOf(tabs, cut), LINK_PACKS).sheets);
    expect(String(out.get('coverage:input-cut')?.[2])).toMatch(/^The input of Links was cut/);
    expect(out.get('coverage:input-cut')?.[4]).toBe('Only the first 10 pages were read.');
    expect(String(out.get('coverage:tables-not-read')?.[2])).toMatch(/^1 tables named in Tables/);
    expect(out.get('coverage:tables-not-read')?.[4]).toBe('Not in the body p9');
    expect(nodes.has('coverage:input-cut')).toBe(false);
  });

  it('a build past the output cap writes up to it, and the coverage node and the warning say so', () => {
    const out = buildLinks(
      linkInputOf(bodyTabsOf(bodyOf(specSheets(), SHAPE_TABS)).tabs),
      LINK_PACKS,
      { links: 5, nodes: 1_000 },
    );
    expect(out.sheets[0]!.rows).toHaveLength(5);
    expect(String(nodesOf(out.sheets).get('coverage:cut')?.[2])).toBe(
      'A cap was reached (5 links or 1,000 nodes): the rest was not written.',
    );
    expect(out.warnings).toEqual([
      'Links reached a cap (5 links or 1,000 nodes); the rest was not written.',
    ]);
    expect(nodes.has('coverage:cut')).toBe(false);
  });

  it('a node keeps its whole text, and a table spans to its last page within the file', () => {
    const long = `GASKET ${'SPIRAL WOUND '.repeat(60)}`.trim();
    const out = built([
      {
        name: 'Pages',
        columns: [
          { name: 'Page', type: 'number' },
          { name: 'Text', type: 'text' },
        ],
        rows: [1, 2, 3].map((p) => [p, `page ${p}`]),
      },
      {
        name: 'Tables',
        columns: [
          { name: 'Tab', type: 'text' },
          { name: 'Title', type: 'text' },
          { name: 'Pages', type: 'text' },
        ],
        rows: [['Long p1', 'Long', '1-5000']],
      },
      {
        name: 'Long p1',
        columns: [
          { name: 'Page', type: 'number' },
          { name: 'DESCRIPTION', type: 'text' },
        ],
        rows: [[1, long]],
      },
    ]);
    expect(nodesOf(out.sheets).get('row:Long p1#1')?.[4]).toBe(long);
    expect(pairs(linksOf(out.sheets), 'TABLE_ON_PAGE')).toEqual([
      'table:Long p1 > page:1',
      'table:Long p1 > page:2',
      'table:Long p1 > page:3',
    ]);
  });

  it("the Agent's Page text stands in for a page the Reader had no text of", () => {
    const sheets = specSheets();
    sheets.push({
      name: 'Page text',
      columns: [
        { name: 'Key', type: 'text' },
        { name: 'Text', type: 'text' },
      ],
      rows: [['page-9', 'A scanned page that names ZX10001.']],
    });
    const out = built(sheets);
    expect(pairs(linksOf(out.sheets), 'NAMES_CODE')).toContain('page:9 > code:ZX10001');
    expect(nodesOf(out.sheets).has('coverage:pages-no-text')).toBe(false);
  });
});

describe('the small rules', () => {
  it('codesOfCell: no codes from prose; a cell known by its cells takes the strict shape only', () => {
    expect(codesOfCell('5551234', true)).toEqual(['5551234']);
    expect(codesOfCell('QV1234* ZX20002', true)).toEqual(['QV1234', 'ZX20002']);
    expect(codesOfCell('GATE 4411223 00.75 02', true)).toEqual(['4411223']);
    expect(codesOfCell('USE THREADED FLANGES FOR VALVES, SPEC-50-3 QV1234', true)).toEqual([]);
    expect(codesOfCell('4411223 316SS', false)).toEqual(['4411223']);
    expect(codesOfCell('4411223 316SS', true)).toEqual(['4411223', '316SS']);
  });

  it('pageOf: a whole number of 1 or more, never a fraction', () => {
    expect([pageOf(3), pageOf('4'), pageOf(2.5), pageOf(0), pageOf('p4'), pageOf(null)]).toEqual([
      3,
      4,
      null,
      null,
      null,
      null,
    ]);
    expect([
      pagesOfCell('12'),
      pagesOfCell('12-14'),
      pagesOfCell('7 on'),
      pagesOfCell('x'),
    ]).toEqual([{ first: 12, last: 12 }, { first: 12, last: 14 }, { first: 7, last: 7 }, null]);
    expect(pageList([5, 1, 2, 3, 9, 10])).toBe('1-3, 5, 9-10');
  });

  it('materialsOf: the specification number only; the grade stays in the text', () => {
    const m = (s: string) => [...materialsOf(s)].sort();
    expect(m('BOLT SET A193 GR B7 AND A194 GR 2H HEX')).toEqual(['A193', 'A194']);
    expect(m('CAPSCRA193GRB7MW/A194,GR2HMHEX')).toEqual(['A193', 'A194']);
    expect(m('BLIND DISC CL 600 RF FORGED A105 ASME 16.48 SERIES B')).toEqual(['A105']);
    expect(m('PIPE API 5L GR B, A335 P11, A312 TP316L')).toEqual(['A312', 'A335', 'API5L']);
    expect(m('FLANGE Al05')).toEqual(['A105']);
    expect(m('ASME B16.5 B31.3')).toEqual([]);
    expect(m('GATE VALVE, MAKER #A417KX')).toEqual([]);
    expect(m('BENDLRCSTLA234GRWPCPE')).toEqual(['A234']);
  });

  it('classOfPage and addendumRevision on single pages', () => {
    const page = (text: string) => ({ page: 1, text, from: 'Pages', cut: false });
    expect(classOfPage(page('LINE CLASS: K7U ANGLE: 90'))).toEqual({ code: 'K7U', rule: 'header' });
    expect(classOfPage(page('Piping Specification No:\nNOTES'))).toBeNull();
    expect(classOfPage(page('LINE CLASS: All REV'))).toBeNull();
    expect(addendumRevision(page('ADDENDUM\nK2 Revision: 2 Date: x\nSUPERSEDES\nRevision C'))).toBe(
      '2',
    );
    expect(addendumRevision(page('ADDENDUM\nno revision here'))).toBe('?');
    // An older sheet's material line may start with a number; an item line is no material.
    expect(
      coverFacts(page('321 STAINLESS STEEL 600 #RFSF\nFLG WN TAP PAIR 600#RFSF 321SS'), []),
    ).toEqual({
      rating: '600',
      face: 'RF',
      material: '321 STAINLESS STEEL',
    });
    expect(coverFacts(page('FLG WN TAP PAIR 600#RFSF 321SS'), []).material).toBeUndefined();
  });

  it('coverFacts: the temperature limits keep the unit their line states, once, never a guess', () => {
    const page = (text: string) => ({ page: 1, text, from: 'Pages', cut: false });
    for (const [line, temp] of TEMP_LINES) {
      expect([line, coverFacts(page(line), []).temp]).toEqual([line, temp]);
    }
  });
});

describe('the step', () => {
  const job = (body: string) =>
    ({ bytes: async () => Buffer.from(body, 'utf8') }) as unknown as StepJob;
  it('one write of the two tabs, with the search skip list; none for an empty file', async () => {
    const out = await step({ api: 1, step: 1, options: {} }, job(bodyOf(specSheets(), SHAPE_TABS)));
    expect(out.status).toBe('ok');
    expect(out.calls).toHaveLength(1);
    const input = (out.calls![0] as { input: { tabs: ParsedSheet[]; ftsSkipColumns: string[] } })
      .input;
    expect(input.tabs.map((t) => t.name)).toEqual([LINKS_TAB, LINK_NODES_TAB]);
    expect(input.ftsSkipColumns).toEqual(LINKS_FTS_SKIP);
    expect(out.counts).toMatchObject({ links: links.length, packs: 1 });
    const empty = await step({ api: 1, step: 1, options: {} }, job(''));
    expect(empty).toMatchObject({ status: 'ok', calls: [] });
  });
});
