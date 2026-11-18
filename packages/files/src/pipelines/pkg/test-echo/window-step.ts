/**
 * A test-only Reader of page windows (docs/pipelines.md, "Page windows"),
 * beside `test-echo` and as it is, only where PARSER_TEST_PIPELINES is 1.
 * For each window it is given it writes one `Pages` row a page of the
 * ORIGINAL file (`pageFrom` to `pageTo`), and it reads the first and the
 * last page of its window with the local OCR (pypdfium2 draws the page,
 * Tesseract with `--psm 3` reads it), so a test can check the window holds
 * the pages its request names: the made-up scans print `PAGE <n>` at the
 * top. Its state counts the windows. In the parser image only (it needs
 * the CAD venv and Tesseract); the e2e test runs it there.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FILE_TABS_WRITE, type PipelineStep } from '../../contract';

/** Run a program; its stdout, or null on a failure. */
function run(cmd: string, args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out : null));
  });
}

const CAD_PYTHON = '/opt/cad/bin/python';

const DRAW = [
  'import sys, pypdfium2 as p',
  'doc = p.PdfDocument(sys.argv[1])',
  'for i in (0, len(doc) - 1):',
  '    doc[i].render(scale=150 / 72, grayscale=True).to_pil().save(f"{sys.argv[2]}-{i}.png")',
].join('\n');

/** The page number the made-up scan prints at its top, read by OCR. */
async function printedPage(png: string, dir: string): Promise<number | null> {
  const text = await run('tesseract', [png, 'stdout', '--psm', '3'], dir);
  const m = text?.match(/PAGE\s+(\d+)/);
  return m ? Number(m[1]) : null;
}

export const step: PipelineStep = async (req, job) => {
  const from = req.pageFrom ?? 1;
  const to = req.pageTo ?? from;
  const input = path.join(job.dir, 'window.pdf');
  await fs.writeFile(input, await job.bytes());
  const pagesHere = await job.pdfPageCount();
  // The CAD venv of the parser image (its PARSER_PYTHON), else a python3.
  const python = await fs.access(CAD_PYTHON).then(
    () => CAD_PYTHON,
    () => 'python3',
  );
  const drawn = await run(python, ['-c', DRAW, input, path.join(job.dir, 'p')], job.dir);
  const first = drawn === null ? null : await printedPage(path.join(job.dir, 'p-0.png'), job.dir);
  const last =
    drawn === null
      ? null
      : await printedPage(path.join(job.dir, `p-${(pagesHere ?? 1) - 1}.png`), job.dir);
  const windows = ((req.state as { windows?: number } | undefined)?.windows ?? 0) + 1;
  const rows: (string | number | null)[][] = [];
  for (let p = from; p <= to; p++) {
    const ocr = p === from ? first : p === to ? last : null;
    rows.push([p, `window ${windows}`, ocr]);
  }
  return {
    status: 'ok',
    state: { windows },
    counts: { windows: 1, pages: to - from + 1 },
    calls: [
      {
        call: 'tool',
        tool: FILE_TABS_WRITE,
        input: {
          tabs: [
            {
              name: 'Pages',
              columns: [
                { name: 'Page', type: 'number' },
                { name: 'Text', type: 'text' },
                { name: 'Printed', type: 'number' },
              ],
              rows,
            },
          ],
          text: `## Page ${from}\nwindow ${windows} of ${req.pagesTotal ?? '?'} pages; ${pagesHere} here`,
        },
      },
    ],
  };
};
