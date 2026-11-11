/**
 * The rows of one PDF page with a text layer, with no model (plan page
 * 11a16779, sections 10.6 and 10.7): its words, the tags and line numbers
 * among them, and its markups. Pure functions on what the page reader gave
 * (./pdf-primitives.ts); the grammar is ./pdf-tags.ts.
 *
 * Nothing is dropped. Every word is a row. A token of the wide tag shape
 * (`TAG_LIKE`) ends in exactly one place: an instrument tag, an equipment
 * tag, a line number, or `rejected` (it has the shape and fits no pattern),
 * and the page's account holds the four counts, which add up. Text of the
 * drawing's frame is flagged by a region, never left out: real tags sit at
 * the edge of a sheet too.
 *
 * A row's box is in the page frame of the reader: fractions of the shown
 * page, origin top left.
 */

import type { Annotation, Box, PagePrimitives } from './pdf-primitives';
import { bubblePairs, bubbleTags, runToken } from './pdf-kind';
import {
  parseEquipmentTag,
  parseInstrumentTag,
  parseLineNumber,
  TAG_LIKE,
  tagKey,
  tokenItems,
  tokensOf,
} from './pdf-tags';

/**
 * Where a word is on the sheet. `title_block`: in the lower right corner,
 * where a drawing's title block is ({@link TITLE_BLOCK_MM}); by position
 * only, not by the block's own frame. `template`: the same text at the same
 * place on three or more pages of the file ({@link markTemplates}). A flag
 * for a reader to filter on; a tag in such a place is still listed.
 */
export type Region = 'body' | 'title_block' | 'template';

/** The corner taken as the title block: this wide and this high, in
 *  millimetres on paper, from the lower right corner of the shown page. An
 *  ISO 7200 title block is 180 mm wide at most. */
export const TITLE_BLOCK_MM = { width: 190, height: 70 };

export type WordRow = {
  /** The line of the page the word is on (a number from 1, in read order). */
  line: number;
  text: string;
  box: Box;
  angle: number;
  sizeMm: number;
  hidden: boolean;
  spaced: boolean;
  region: Region;
};

/** Where a tag or a line number was read: in a word of the text layer, in
 *  a code with its loop number under it (a bubble), in a markup's text, or
 *  in the text a vision model read off a piece of a scan (`ocr`,
 *  ./pdf-sketch.ts). */
export type RowSource = 'text' | 'bubble' | 'markup' | 'ocr';

export type TagRow = {
  /** Canonical form. */
  tag: string;
  /** Letters and digits only: joins the dash forms of one tag. */
  key: string;
  /** The token as written (for a bubble: the code, a space, the number). */
  raw: string;
  type: 'instrument' | 'equipment';
  /** The part before the letters: an area or a unit. '' when there is none. */
  unit: string;
  /** The ISA code of an instrument, the type letters of equipment. */
  letters: string;
  /** The loop number of an instrument; the number of equipment, with a
   *  fourth part when the tag has one. */
  number: string;
  source: RowSource;
  /** The word it was read in: an index into the page's `words`; -1 for a
   *  markup. Its region and hidden flag are the word's. */
  word: number;
  /** 0 to 1, by a fixed table ({@link CONFIDENCE}). */
  confidence: number;
  box: Box;
};

export type LineRow = {
  /** Canonical form: the parts with one dash between. */
  line: string;
  raw: string;
  /** The size part as written. */
  size: string;
  /** The serial number part. */
  serial: string;
  source: RowSource;
  word: number;
  confidence: number;
  box: Box;
};

export type MarkupRow = {
  kind: string;
  text: string;
  author: string;
  box: Box;
  /** The drawn markup nearest to this one, when one lies within
   *  {@link BESIDE_MM}: the line or the cloud that says what the text is
   *  about. '' when there is none, or when this markup has no text. */
  besideKind: string;
  besideBox: Box | null;
};

/** What became of the page's tokens. The first four add up to `tagLike`. */
export type PageAccount = {
  words: number;
  /** Tokens of the wide tag shape. */
  tagLike: number;
  asInstrument: number;
  asEquipment: number;
  asLine: number;
  /** Of the tag shape, and no pattern fits. */
  rejected: number;
  /** Tokens that gave a tag or a line number and are not of the wide
   *  shape: a line number with an inch mark, a tag with a list after it, an
   *  instrument tag written with no dash. */
  otherTagTokens: number;
  /** Tags a list added beyond its first (`P-1A/B` and `PSV-101A/B` add
   *  one each). */
  fromLists: number;
  /** Instrument tags read as a code with its number under it. */
  bubbles: number;
};

export type PageRows = {
  words: WordRow[];
  tags: TagRow[];
  lines: LineRow[];
  markups: MarkupRow[];
  account: PageAccount;
  /** True when the page holds more markups than the pairing looks at
   *  ({@link BESIDE_MAX_PAIRS}): no row names the markup beside it. */
  markupsNotPaired?: boolean;
};

/**
 * How sure a row is, by how it was read. A fixed table, so a reader can
 * filter on it; anything under 0.8 is a value to check.
 */
export const CONFIDENCE = {
  /** An ISA code and a loop number in one token. */
  instrument: 0.95,
  /** A code with a number under it: the pairing is by place. */
  bubble: 0.85,
  /** A line number whose size has an inch mark or `DN`. */
  line: 0.95,
  /** A line number whose size is a bare number. */
  lineBareSize: 0.8,
  /** Equipment with a unit part. */
  equipment: 0.9,
  /** Equipment with no unit part: many short codes have this shape. */
  equipmentNoUnit: 0.6,
  /** Taken off for a word put together from letter-spaced glyphs. */
  spacedLess: 0.2,
  /** Taken off for a value a vision model read off a scan: it is always a
   *  value to check. */
  ocrLess: 0.3,
  /** A word a vision model read off a scan. */
  ocrWord: 0.6,
} as const;

/** Markups that draw a shape: what a text markup can sit beside. */
const SHAPES = new Set(['Line', 'Circle', 'Square', 'PolyLine', 'Polygon', 'Ink']);
/** A text markup and a shape are "beside" within this many millimetres. */
export const BESIDE_MM = 15;
/**
 * The most text markups times drawn markups one page's pairing looks at.
 * The pairing compares each with each, after the page's read and outside
 * its time budget, so the page's own markups must not set its cost (as
 * `BUBBLE_MAX_PAIRS`). The fullest sketch sheet measured holds 30 markups.
 * A page over it pairs nothing, and says so (`markups_not_paired`).
 */
export const BESIDE_MAX_PAIRS = 4_000_000;

const centre = (b: Box): [number, number] => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

/** True when a box's centre lies in the title block corner of its page
 *  ({@link TITLE_BLOCK_MM}). */
export function inTitleBlockCorner(b: Box, widthMm: number, heightMm: number): boolean {
  const [x, y] = centre(b);
  return (1 - x) * widthMm <= TITLE_BLOCK_MM.width && (1 - y) * heightMm <= TITLE_BLOCK_MM.height;
}

/** The gap between two boxes on paper, millimetres (0 when they touch). */
function gapMm(a: Box, b: Box, widthMm: number, heightMm: number): number {
  const dx = Math.max(0, a[0] - b[2], b[0] - a[2]) * widthMm;
  const dy = Math.max(0, a[1] - b[3], b[1] - a[3]) * heightMm;
  return Math.hypot(dx, dy);
}

/**
 * What one token is by the grammar (./pdf-tags.ts), as rows: instrument
 * tags, line numbers or equipment tags, one for each item of a list
 * (`PSV-101A/B` gives two), by the one order of trial ({@link tokenItems}).
 * `as` names which, or null when no pattern fits. The one place a token
 * becomes a row, for the words of a text layer, the text of a markup and
 * the text read off a scan.
 */
export function tokenRows(
  token: string,
  box: Box,
  source: RowSource,
  word: number,
  less: number,
): {
  tags: TagRow[];
  lines: LineRow[];
  as: 'asInstrument' | 'asLine' | 'asEquipment' | null;
} {
  const sure = (base: number) => Math.max(0, Math.round((base - less) * 100) / 100);
  const read = tokenItems(token);
  if (!read) return { tags: [], lines: [], as: null };
  const { kind, items } = read;
  if (kind === 'instrument') {
    return {
      tags: items.map((item) => {
        const instrument = parseInstrumentTag(item)!;
        return {
          tag: instrument.tag,
          key: tagKey(instrument.tag),
          raw: token,
          type: 'instrument' as const,
          unit: instrument.prefix,
          letters: instrument.isa.code,
          number: instrument.loop,
          source,
          word,
          confidence: sure(CONFIDENCE.instrument),
          box,
        };
      }),
      lines: [],
      as: 'asInstrument',
    };
  }
  if (kind === 'line') {
    return {
      tags: [],
      lines: items.map((item) => {
        const line = parseLineNumber(item)!;
        const marked = /"|^DN/.test(line.size);
        return {
          line: line.line,
          raw: token,
          size: line.size,
          serial: line.serial,
          source,
          word,
          confidence: sure(marked ? CONFIDENCE.line : CONFIDENCE.lineBareSize),
          box,
        };
      }),
      as: 'asLine',
    };
  }
  return {
    tags: items.map((item) => {
      const e = parseEquipmentTag(item)!;
      return {
        tag: e.tag,
        key: tagKey(e.tag),
        raw: token,
        type: 'equipment' as const,
        unit: e.unit,
        letters: e.type,
        number: e.sub ? `${e.number}-${e.sub}` : e.number,
        source,
        word,
        confidence: sure(e.unit ? CONFIDENCE.equipment : CONFIDENCE.equipmentNoUnit),
        box,
      };
    }),
    lines: [],
    as: 'asEquipment',
  };
}

/**
 * The rows of one page. Null for a page with no text read (failed, over
 * its time, or over its glyph budget): it has no rows, and its Pages row
 * says why.
 */
export function pageRows(p: PagePrimitives, maxBesidePairs = BESIDE_MAX_PAIRS): PageRows | null {
  if (!('widthMm' in p) || p.status === 'failed' || !p.texts || !p.annotations) return null;
  const { widthMm, heightMm } = p;
  const inTitleBlock = (b: Box) => inTitleBlockCorner(b, widthMm, heightMm);
  const account: PageAccount = {
    words: 0,
    tagLike: 0,
    asInstrument: 0,
    asEquipment: 0,
    asLine: 0,
    rejected: 0,
    otherTagTokens: 0,
    fromLists: 0,
    bubbles: 0,
  };
  const words: WordRow[] = [];
  const tags: TagRow[] = [];
  const lines: LineRow[] = [];

  /** Put one token in its place. `word` is -1 for a markup's text. */
  const place = (token: string, box: Box, source: RowSource, word: number, less: number) => {
    const found = tokenRows(token, box, source, word, less);
    tags.push(...found.tags);
    lines.push(...found.lines);
    // The account is of the page's own tokens: the words of its text layer.
    if (source !== 'text') return;
    const shaped = TAG_LIKE.test(token);
    if (shaped) account.tagLike++;
    if (!found.as) {
      if (shaped) account.rejected++;
      return;
    }
    if (shaped) account[found.as]++;
    else account.otherTagTokens++;
    account.fromLists += found.tags.length + found.lines.length - 1;
  };

  // The first word of each line, for a bubble's place.
  const firstWord = new Map<object, number>();
  p.texts.forEach((t, i) => {
    firstWord.set(t, words.length);
    for (const w of t.words) {
      const at = words.length;
      words.push({
        line: i + 1,
        text: w.str,
        box: w.box,
        angle: t.angle,
        sizeMm: t.sizeMm,
        hidden: w.hidden,
        spaced: w.spaced,
        region: inTitleBlock(w.box) ? 'title_block' : 'body',
      });
      const less = w.spaced ? CONFIDENCE.spacedLess : 0;
      for (const token of tokensOf(w.str)) place(token, w.box, 'text', at, less);
    }
  });
  account.words = words.length;

  // Bubbles: a line that is only a code, with a line that is only its loop
  // number under it. The same pairing the page's counts use.
  for (const { code, number } of bubblePairs(p.texts, widthMm, heightMm) ?? []) {
    // A number with a list under one code (`101A/B`) gives a tag an item.
    for (const tag of bubbleTags(code, number)) {
      account.bubbles++;
      tags.push({
        tag: tag.tag,
        key: tagKey(tag.tag),
        raw: `${runToken(code)} ${runToken(number)}`,
        type: 'instrument',
        unit: tag.prefix,
        letters: tag.isa.code,
        number: tag.loop,
        source: 'bubble',
        word: firstWord.get(code) ?? -1,
        confidence: CONFIDENCE.bubble,
        box: [
          Math.min(code.box[0], number.box[0]),
          Math.min(code.box[1], number.box[1]),
          Math.max(code.box[2], number.box[2]),
          Math.max(code.box[3], number.box[3]),
        ],
      });
    }
  }

  // Markups: every one a row, with the tags in its text (a cloud or a line
  // can hold a comment too); a text markup with the shape beside it.
  const marks = p.annotations.filter((a) => a.kind !== 'Widget');
  const shapes = marks.filter((a) => SHAPES.has(a.kind));
  const withText = marks.filter((a) => a.text.trim() && !SHAPES.has(a.kind)).length;
  const paired = withText * shapes.length <= maxBesidePairs;
  const markups: MarkupRow[] = marks.map((a) => {
    let beside: Annotation | null = null;
    if (a.text.trim()) {
      for (const token of tokensOf(a.text)) place(token, a.box, 'markup', -1, 0);
    }
    if (a.text.trim() && !SHAPES.has(a.kind)) {
      let best = BESIDE_MM;
      for (const s of paired ? shapes : []) {
        const gap = gapMm(a.box, s.box, widthMm, heightMm);
        if (gap <= best) {
          best = gap;
          beside = s;
        }
      }
    }
    return {
      kind: a.kind,
      text: a.text,
      author: a.author,
      box: a.box,
      besideKind: beside?.kind ?? '',
      besideBox: beside?.box ?? null,
    };
  });
  return { words, tags, lines, markups, account, ...(paired ? {} : { markupsNotPaired: true }) };
}

/** Pages a text must be on, at one place, to be template text. */
export const TEMPLATE_MIN_PAGES = 3;

/**
 * Flag template text across the pages of one file: the same word at the
 * same place (to half a percent of the page) on {@link TEMPLATE_MIN_PAGES}
 * pages or more. It changes `region` from `body` to `template` in place. A
 * title-block word keeps its flag. On a file of one or two pages nothing is
 * template text.
 */
export function markTemplates(pages: readonly (PageRows | null | undefined)[]): void {
  const key = (w: WordRow) => {
    const [x, y] = centre(w.box);
    return `${w.text}\u0000${Math.round(x * 200)}\u0000${Math.round(y * 200)}`;
  };
  const seen = new Map<string, number>();
  for (const page of pages) {
    if (!page) continue;
    // Once a page, however often the page repeats it.
    for (const k of new Set(page.words.map(key))) seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  for (const page of pages) {
    if (!page) continue;
    for (const w of page.words) {
      if (w.region === 'body' && (seen.get(key(w)) ?? 0) >= TEMPLATE_MIN_PAGES)
        w.region = 'template';
    }
  }
}
