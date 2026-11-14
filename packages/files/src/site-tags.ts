/**
 * Site tags: the tags of a drawing's `Texts` tab, by the tag grammar
 * (./pdf-tags.ts) with a site's profile. Pure: strings in, one sheet out.
 * The `after` pipeline `site-tags` (./pipelines/builtin.ts) runs it on the
 * rows of the `Texts` tab of a file's database, never on the file itself
 * (docs/pipelines.md, "Site tags").
 *
 * A file is outside input, so every loop here is bounded:
 *  - a text is cut at SITE_TAGS_TEXT_MAX_CHARS before it is read;
 *  - the texts of one run hold at most SITE_TAGS_CHARS_MAX characters in
 *    all; past it the rest is not read, and a warning says so;
 *  - the tab holds at most SITE_TAGS_ROWS_MAX rows; past it the rows are
 *    cut, and a warning says so.
 * The grammar has no pattern from a profile: a word is looked up in a set.
 */
import type { ParsedSheet } from './sheet-to-grid';
import {
  parseEquipmentTag,
  parseInstrumentTag,
  parseLineNumber,
  tagKey,
  tokenItems,
  tokensOf,
  type SiteProfile,
} from './pdf-tags';

/** The name of the tab Site tags writes. */
export const SITE_TAGS_TAB = 'Site tags';
/** The most rows the tab holds. */
export const SITE_TAGS_ROWS_MAX = 100_000;
/** The longest text read: a drawing's text is a label or a note line, and
 *  a longer cell is cut. */
export const SITE_TAGS_TEXT_MAX_CHARS = 4_096;
/** The most characters one run reads, all texts together. */
export const SITE_TAGS_CHARS_MAX = 16_000_000;

/** One row of the `Texts` tab: Text, and Page, Layer, X and Y when the tab
 *  has columns of these names. */
export type TextRow = {
  Text: unknown;
  Page?: unknown;
  Layer?: unknown;
  X?: unknown;
  Y?: unknown;
};

const COLUMNS: ParsedSheet['columns'] = [
  { name: 'Tag', type: 'text' },
  { name: 'Key', type: 'text' },
  { name: 'Raw', type: 'text' },
  { name: 'Type', type: 'text' },
  { name: 'Unit', type: 'text' },
  { name: 'Letters', type: 'text' },
  { name: 'Number', type: 'text' },
  { name: 'Page', type: 'number' },
  { name: 'Layer', type: 'text' },
  { name: 'X', type: 'number' },
  { name: 'Y', type: 'number' },
];

type Cell = string | number | boolean | null;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The kind of one token and its tag rows (tag, unit, letters, number):
 *  no rows when it is no tag. */
function rowsOfToken(
  token: string,
  profile: SiteProfile,
): { kind: string; rows: [string, string, string, string][] } {
  const read = tokenItems(token, profile);
  if (!read) return { kind: '', rows: [] };
  const rows = read.items.flatMap((item): [string, string, string, string][] => {
    if (read.kind === 'instrument') {
      const t = parseInstrumentTag(item, profile);
      return t ? [[t.tag, t.prefix, t.isa.code, t.loop]] : [];
    }
    if (read.kind === 'line') {
      const l = parseLineNumber(item, profile);
      // The letters of a line: its first part that is letters only (a
      // service), or ''.
      const letters = l?.line.split('-').find((p) => /^[A-Z]+$/.test(p)) ?? '';
      return l ? [[l.line, '', letters, l.serial]] : [];
    }
    const e = parseEquipmentTag(item, profile);
    return e ? [[e.tag, e.unit, e.type, e.sub ? `${e.number}-${e.sub}` : e.number]] : [];
  });
  return { kind: read.kind, rows };
}

/**
 * The builder of one run: `add` reads one text row and says whether to go
 * on (false once a bound is reached), `sheet` gives the tab and the
 * warnings. One builder for a stream of rows, so a caller holds one page
 * of `Texts` at a time.
 */
export function siteTagsBuilder(profile: SiteProfile): {
  add: (row: TextRow) => boolean;
  done: () => { sheet: ParsedSheet; warnings: string[] };
} {
  const rows: Cell[][] = [];
  const warnings: string[] = [];
  let chars = 0;
  let cut = false;
  return {
    add(row) {
      if (cut) return false;
      const raw = text(row.Text);
      if (raw === null || raw === '') return true;
      const value =
        raw.length > SITE_TAGS_TEXT_MAX_CHARS ? raw.slice(0, SITE_TAGS_TEXT_MAX_CHARS) : raw;
      chars += value.length;
      if (chars > SITE_TAGS_CHARS_MAX) {
        cut = true;
        warnings.push(
          `The texts hold more than ${SITE_TAGS_CHARS_MAX.toLocaleString('en')} characters; the rest was not read.`,
        );
        return false;
      }
      for (const token of tokensOf(value)) {
        const { kind, rows: found } = rowsOfToken(token, profile);
        for (const [tag, unit, letters, number] of found) {
          if (rows.length >= SITE_TAGS_ROWS_MAX) {
            cut = true;
            warnings.push(
              `More than ${SITE_TAGS_ROWS_MAX.toLocaleString('en')} tags; the rows were cut there.`,
            );
            return false;
          }
          rows.push([
            tag,
            tagKey(tag),
            token,
            kind,
            unit,
            letters,
            number,
            num(row.Page),
            text(row.Layer),
            num(row.X),
            num(row.Y),
          ]);
        }
      }
      return true;
    },
    done: () => ({ sheet: { name: SITE_TAGS_TAB, columns: COLUMNS, rows }, warnings }),
  };
}

/** Site tags of a list of text rows, in one call (a test, a small tab). */
export function siteTagsSheet(
  texts: readonly TextRow[],
  profile: SiteProfile,
): { sheet: ParsedSheet; warnings: string[] } {
  const b = siteTagsBuilder(profile);
  for (const row of texts) if (!b.add(row)) break;
  return b.done();
}

const wordsOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((w): w is string => typeof w === 'string') : [];

/** The profile of the options in force of `site-tags` (effectiveOptions
 *  gives them checked; a value that is not a list of words reads as none). */
export function siteProfileOf(options: Readonly<Record<string, unknown>>): SiteProfile {
  return {
    equipmentTypes: wordsOf(options.equipment_types),
    instrumentCodes: wordsOf(options.instrument_codes),
    notTags: wordsOf(options.not_tags),
    lineServices: wordsOf(options.line_services),
  };
}
