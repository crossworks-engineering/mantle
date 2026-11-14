/**
 * Site tags on made-up texts: a CAD drawing's Texts rows (Text, Layer, X,
 * Y) and a PDF drawing's (Page, Text); the profile; and the bounds: the row
 * cap, the cut of one long text, and the cap of characters of one run.
 * The timing lines say what one run costs on the largest made-up tabs.
 */
import { describe, expect, it } from 'vitest';
import {
  SITE_TAGS_CHARS_MAX,
  SITE_TAGS_ROWS_MAX,
  SITE_TAGS_TAB,
  SITE_TAGS_TEXT_MAX_CHARS,
  siteProfileOf,
  siteTagsBuilder,
  siteTagsSheet,
} from './site-tags';

const NONE = siteProfileOf({});
const col = (sheet: { columns: { name: string }[] }, name: string) =>
  sheet.columns.findIndex((c) => c.name === name);

describe('siteTagsSheet', () => {
  it('reads made-up CAD texts: one row a tag, with its layer and place', () => {
    const { sheet, warnings } = siteTagsSheet(
      [
        { Text: 'FIC-101', Layer: 'INSTR', X: 10, Y: 20 },
        { Text: '4"-P-1001-A1A', Layer: 'PIPE', X: 11, Y: 21 },
        { Text: 'PUMP P-12A/B', Layer: 'EQUIP', X: 12, Y: 22 },
        { Text: 'NOTE 3: SEE DWG 12', Layer: 'NOTES', X: 0, Y: 0 },
        { Text: null, Layer: 'EMPTY' },
      ],
      NONE,
    );
    expect(warnings).toEqual([]);
    expect(sheet.name).toBe(SITE_TAGS_TAB);
    expect(sheet.columns.map((c) => c.name)).toEqual([
      'Tag',
      'Key',
      'Raw',
      'Type',
      'Unit',
      'Letters',
      'Number',
      'Page',
      'Layer',
      'X',
      'Y',
    ]);
    expect(sheet.rows).toEqual([
      ['FIC-101', 'FIC101', 'FIC-101', 'instrument', '', 'FIC', '101', null, 'INSTR', 10, 20],
      [
        '4"-P-1001-A1A',
        '4P1001A1A',
        '4"-P-1001-A1A',
        'line',
        '',
        'P',
        '1001',
        null,
        'PIPE',
        11,
        21,
      ],
      ['P-12A', 'P12A', 'P-12A/B', 'equipment', '', 'P', '12A', null, 'EQUIP', 12, 22],
      ['P-12B', 'P12B', 'P-12A/B', 'equipment', '', 'P', '12B', null, 'EQUIP', 12, 22],
    ]);
  });

  it('reads made-up PDF texts: the page, no layer, no place', () => {
    const { sheet } = siteTagsSheet(
      [
        { Text: 'TO 40-PSV-0012 AND EA-101', Page: 2 },
        { Text: 'P-1001-A1A', Page: 3 },
      ],
      NONE,
    );
    const at = (n: string) => col(sheet, n);
    expect(
      sheet.rows.map((r) => [r[at('Tag')], r[at('Type')], r[at('Page')], r[at('Layer')]]),
    ).toEqual([
      ['40-PSV-0012', 'instrument', 2, null],
      ['EA-101', 'instrument', 2, null],
      ['P-1001-A1A', 'equipment', 3, null],
    ]);
  });

  it('the profile from the options mends the two known wrongs', () => {
    const profile = siteProfileOf({ equipment_types: ['EA'], line_services: ['P'] });
    const { sheet } = siteTagsSheet([{ Text: 'EA-101 P-1001-A1A', Page: 1 }], profile);
    const at = (n: string) => col(sheet, n);
    expect(sheet.rows.map((r) => [r[at('Tag')], r[at('Type')]])).toEqual([
      ['EA-101', 'equipment'],
      ['P-1001-A1A', 'line'],
    ]);
  });

  it('a stored option that is not a word list reads as none', () => {
    expect(siteProfileOf({ not_tags: 'P', equipment_types: [1, 'EA', null] })).toEqual({
      equipmentTypes: ['EA'],
      instrumentCodes: [],
      notTags: [],
      lineServices: [],
    });
  });

  it('cuts the rows at the cap, with a warning', () => {
    const many = Array.from({ length: SITE_TAGS_ROWS_MAX + 10 }, (_, i) => ({
      Text: `FIC-${100 + (i % 9000)}`,
    }));
    const { sheet, warnings } = siteTagsSheet(many, NONE);
    expect(sheet.rows).toHaveLength(SITE_TAGS_ROWS_MAX);
    expect(warnings).toEqual([`More than 100,000 tags; the rows were cut there.`]);
  });

  it('cuts one long text, so a megabyte cell costs one cut text', () => {
    const long = `FIC-101 ${'X'.repeat(1_000_000)} FIC-102`;
    const started = performance.now();
    const { sheet, warnings } = siteTagsSheet([{ Text: long }], NONE);
    const ms = performance.now() - started;
    expect(sheet.rows.map((r) => r[0])).toEqual(['FIC-101']);
    expect(warnings).toEqual([]);
    expect(ms).toBeLessThan(2_000);
    console.log(`[site-tags timing] one text of 1 MB: ${ms.toFixed(1)} ms`);
    expect(SITE_TAGS_TEXT_MAX_CHARS).toBe(4_096);
  });

  it('stops at the cap of characters of one run, with a warning', () => {
    const builder = siteTagsBuilder(NONE);
    const text = 'A'.repeat(SITE_TAGS_TEXT_MAX_CHARS);
    let rows = 0;
    while (builder.add({ Text: text })) rows += 1;
    expect(rows).toBe(Math.floor(SITE_TAGS_CHARS_MAX / SITE_TAGS_TEXT_MAX_CHARS));
    expect(builder.add({ Text: 'FIC-101' })).toBe(false);
    expect(builder.done().warnings).toEqual([
      'The texts hold more than 16,000,000 characters; the rest was not read.',
    ]);
  });

  it('timing: the largest made-up tabs one run can meet', () => {
    // 500,000 short texts (the most rows read), a tag in each tenth.
    const short = Array.from({ length: 500_000 }, (_, i) =>
      i % 10 === 0
        ? { Text: `40-PT-${1000 + (i % 8000)}`, Layer: 'L', X: i, Y: i }
        : { Text: `NOTE ${i}` },
    );
    let started = performance.now();
    const a = siteTagsSheet(short, NONE);
    const shortMs = performance.now() - started;

    // Texts that fill the cap of characters: a tag-like token every few
    // characters, the worst case for the grammar.
    const dense =
      `${'P-1A/B FIC-101 4"-P-1001-A1A E-1/2 '.repeat(Math.ceil(SITE_TAGS_TEXT_MAX_CHARS / 36))}`.slice(
        0,
        SITE_TAGS_TEXT_MAX_CHARS,
      );
    const full = Array.from(
      { length: Math.ceil(SITE_TAGS_CHARS_MAX / SITE_TAGS_TEXT_MAX_CHARS) + 1 },
      () => ({ Text: dense }),
    );
    started = performance.now();
    const b = siteTagsSheet(full, siteProfileOf({ equipment_types: ['EA'], line_services: ['P'] }));
    const denseMs = performance.now() - started;

    // Texts up to the cap of characters with no tag: every token goes
    // through every trial of the grammar and the list split, and fails.
    const misses = 'NOTE-AB12/CD 15-JAN-2026 X-Y-Z-1-2-3-4-5 1-1/2"-QQ-12 '
      .repeat(Math.ceil(SITE_TAGS_TEXT_MAX_CHARS / 50))
      .slice(0, SITE_TAGS_TEXT_MAX_CHARS);
    started = performance.now();
    const c = siteTagsSheet(
      Array.from({ length: Math.ceil(SITE_TAGS_CHARS_MAX / SITE_TAGS_TEXT_MAX_CHARS) + 1 }, () => ({
        Text: misses,
      })),
      siteProfileOf({ equipment_types: ['EA'], line_services: ['P'], not_tags: ['NOTE'] }),
    );
    const missMs = performance.now() - started;
    console.log(
      `[site-tags timing] 16,000,000 characters with no tag: ${missMs.toFixed(0)} ms, ${c.sheet.rows.length} rows, warnings: ${c.warnings.join(' | ')}`,
    );
    expect(c.warnings).toHaveLength(1);
    console.log(
      `[site-tags timing] 500,000 short texts: ${shortMs.toFixed(0)} ms, ${a.sheet.rows.length} rows; ` +
        `texts up to the cap of characters, dense with tags: ${denseMs.toFixed(0)} ms, ` +
        `${b.sheet.rows.length} rows, warnings: ${b.warnings.join(' | ')}`,
    );
    expect(a.sheet.rows.length).toBe(50_000);
    expect(b.sheet.rows).toHaveLength(SITE_TAGS_ROWS_MAX);
    // A generous bound: the point is that it ends, on any box.
    expect(shortMs + denseMs + missMs).toBeLessThan(60_000);
  });
});
