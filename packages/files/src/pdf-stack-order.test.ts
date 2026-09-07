/**
 * The same one-process smoke as `pdf-stack.test.ts`, with `parsePdf` first.
 *
 * Separate file, not a second `it`: a pdfjs version collision poisons the
 * process permanently, so whichever entry point ran first is the only one that
 * can be seen to work. Vitest isolates each test file's module registry, which
 * is what gives this file a clean `GlobalWorkerOptions` to start from.
 */

import { describe, expect, it } from 'vitest';
import { helveticaPdf, pdfStackSteps } from './pdf-fixtures.test-helper';

describe('pdf stack: one process, parse first', () => {
  it('runs every pdfjs entry point after parsing a text layer', async () => {
    const steps = pdfStackSteps(helveticaPdf());
    const parseFirst = [
      ...steps.filter(([n]) => n === 'parsePdf'),
      ...steps.filter(([n]) => n !== 'parsePdf'),
    ];
    for (const [name, run] of parseFirst) {
      await expect(
        run(),
        `${name} failed after an earlier pdfjs entry point`,
      ).resolves.toBeDefined();
    }
  });
});
