/**
 * The summary of a PDF drawing gets the kind of the file as a fact (P3,
 * 2026-11-17): the extractor's input names it outside the fence, in the
 * words of the kind's note. With no kind the input is as before.
 */
import { describe, expect, it } from 'vitest';
import { pdfKindNote } from '@mantle/files';
import { backgroundFence } from '@mantle/std';
import { buildExtractorInput } from './model';

const FENCE = backgroundFence('0123456789abcdef');

describe('the kind of a PDF drawing as a fact of its summary', () => {
  it('names the kind outside the fence; no kind, no line', () => {
    const node = { title: 'made-up sheet.pdf', type: 'file' };
    const fact = pdfKindNote('isometric');
    expect(fact).toBe('A piping isometric.');
    const withKind = buildExtractorInput(null, node, 'P&ID word in the body', FENCE, fact);
    const before = buildExtractorInput(null, node, 'P&ID word in the body', FENCE);
    expect(withKind.user).toContain(
      'This is a PDF file. Its read with no model names its kind: A piping isometric.',
    );
    // The fact stands before the fenced text, which is the body's.
    expect(withKind.user.indexOf('A piping isometric.')).toBeLessThan(
      withKind.user.indexOf(FENCE.open),
    );
    expect(before.user).not.toContain('PDF file');
    expect(withKind.system).toBe(before.system);
    expect(pdfKindNote('no-such-kind')).toBeNull();
  });
});
