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
 * is off.
 */
import { decidePdfKind, type PdfKindState } from '@mantle/decisions';
import { llmWorkAllowed } from '@mantle/db';
import type { PdfDrawing, PdfKindDecision } from '@mantle/files';

/** The state the decider gets, from the parser's answer. Pure. */
export function pdfKindState(drawing: PdfDrawing): PdfKindState {
  const count = (key: 'class' | 'size') => {
    const out: Record<string, number> = {};
    for (const p of drawing.pages) {
      const v = p[key];
      if (v) out[v] = (out[v] ?? 0) + 1;
    }
    return out;
  };
  const sum = (key: 'instruments' | 'lineNumbers' | 'tagLike') =>
    drawing.pages.reduce((n, p) => n + p[key], 0);
  return {
    pages: drawing.numPages,
    page_classes: count('class'),
    page_sizes: count('size'),
    instrument_tags: sum('instruments'),
    line_numbers: sum('lineNumbers'),
    tag_like_tokens: sum('tagLike'),
    text_sample: drawing.sample,
  };
}

/**
 * Ask the decider what an unsure PDF is. Null: no answer (model work is not
 * allowed for this file, the use is off, there is no text to judge, or the
 * call failed), and the file stays unsure.
 *
 * The file database pass runs before the extract's own cost guard, so this
 * asks the same guard itself (`llmWorkAllowed`): a file that gets no model
 * work gets no decider call, and none of its text leaves the box.
 */
export async function askPdfKind(
  ownerId: string,
  nodeId: string,
  drawing: PdfDrawing,
): Promise<PdfKindDecision | null> {
  if (!(await llmWorkAllowed(nodeId))) return null;
  return decidePdfKind(ownerId, pdfKindState(drawing));
}
