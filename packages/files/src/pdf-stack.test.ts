/**
 * The PDF stack must hold exactly ONE pdfjs, and all of it must work in one
 * long-running process.
 *
 * This is the runtime gate that `docs/dependency-upgrade-2026-07.md` concluded
 * was missing ("Wave 2 status"). Wave 1 shipped a live breakage that every
 * static check passed: an in-range bump of `pdf-to-png-converter` pulled a
 * second `pdfjs-dist` alongside the first. pdfjs compares its API and Worker
 * version strings EXACTLY and its worker config is process-global, so two
 * copies in one process break whichever loads second — and the extract worker
 * loads both, `parsePdf` for a text layer and `rasterizePdfToPngs` for the
 * scanned-PDF OCR fallback. Neither `tsc`, nor lint, nor `next build` executes
 * a PDF, so the tree looked clean.
 *
 * Two things are asserted, and the first is the one that matters:
 *
 *  1. **The invariant.** Every consumer resolves pdfjs to the same file. This
 *     is the root cause, and it is order-independent — if a second copy ever
 *     appears, this fails no matter which entry point ran first.
 *  2. **The smoke.** All four entry points actually run in one process. This
 *     catches the other half: an upgrade that keeps one pdfjs but breaks what
 *     a consumer does with it.
 *
 * The smoke runs rasterize-first here and parse-first in
 * `pdf-stack-order.test.ts`, because the failure is order-dependent and
 * permanent for the process that hits it. Vitest gives each test file its own
 * module registry, so the second file starts from a clean `GlobalWorkerOptions`.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { helveticaPdf, pdfStackSteps } from './pdf-fixtures.test-helper';

const require_ = createRequire(import.meta.url);

/** Where each library will look for pdfjs, resolved from ITS directory rather
 *  than ours — a nested copy is exactly what this is hunting for. */
const CONSUMERS: Record<string, string> = {
  // Text layer. Declares `pdfjs-dist` 5.4.296; the pnpm-workspace override
  // forces it onto ours. That only works because pdf-parse's ESM build imports
  // pdfjs as a bare specifier — its CJS bundle (`dist/pdf-parse/cjs/index.cjs`)
  // has a whole pdfjs 5.4.296 inlined, which the override cannot reach. If
  // anything ever loads pdf-parse through the `require` condition, this test is
  // what says so.
  'pdf-parse': path.dirname(require_.resolve('pdf-parse')),
  // Scanned-PDF OCR fallback. Declares `pdfjs-dist` ~6.0.227.
  'pdf-to-png-converter': path.dirname(require_.resolve('pdf-to-png-converter')),
  // Our own direct use: embedded figures and the password path.
  '@mantle/files': import.meta.dirname,
};

const PDFJS_ENTRY = 'pdfjs-dist/legacy/build/pdf.mjs';

describe('pdf stack: one pdfjs', () => {
  it('every consumer resolves pdfjs to the same file', () => {
    const resolved = Object.fromEntries(
      Object.entries(CONSUMERS).map(([name, dir]) => [
        name,
        require_.resolve(PDFJS_ENTRY, { paths: [dir] }),
      ]),
    );
    expect(
      new Set(Object.values(resolved)).size,
      `two pdfjs copies: ${JSON.stringify(resolved, null, 2)}`,
    ).toBe(1);
  });

  it('leaves the process-global worker config pointing at that pdfjs', async () => {
    const pdfjs = await import(PDFJS_ENTRY);
    const before = pdfjs.GlobalWorkerOptions.workerSrc;
    for (const [, run] of pdfStackSteps(helveticaPdf())) await run();
    // No consumer may repoint the shared worker at a vendored one — pdf-parse
    // ships a 5.4.296 `pdf.worker.mjs` in its dist for the browser build, and
    // `PDFParse.setWorker()` is the call that would install it.
    expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe(before);
  });
});

describe('pdf stack: one process, rasterize first', () => {
  it('runs every pdfjs entry point after rasterizing', async () => {
    const bytes = helveticaPdf();
    for (const [name, run] of pdfStackSteps(bytes)) {
      await expect(
        run(),
        `${name} failed after an earlier pdfjs entry point`,
      ).resolves.toBeDefined();
    }
  });
});
