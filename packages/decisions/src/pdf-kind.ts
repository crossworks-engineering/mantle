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
 */
import type { DecisionQuestion } from '@mantle/voice';
import { decide } from './decide';

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
