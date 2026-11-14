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
 */
import { decidePdfKind } from '@mantle/decisions';
import { llmWorkAllowed } from '@mantle/db';
import type { PdfKindAsk, PdfKindDecision } from '@mantle/files';

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
