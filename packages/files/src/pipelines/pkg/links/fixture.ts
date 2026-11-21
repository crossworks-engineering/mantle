/**
 * A made-up piping material specification, as the PDF book reader would
 * write it into a file database: the tabs Pages, Tables, File and one tab a
 * table. All names, codes and texts are invented for the tests: two class
 * sheet layouts (a modern sheet and an older title box sheet), a sheet with
 * no spaces, a table with a code column and group header rows, a headerless
 * table whose codes are known by their cells, a line list, an addendum, a
 * page of notes and a scanned page with no text.
 */
import type { ParsedSheet } from '../../../sheet-to-grid';

const FRAME = ['SAMPLE PIPING MATERIALS SPECIFICATION', 'Springfield, Ohio'] as const;

/** The page texts, by page. */
export const SPEC_PAGES: Record<number, string> = {
  1: [
    'GENERAL NOTES',
    'NOTE 4: Gaskets are per the gasket table.',
    'For sizes see Table 2. For branches see page 3.',
    'See Table 9 and see note 8: neither is in this book.',
  ].join('\n'),
  2: [
    FRAME[0],
    'K2',
    'Piping Specification No:',
    'ACME WORKS SERVICE DESCRIPTION:',
    `${FRAME[1]} CAUSTIC`,
    'PRESSURE LIMITS (PSIG): 700 ASME B16.5 MATERIAL CORR. ALLOW RATING FACE',
    'TEMPERATURE LIMITS (°F): -20 / 400 ASME B31.3 CARBON STEEL 0.125 300 RF',
    'Material: CARBON STEEL Paint: NO MARKING',
  ].join('\n'),
  3: ['ITEMS CONTINUED', 'ZX10001 is the stud bolt of this class.'].join('\n'),
  4: [
    FRAME[0],
    'K2',
    'Piping Specification No:',
    FRAME[1],
    'LINE LIST AND TAGS',
    'For the bolts see note 4.',
  ].join('\n'),
  5: [
    'PipingSpecificationNo: Q3X',
    FRAME[1],
    'SERVICE: STEAM',
    'TEMPERATURE LIMITS (°F): 0 / 750',
    'ASME B31.3 KILLED CARBON STEEL 0.063 600 RF',
  ].join('\n'),
  6: [
    `${FRAME[1].toUpperCase()} HYDROCARBON CORR`,
    'GENERAL SERVICE CONSTRUCTION ALLOW DATE BY REV PA CLASS',
    'DESIGN: ANSI B16.5',
    '2" & SMALLER - SOCKETWELD 0.125 0 3 Q1Rl',
    'KILLED CARBON STEEL 150 #RFSF',
    'FLG WN ORI SET 150#RFSF 304SS',
    FRAME[1],
  ].join('\n'),
  7: [
    `${FRAME[1].toUpperCase()} HYDROCARBON CORR`,
    'GENERAL SERVICE CONSTRUCTION ALLOW DATE BY REV PA CLASS',
    '2" & SMALLER - SOCKETWELD 0.125 0 3 Q1R1',
    FRAME[1],
  ].join('\n'),
  8: [
    'ACME WORKS ADDENDUM Page',
    '1 of 1',
    'TO',
    'PIPING SPECIFICATION',
    `${FRAME[1]} K2 Revision :1 Date: 01/02/20`,
    'SUPERSEDES',
    'Revision B Date: 12/01/19',
    '1.1 Revise upper temperature limit from 400 to 450.',
    '2.1 Add item ZX10001 for the bolting.',
  ].join('\n'),
  9: '',
  10: ['SAMPLE NOTES', 'A one-off mention: TITLE BOX REV PA CLASS', '0.250 0 1 Z9Z9'].join('\n'),
};

const text = (name: string) => ({ name, type: 'text' as const });
const num = (name: string) => ({ name, type: 'number' as const });

/** The table tabs, by tab name, with their Tables row (title, pages). */
export const SPEC_TABLES: { sheet: ParsedSheet; title: string; pages: string }[] = [
  {
    title: 'SPEC K2 ITEMS',
    pages: '2-3',
    sheet: {
      name: 'SPEC K2 ITEMS p2-3',
      columns: [
        num('Page'),
        text('SEQ. NO'),
        text('ITEM NAME'),
        num('ITEM CODE'),
        text('DESCRIPTION'),
      ],
      rows: [
        [2, null, null, null, '*****BOLTING*****'],
        [2, '1', 'BOLS', 5551234, 'STUD-BOLT A193 GR B7 W/A194 GR 2H NUTS'],
        [2, '2', 'CAPS', null, 'CAP SCREW A193 GR B7, ITEM ZX10001'],
        [3, null, null, null, '*****GASKETS*****'],
        [3, '3', 'GSKT', 'ZX20002*', 'GASKET SPIRAL WOUND 316 SS CL 300'],
        [3, '5', 'GSKS', null, 'GASKET SPECIAL, SEE SPECIALTY ITEM LIST'],
        [3, null, null, 'QN4', 'NIPPLE NOTE, RATING 3000'],
        [3, null, null, '3000', 'STUD-BOLT ASTM A193 GRADE B8M'],
        [3, '4', 'FLG', 'ZX10001', 'FLANGE WN CL 300 RF STL A105'],
      ],
    },
  },
  {
    title: 'Table 2 Sizes',
    pages: '4',
    sheet: {
      name: 'Table [sizes] (2) p4',
      columns: [num('Page'), text('Size'), text('Schedule')],
      rows: [
        [4, '2', 'SCH 80'],
        [4, '4', 'SCH 40'],
      ],
    },
  },
  {
    title: '',
    pages: '4',
    sheet: {
      name: 'Line list p4',
      columns: [num('Page'), text('Line No'), text('Tag')],
      rows: [
        [4, '4"-CW-2001-K2', 'FIC-101'],
        [4, '6"-CW-2002-K2', 'PT-102'],
      ],
    },
  },
  {
    title: '',
    pages: '5',
    sheet: {
      name: 'Table p5',
      columns: [num('Page'), text('Column 1'), text('Column 2'), text('Column 3')],
      rows: [
        [5, '1', '4411223', 'BOLTA193GRB7MW/A194GR2HMNUT'],
        [5, '2', '4411224', 'PIPE SMLS A106-B SCH 160'],
        [5, '3', '4411225', 'ELBOW A234 GR WPB'],
        [5, '4', '4411226', 'FLANGE A182F22CL3'],
      ],
    },
  },
  {
    title: 'Addendum changes',
    pages: '8',
    sheet: {
      name: 'Changes p8',
      columns: [num('Page'), text('ITEM CODE'), text('DESCRIPTION')],
      rows: [[8, 'ZX10001', 'STUD-BOLT A193 GR B7M W/A194 GR 2HM NUTS']],
    },
  },
];

/** The Reader's tabs of the made-up spec. */
export function specSheets(): ParsedSheet[] {
  const pages = Object.keys(SPEC_PAGES)
    .map(Number)
    .sort((a, b) => a - b);
  return [
    {
      name: 'Pages',
      columns: [num('Page'), text('Method'), text('Why'), text('Text')],
      rows: pages.map((p) => [
        p,
        SPEC_PAGES[p] === '' ? 'vision' : 'text',
        SPEC_PAGES[p] === '' ? 'scan' : null,
        SPEC_PAGES[p] || null,
      ]),
    },
    {
      name: 'Tables',
      columns: [text('Tab'), text('Title'), text('Pages'), num('Rows')],
      rows: SPEC_TABLES.map((t) => [t.sheet.name, t.title || null, t.pages, t.sheet.rows.length]),
    },
    {
      name: 'File',
      columns: [text('Kind'), text('Rules kind'), num('Rules version'), num('Pages')],
      rows: [['book', 'book', 5, pages.length]],
    },
    ...SPEC_TABLES.map((t) => t.sheet),
  ];
}

/** The body the core writes from these tabs for the shape pages-v1
 *  (afterBodyOf): the shape's tabs with its columns, then each listed tab
 *  with all its columns. */
export function bodyOf(
  sheets: readonly ParsedSheet[],
  shapeTabs: Record<string, readonly string[]>,
): string {
  const lines: string[] = [];
  const byName = new Map(sheets.map((s) => [s.name, s]));
  const put = (sheet: ParsedSheet, columns: readonly string[]) => {
    lines.push(JSON.stringify({ tab: sheet.name, columns }));
    const at = columns.map((c) => sheet.columns.findIndex((x) => x.name === c));
    for (const r of sheet.rows)
      lines.push(JSON.stringify(at.map((i) => (i >= 0 ? (r[i] ?? null) : null))));
  };
  for (const [name, columns] of Object.entries(shapeTabs)) {
    const sheet = byName.get(name);
    if (sheet) put(sheet, columns);
  }
  const index = byName.get('Tables');
  for (const r of index?.rows ?? []) {
    const sheet = byName.get(String(r[0]));
    if (sheet)
      put(
        sheet,
        sheet.columns.map((c) => c.name),
      );
  }
  return `${lines.join('\n')}\n`;
}
