/**
 * `fitPage` (./pdf-split.ts): a one-page cut past what one call may send is
 * drawn again in place by cad/pdf_fit.py, or left as cut. The drawing itself
 * is tested in Python (cad/tests/test_pdf_fit.py, on a made-up A0 scan);
 * here a stand-in Python (PARSER_PYTHON) gives each answer the script can
 * give, so what the job takes from it is pinned with no venv.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fitPage } from './pdf-split';

let dir: string;
let saved: string | undefined;
const page = () => path.join(dir, 'page.pdf');
const CUT = '%PDF-1.7 the page as cut, past the limit';

/** A stand-in for the venv's Python: argv is pdf_fit.py, in, out, max. */
function python(body: string): void {
  const file = path.join(dir, 'python');
  writeFileSync(file, `#!/bin/sh\nIN="$2"; OUT="$3"; MAX="$4"\n${body}\n`);
  chmodSync(file, 0o755);
  process.env.PARSER_PYTHON = file;
}

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pdf-fit-'));
  saved = process.env.PARSER_PYTHON;
});

afterAll(() => {
  if (saved === undefined) delete process.env.PARSER_PYTHON;
  else process.env.PARSER_PYTHON = saved;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => writeFileSync(page(), CUT));

describe('fitPage', () => {
  it('takes the page drawn again and says its dpi', async () => {
    python(`printf '%%PDF-1.7 small' > "$OUT"; echo '{"dpi": 194.4, "bytes": 15}'`);
    expect(await fitPage(page(), 100, dir, 10_000)).toBe(194.4);
    expect(readFileSync(page(), 'utf8')).toBe('%PDF-1.7 small');
    expect(existsSync(`${page()}.fit.pdf`)).toBe(false);
  });

  it('a page that does not fit stays as cut', async () => {
    python(`echo '{"dpi": null}'`);
    expect(await fitPage(page(), 100, dir, 10_000)).toBeNull();
    expect(readFileSync(page(), 'utf8')).toBe(CUT);
  });

  it('a drawing past the limit all the same is not taken, and is removed', async () => {
    python(`head -c 500 /dev/zero > "$OUT"; echo '{"dpi": 72}'`);
    expect(await fitPage(page(), 100, dir, 10_000)).toBeNull();
    expect(readFileSync(page(), 'utf8')).toBe(CUT);
    expect(existsSync(`${page()}.fit.pdf`)).toBe(false);
  });

  it('a script that fails or says nothing is no fit', async () => {
    python(`echo boom >&2; exit 1`);
    expect(await fitPage(page(), 100, dir, 10_000)).toBeNull();
    python(`echo not json`);
    expect(await fitPage(page(), 100, dir, 10_000)).toBeNull();
    expect(readFileSync(page(), 'utf8')).toBe(CUT);
  });
});
