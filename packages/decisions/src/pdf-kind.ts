/**
 * PDF kind: use `pdf_kind`. A PDF that reads as a drawing, but that the
 * no-model rules could not name (packages/files/src/pdf-kind.ts), is put to
 * the decider once: which kind of document is it? The answer picks which
 * no-model reader runs on the file, and nothing else. It never writes,
 * retires or deletes: a wrong answer gives a file's database the wrong tabs,
 * and the rules' own kind stays beside it.
 *
 * The state is small on purpose (rule 6 of docs/decisions.md): counts, and a
 * text sample the caller cut to about 1,500 characters. No picture. The
 * sample is text of the owner's document and leaves the box under the
 * worker's privacy setting, as every decision's state does.
 *
 * One call a file: the caller asks only while the file has no database, and
 * the answer is stored in that database (File tab).
 *
 * The page types (decidePdfPageKind, below; plan page c607711a, M3): the
 * same use asks the type of one page, with its picture, where a box's
 * decider is pinned to PDF_PAGE_MODEL.
 */
import type { DecisionQuestion } from '@mantle/voice';
import { decide, resolveDecider, resolveUse, type DecideBatch } from './decide';
import { decisionPictureOf, type DecisionPicturePart, type ShrinkFn } from './picture';

/** The options, each with what it is and what it is not. */
export const PDF_KIND_CRITERIA = {
  pid: 'A piping and instrumentation diagram (P&ID): process lines with line numbers, valves, and instrument bubbles or tags such as FIC, PT, LT, PSV. Not a process flow diagram that shows only major equipment and streams.',
  pfd: 'A process flow diagram (PFD): major equipment and stream lines, often with a stream or heat and material balance table. Few or no instrument tags and no line numbers. Not a P&ID.',
  isometric:
    'A piping isometric: one pipe line drawn on slanted axes with dimensions, welds, a bill of materials and a line number in the title. Not a P&ID and not an equipment drawing.',
  equipment_drawing:
    'A mechanical or vendor drawing of one piece of equipment (a vessel, exchanger, column, tank, pump): views, dimensions, a nozzle schedule, design data. Not a diagram of a process.',
  datasheet:
    'A datasheet or a ruled form: labelled fields and values for one item (an equipment, instrument or line datasheet, a specification sheet, an inspection or test form). Mostly a table, not a drawing.',
  table:
    'Mostly rows of data under column headings: an invoice, a parts or price list, a register, a schedule, a spreadsheet printed to PDF. Not a datasheet for one item and not running text.',
  document:
    'Running text: a report, procedure, letter, specification, manual or index. Not a drawing, not a form and not rows of data.',
  other_drawing:
    'A drawing of another kind: a layout or plot plan, a civil, structural or electrical drawing, a single line diagram, a legend or symbol sheet, a cover sheet. Use this when it is a drawing and none of the options above fit.',
} as const;

export type PdfKindOption = keyof typeof PDF_KIND_CRITERIA;

/** What the decider is told about the file. Counts and one text sample. */
export type PdfKindState = {
  pages: number;
  /** Pages by class: `vector_text`, `text`, `scan` and so on. */
  page_classes: Record<string, number>;
  /** Pages by sheet size: `a4` to `a0`, `larger`. */
  page_sizes: Record<string, number>;
  /** Totals over the pages, counted by shape with no model. */
  instrument_tags: number;
  line_numbers: number;
  tag_like_tokens: number;
  /** Text from the title-block corner, then the most used words. */
  text_sample: string;
};

export type PdfKindAnswer = {
  kind: PdfKindOption;
  confidence: number;
  model: string;
  mode: 'shadow' | 'live';
  /** Live, and at or over the use's floor: the caller may route on it. */
  used: boolean;
};

/** Under this much text there is nothing to judge: no call. */
export const PDF_KIND_MIN_SAMPLE_CHARS = 40;

const INSTRUCTIONS =
  'An engineering site stores `pages` pages of one PDF file. `page_classes` and `page_sizes` count its pages by how they are made and by sheet size. `instrument_tags`, `line_numbers` and `tag_like_tokens` count text shapes found on the pages. `text_sample` is a short sample of the text: first the title block corner of a page, then the most used words. What kind of document is the file?';

/**
 * Ask the decider for the kind of an unsure PDF. Null when the use is off,
 * the sample is too short to judge, or the call failed: the file then keeps
 * the rules' answer (`unsure`).
 */
export async function decidePdfKind(
  ownerId: string,
  state: PdfKindState,
): Promise<PdfKindAnswer | null> {
  if (state.text_sample.trim().length < PDF_KIND_MIN_SAMPLE_CHARS) return null;
  const questions: Record<string, DecisionQuestion> = {
    kind: { type: 'choice', instructions: INSTRUCTIONS, criteria: PDF_KIND_CRITERIA },
  };
  const outcome = await decide({
    ownerId,
    use: 'pdf_kind',
    state,
    questions,
    // Not a person's turn: an ingest step can wait for a slow answer (the
    // worker's own ceiling still holds).
    timeoutFactor: 3,
  });
  const answer = outcome?.answers.kind;
  if (!outcome || answer?.type !== 'choice') return null;
  // Its own options only: `in` would also take a name every object has.
  if (!Object.hasOwn(PDF_KIND_CRITERIA, answer.choice)) return null;
  return {
    kind: answer.choice as PdfKindOption,
    confidence: answer.confidence,
    model: outcome.model,
    mode: outcome.mode,
    used: outcome.mode === 'live' && answer.confidence >= outcome.use.deferBelow,
  };
}

// ─── One page (the router's page types, plan page c607711a, M3) ─────────────

/**
 * The decider model the page ask is pinned to (the M2 bench, 2026-11-21:
 * both `typesafe/jev-1.14` and the alias `~typesafe/jev-latest` were served
 * by `typesafe/jev-1.14-20261014`; pin the one measured). A box asks page
 * types only when its decider worker's model is this one. That is also the
 * guard of where page pictures may leave a box in shadow (Jason, Q5,
 * 2026-11-21: only dev and the bench until pdf_kind is live): every client
 * box runs the shipped `~typesafe/jev-latest`, so a roll sends no page
 * picture from it. A box gets page types when its decider is set to this
 * model, box by box (M4).
 */
export const PDF_PAGE_MODEL = 'typesafe/jev-1.14';

/** The options of a page by route (the M2 bench): `office` is read by the
 *  book reader, `drawing` by the drawing reader. */
export const PDF_PAGE_ROUTES = {
  office: ['document', 'table', 'datasheet'],
  drawing: ['pid', 'pfd', 'isometric', 'equipment_drawing', 'other_drawing'],
} as const satisfies Record<string, readonly PdfKindOption[]>;

/** The question of one page: the same 8 options, about "this page" (the
 *  text the M2 bench asked). */
export const PDF_PAGE_INSTRUCTIONS =
  'An engineering site stores a PDF file. The state holds one page of it: `page` is its number, `picture` is a picture of this page, `size` is its sheet size and `class` says how the page is made. `instrument_tags`, `line_numbers` and `tag_like_tokens` count text shapes found on this page. `text_sample` is a short sample of the text of this page: first the title block corner, then the most used words. What kind of page is this page?';

/** What the decider is told about one page: the 8 fields of the page ask
 *  (PdfPageAsk of @mantle/files), the picture as its part. */
export type PdfPageState = {
  page: number;
  picture: DecisionPicturePart;
  size: string | null;
  class: string | null;
  instrument_tags: number;
  line_numbers: number;
  tag_like_tokens: number;
  text_sample: string;
};

/** The answer for one page. `kind`: the likeliest option of the likelier
 *  route; `confidence`: the summed chance of that route (the M2 bench's
 *  rule: a page is typed by its route, office or drawing, and the floor is
 *  on the route's sum, not on one option's). `sure`: at or over the use's
 *  floor. In M3 no answer is used: the route does not change. */
export type PdfPageAnswer = {
  kind: PdfKindOption;
  confidence: number;
  sure: boolean;
  model: string;
  mode: 'shadow' | 'live';
};

/** The route of a page's answer by its chances (pure): the route whose
 *  options sum higher (office on a tie), that sum, and its likeliest
 *  option. Chances for no known option: the choice alone, with its
 *  confidence. */
export function pageRouteOf(
  choice: string,
  confidence: number,
  probabilities: Readonly<Record<string, number>> | undefined,
): { kind: PdfKindOption; confidence: number } | null {
  const p = (k: string) => {
    const v = probabilities?.[k];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
  };
  const sum = (ks: readonly string[]) => ks.reduce((n, k) => n + p(k), 0);
  const office = sum(PDF_PAGE_ROUTES.office);
  const drawing = sum(PDF_PAGE_ROUTES.drawing);
  if (office + drawing <= 0) {
    return Object.hasOwn(PDF_KIND_CRITERIA, choice)
      ? { kind: choice as PdfKindOption, confidence }
      : null;
  }
  const route = office >= drawing ? PDF_PAGE_ROUTES.office : PDF_PAGE_ROUTES.drawing;
  // The choice when it is of the route, else the likeliest of the route, so
  // the kind kept always names the route its sum is of.
  const kind = (route as readonly string[]).includes(choice)
    ? (choice as PdfKindOption)
    : [...route].sort((a, b) => p(b) - p(a))[0]!;
  return { kind, confidence: Math.min(1, Math.max(office, drawing)) };
}

/**
 * Whether this box asks page types (the one check of where a page picture
 * may go): a decider worker whose model is PDF_PAGE_MODEL, with the use
 * `pdf_kind` on. The caller adds the file's own guard (llmWorkAllowed).
 */
export async function pdfPageAsksOn(ownerId: string): Promise<boolean> {
  const r = await resolveDecider(ownerId);
  return !!r && r.worker.model === PDF_PAGE_MODEL && resolveUse(r.params, 'pdf_kind').enabled;
}

/**
 * Ask the decider the type of one page, with its picture (a JPEG or PNG in
 * the decider's limits). Null when page asks are off on this box
 * (pdfPageAsksOn), the picture cannot be a part, or no answer came (the use
 * off, the breaker open, a failure): the page keeps its rules kind. `batch`:
 * the file's one decision for the breaker (DecideBatch).
 */
export async function decidePdfPageKind(
  ownerId: string,
  ask: Omit<PdfPageState, 'picture'>,
  picture: Buffer,
  batch?: DecideBatch,
  shrink?: ShrinkFn,
): Promise<PdfPageAnswer | null> {
  if (!(await pdfPageAsksOn(ownerId))) return null;
  const part = await decisionPictureOf(picture, 'image/jpeg', shrink).catch(() => null);
  if (!part) return null;
  // The fields in the order the bench sent them.
  const state: PdfPageState = {
    page: ask.page,
    picture: part.part,
    size: ask.size,
    class: ask.class,
    instrument_tags: ask.instrument_tags,
    line_numbers: ask.line_numbers,
    tag_like_tokens: ask.tag_like_tokens,
    text_sample: ask.text_sample,
  };
  const outcome = await decide({
    ownerId,
    use: 'pdf_kind',
    state,
    questions: {
      kind: { type: 'choice', instructions: PDF_PAGE_INSTRUCTIONS, criteria: PDF_KIND_CRITERIA },
    },
    ...(batch ? { batch } : {}),
    timeoutFactor: 3,
  });
  const answer = outcome?.answers.kind;
  if (!outcome || answer?.type !== 'choice') return null;
  const route = pageRouteOf(answer.choice, answer.confidence, answer.probabilities);
  if (!route) return null;
  return {
    kind: route.kind,
    confidence: Math.round(route.confidence * 1000) / 1000,
    sure: route.confidence >= outcome.use.deferBelow,
    model: outcome.model,
    mode: outcome.mode,
  };
}
