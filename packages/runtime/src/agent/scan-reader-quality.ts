/**
 * Did the Scan reader read a page badly? (docs/ai-workers.md, "The Scan
 * reader".) Answered from what is already in hand, never from a second paid
 * call: the model's own answer, and the free reads of the same page before
 * it (the book reader runs Tesseract first, and can count the page's text
 * lines from its picture). A bad read sends the page on to the vision
 * worker; a good one is the page's text.
 *
 * The reasons, each enough on its own:
 *  - `no_text`: the answer is empty.
 *  - `cut`: the model stopped at its token cap, so the end of the page is
 *    missing.
 *  - `short`: fewer than SCAN_READ_MIN_CHARS characters that are not spaces.
 *    A page goes to the Scan reader for its words, so next to none is a
 *    failed read.
 *  - `loop`: one line of SCAN_READ_REPEAT_MIN_LEN characters or more written
 *    more than SCAN_READ_REPEAT_MAX times in a row, the way a small model
 *    stuck in a loop writes. A table read by rows repeats short cells,
 *    never a whole line.
 *  - `too_few_lines`: the free reads found SCAN_READ_LINES_MIN_EXPECTED text
 *    lines or more on the page (`expectedLines`: the more of Tesseract's
 *    lines and the picture's ink bands), and the answer holds fewer than
 *    SCAN_READ_LINES_MIN_SHARE of them: rows were left out. The answer's
 *    lines are the more of its own lines and its characters (not spaces)
 *    over SCAN_READ_CHARS_PER_LINE: an OCR engine writes a paragraph of
 *    prose as one line (mistral-ocr on a scanned prose page: 30 printed
 *    lines, 1 paragraph), so its lines alone would call every prose page
 *    short. A count that finds too few lines (a very bad scan) only weakens
 *    this check.
 *  - `illegible`: more than SCAN_READ_ILLEGIBLE_MAX of the words are the
 *    `[?]` the prompt asks for in place of a word the model cannot read: its
 *    own word that the page is hard for it.
 *  - `disagrees`: Tesseract read SCAN_READ_ANCHORS_MIN or more words with a
 *    confidence of SCAN_READ_ANCHOR_CONF or more (on the bench, nearly always
 *    right), and under SCAN_READ_AGREE_MIN of them are in the answer: the
 *    model left out or made up text that a free read saw plainly. On a page
 *    Tesseract read with no confident word, this check has nothing to stand
 *    on and is not made.
 *  - `unverified`: no free read can vouch for the answer: Tesseract read
 *    under SCAN_READ_ANCHORS_MIN confident words, and the answer has more
 *    than SCAN_READ_LINES_MAX_SHARE times the lines the free reads found
 *    (and more than SCAN_READ_LINES_MIN_EXPECTED). On the bench
 *    (2026-11-19) a page too bad to read made a cheap model write a whole
 *    plausible spec table that was not on it (42 to 52 lines where the free
 *    reads saw 7 to 20); a true read of a page the free reads can count
 *    keeps its count. A made-up page must never be indexed as the page.
 *    Made only with `expectedLines` given: the book reader always gives it.
 *
 * Pure: no model, no database. The bench harness scores the same rules
 * (the research notes of 2026-11-19 say how).
 */

export const SCAN_READ_MIN_CHARS = 40;
export const SCAN_READ_REPEAT_MAX = 4;
export const SCAN_READ_REPEAT_MIN_LEN = 8;
export const SCAN_READ_ILLEGIBLE_MAX = 0.05;
export const SCAN_READ_ANCHOR_CONF = 90;
export const SCAN_READ_ANCHOR_MIN_LEN = 3;
export const SCAN_READ_ANCHORS_MIN = 30;
export const SCAN_READ_AGREE_MIN = 0.8;
export const SCAN_READ_LINES_MIN_EXPECTED = 10;
export const SCAN_READ_LINES_MIN_SHARE = 0.8;
export const SCAN_READ_LINES_MAX_SHARE = 1.5;
/** Characters (not spaces) a printed line holds at least, for the answer's
 *  line count by its length: lower than a line of prose (about 65) or of a
 *  spec table row (about 45), so a whole read is never short by it. */
export const SCAN_READ_CHARS_PER_LINE = 45;

/** The mark the prompt asks for in place of a word the model cannot read. */
export const ILLEGIBLE_MARK = '[?]';

export type ScanReadBadReason =
  'no_text' | 'cut' | 'short' | 'loop' | 'too_few_lines' | 'illegible' | 'disagrees' | 'unverified';

/** One word Tesseract read: its text and its confidence (0-100, or null). */
export type OcrWord = { text: string; conf: number | null };

export type ScanReadQuality = {
  /** True: the read stands. False: the page goes on to vision. */
  ok: boolean;
  reasons: ScanReadBadReason[];
  /** The share of the answer's words that are `[?]`. */
  illegibleShare: number;
  /** Tesseract's confident words (the anchors) the check had. */
  anchors: number;
  /** The share of the anchors found in the answer; null with too few. */
  agreement: number | null;
};

/** Upper case, `|` and runs of space as one space: the form both reads are
 *  compared in. */
function normal(s: string): string {
  return s.replace(/\|/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
}

/** How often each word appears. */
function counts(words: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of words) m.set(w, (m.get(w) ?? 0) + 1);
  return m;
}

/**
 * The quality of one Scan reader answer. `finishReason` is the provider's
 * (`length` = cut at the cap); `ocrWords` the words Tesseract read on the
 * page, with their confidences (none: the agreement check is not made);
 * `expectedLines` the page's text lines by the free reads (none: the line
 * check is not made).
 */
export function scanReadQualityOf(
  text: string,
  opts: {
    finishReason?: string | null;
    ocrWords?: readonly OcrWord[];
    expectedLines?: number | null;
  } = {},
): ScanReadQuality {
  const reasons: ScanReadBadReason[] = [];
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) reasons.push('no_text');
  if (opts.finishReason === 'length') reasons.push('cut');
  if (words.length > 0 && text.replace(/\s/g, '').length < SCAN_READ_MIN_CHARS) {
    reasons.push('short');
  }

  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  let run = 0;
  let last: string | null = null;
  for (const line of lines) {
    run = line === last && line.length >= SCAN_READ_REPEAT_MIN_LEN ? run + 1 : 1;
    last = line;
    if (run > SCAN_READ_REPEAT_MAX) {
      reasons.push('loop');
      break;
    }
  }

  const expected = opts.expectedLines ?? 0;
  if (
    expected >= SCAN_READ_LINES_MIN_EXPECTED &&
    Math.max(lines.length, Math.ceil(text.replace(/\s/g, '').length / SCAN_READ_CHARS_PER_LINE)) <
      SCAN_READ_LINES_MIN_SHARE * expected
  ) {
    reasons.push('too_few_lines');
  }

  let marks = 0;
  for (const w of words) marks += w.split(ILLEGIBLE_MARK).length - 1;
  const illegibleShare = words.length > 0 ? marks / words.length : 0;
  if (illegibleShare > SCAN_READ_ILLEGIBLE_MAX) reasons.push('illegible');

  const anchorList = (opts.ocrWords ?? [])
    .filter(
      (w) =>
        w.conf !== null &&
        w.conf >= SCAN_READ_ANCHOR_CONF &&
        w.text.trim().length >= SCAN_READ_ANCHOR_MIN_LEN &&
        /[\p{L}\p{N}]/u.test(w.text),
    )
    .map((w) => normal(w.text))
    // A word Tesseract read with a `|` in it (a ruled line) is two words here.
    .flatMap((w) => w.split(' '))
    .filter((w) => w.length >= SCAN_READ_ANCHOR_MIN_LEN);
  let agreement: number | null = null;
  if (anchorList.length >= SCAN_READ_ANCHORS_MIN) {
    const have = counts(normal(text).split(' '));
    let hit = 0;
    for (const [w, n] of counts(anchorList)) hit += Math.min(n, have.get(w) ?? 0);
    agreement = hit / anchorList.length;
    if (agreement < SCAN_READ_AGREE_MIN) reasons.push('disagrees');
  }

  // Made only when the caller gave the free reads' line count (0 counts:
  // the free reads found no line); with none, there is nothing to weigh.
  if (
    opts.expectedLines != null &&
    anchorList.length < SCAN_READ_ANCHORS_MIN &&
    lines.length > Math.max(SCAN_READ_LINES_MIN_EXPECTED, SCAN_READ_LINES_MAX_SHARE * expected)
  ) {
    reasons.push('unverified');
  }

  return {
    ok: reasons.length === 0,
    reasons,
    illegibleShare: Math.round(illegibleShare * 1000) / 1000,
    anchors: anchorList.length,
    agreement: agreement === null ? null : Math.round(agreement * 1000) / 1000,
  };
}
