/**
 * Extractor: the decider's part of a PDF drawing read. A PDF the no-model
 * rules left unsure is put to the decider's `pdf_kind` use, once
 * (packages/decisions/src/pdf-kind.ts). The file database pass
 * (./auto-table.ts) calls this only while the file has no database for its
 * bytes, and the answer is stored in that database, so the same bytes are
 * not asked about again.
 *
 * What leaves the box: page counts by class and size, three totals, and the
 * text sample the parser cut (about 1,500 characters). Nothing when the use
 * is off. The router's step builds it in the parser; this asks.
 *
 * The page types (pdfPageDeciderOf, plan page c607711a, M3 in shadow): one
 * ask a page with its picture, at the same place and under the same guard,
 * and only on a box whose operator set `uses.pdf_kind.pages: true` on a
 * decider pinned to PDF_PAGE_MODEL.
 */
import {
  DecideBatch,
  PDF_PAGE_MODEL,
  decidePdfKind,
  decidePdfPageKind,
  pdfPageAsksOn,
} from '@mantle/decisions';
import { llmWorkAllowed } from '@mantle/db';
import { answerKey, bytesKey, keepAnswer, keptAnswer } from '@mantle/db/answer-cache';
import type { PdfKindAsk, PdfKindDecision, PdfPageAsk } from '@mantle/files';
import type { PdfPageDecide, PdfPageDecision } from '@mantle/content/pdf-read';
import { pipelineAsksDayCap, pipelineAsksToday } from '@mantle/content/pipeline-asks';

/**
 * Ask the decider what an unsure PDF is. `state`: what the PDF router's step
 * built from the page facts (pdfKindAskFrom, @mantle/files) and the core
 * checked (pdfKindAskOf, packages/content/src/pdf-read.ts). Null: no answer
 * (model work is not allowed for this file, the use is off, there is no
 * text to judge, or the call failed), and the file stays unsure.
 *
 * The file database pass runs before the extract's own cost guard, so this
 * asks the same guard itself (`llmWorkAllowed`): a file that gets no model
 * work gets no decider call, and none of its text leaves the box.
 */
export async function askPdfKind(
  ownerId: string,
  nodeId: string,
  state: PdfKindAsk,
): Promise<PdfKindDecision | null> {
  if (!(await llmWorkAllowed(nodeId))) return null;
  return decidePdfKind(ownerId, state);
}

/** Page asks in a row with no answer that stop the asks of a file (the
 *  breaker's own number: with one DecideBatch a file, the breaker hears the
 *  file once, at its end). */
export const PAGE_ASK_FAILURES_STOP = 3;

/** What the page asks need, in a test stand-ins. */
export type PdfPageDeciderDeps = {
  allowed(nodeId: string): Promise<boolean>;
  on(ownerId: string): Promise<boolean>;
  decide: typeof decidePdfPageKind;
  dayCap(): number;
  today(ownerId: string): Promise<number>;
};

const DEPS: PdfPageDeciderDeps = {
  allowed: (nodeId) => llmWorkAllowed(nodeId),
  on: (ownerId) => pdfPageAsksOn(ownerId),
  decide: (...a) => decidePdfPageKind(...a),
  dayCap: () => pipelineAsksDayCap(),
  today: (ownerId) => pipelineAsksToday(ownerId),
};

/**
 * The page asks of one file (the router's part 2), or null: no page ask for
 * this file. Two checks, here, once a file: the file may have model work
 * (llmWorkAllowed, the guard of askPdfKind), and this box asks page types
 * (pdfPageAsksOn: the operator's `uses.pdf_kind.pages: true` with the use
 * on, and the decider pinned to PDF_PAGE_MODEL). The manifest never ships
 * `pages`, so a client box gets null, and no page picture leaves it
 * (Jason, Q5).
 *
 * Each paid answer is kept in the answer cache, and `kept` reads it back
 * (an extract tried again pays for none twice; the core takes kept answers
 * first, free, with no day-cap room). The key holds the router's version,
 * so a new question asks again. A paid ask counts in the box's day cap
 * (`room`) and goes in the file's one DecideBatch. After
 * PAGE_ASK_FAILURES_STOP asks in a row with no answer (any null: a failure,
 * over the limits, no picture part, no choice, no route), or with the
 * breaker open, it says `stop`: the rest of the file keeps its rules.
 */
export async function pdfPageDeciderOf(
  ownerId: string,
  nodeId: string,
  deps: Partial<PdfPageDeciderDeps> = {},
): Promise<PdfPageDecide | null> {
  const d = { ...DEPS, ...deps };
  if (!(await d.allowed(nodeId)) || !(await d.on(ownerId))) return null;
  const batch = new DecideBatch();
  let noneInRow = 0;
  // What is asked (the use, the model, the router's version, the picture's
  // bytes and the other fields), never the page alone; and the fields sent.
  const keyOf = (ask: PdfPageAsk, picture: Buffer, version: string) => {
    const { picture: _name, ...fields } = ask;
    const parts = ['pdf_page', PDF_PAGE_MODEL, version, bytesKey(picture), fields];
    return { key: answerKey('decider', parts), fields };
  };
  return {
    // A count that cannot be read is no room: the pages keep their rules
    // (`rules: day cap`), never an ask past the cap.
    room: async () => Math.max(0, d.dayCap() - (await d.today(ownerId).catch(() => Infinity))),
    kept: (ask, picture, version) => keptAnswer<PdfPageDecision>(keyOf(ask, picture, version).key),
    ask: async (ask, picture, version) => {
      const { key, fields } = keyOf(ask, picture, version);
      const skippedBefore = batch.skipped;
      const answer = await d.decide(ownerId, fields, picture, batch);
      if (answer) {
        noneInRow = 0;
        await keepAnswer('decider', key, answer, true);
        return answer;
      }
      if (batch.skipped > skippedBefore) return 'stop';
      noneInRow += 1;
      return noneInRow >= PAGE_ASK_FAILURES_STOP ? 'stop' : null;
    },
    settle: () => batch.settle(),
  };
}
