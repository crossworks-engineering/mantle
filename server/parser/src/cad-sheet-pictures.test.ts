/**
 * The parser's side of `job.sheetPictures` (./cad.ts sheetPictures): the
 * spec it takes, and how it reads the child's reply. The child here is a
 * made-up shell script in the place of the parser's Python (PARSER_PYTHON):
 * the real child, cad/sheet_pictures.py, has its own test
 * (cad/tests/test_sheet_pictures.py).
 */
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { sheetPictures } from './cad';
import { JobFailure } from './job-failure';

const root = mkdtempSync(path.join(os.tmpdir(), 'sheet-pictures-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

/** A child that writes `reply` as its answer (its arguments: the script,
 *  the input, the extension, the folder, the spec), or exits with `code`. */
function childOf(reply: string | null, code = 0): void {
  const file = path.join(mkdtempSync(path.join(root, 'child-')), 'python');
  const write = reply === null ? '' : `printf '%s' '${reply}' > "$4/sheet-pictures.json"\n`;
  writeFileSync(file, `#!/bin/sh\ncp "$5" "$4/spec-seen.json"\n${write}exit ${code}\n`);
  chmodSync(file, 0o755);
  vi.stubEnv('PARSER_PYTHON', file);
}

const SPEC = {
  ext: 'tif',
  pictures: [
    { file: 'sheet.png', part: [0, 0, 1, 1], maxSide: 2800 },
    { file: 'right-side.png', part: [0.8, 0, 1, 1], maxSide: 4000, dpiCap: 200 },
  ],
} as const;

const run = (spec: unknown = SPEC) => {
  const dir = mkdtempSync(path.join(root, 'job-'));
  const input = path.join(dir, 'in.bin');
  writeFileSync(input, 'x');
  return { dir, done: sheetPictures(input, spec as typeof SPEC, dir, 60_000) };
};

describe('sheetPictures', () => {
  it('gives the format, the size and the pictures the child wrote, and leaves no spec or reply in the folder', async () => {
    childOf(
      '{"ok":true,"format":"TIFF raster","widthMm":841,"heightMm":594,"pictures":["sheet.png","right-side.png","other.png","../in.bin",7]}',
    );
    const { dir, done } = run();
    // Only the names that were asked for come back.
    expect(await done).toEqual({
      format: 'TIFF raster',
      widthMm: 841,
      heightMm: 594,
      pictures: ['sheet.png', 'right-side.png'],
    });
    // The child got the spec with every field set.
    const seen = JSON.parse(readFileSync(path.join(dir, 'spec-seen.json'), 'utf8'));
    expect(seen).toEqual([
      { file: 'sheet.png', part: [0, 0, 1, 1], maxSide: 2800, dpiCap: null },
      { file: 'right-side.png', part: [0.8, 0, 1, 1], maxSide: 4000, dpiCap: 200 },
    ]);
    expect(readdirSync(dir).sort()).toEqual(['in.bin', 'spec-seen.json']);
  });

  it('a file that is none of the formats is null', async () => {
    childOf('{"ok":false,"notMine":true}');
    expect(await run().done).toBeNull();
  });

  it('an extension that is no extension is null, and no child starts', async () => {
    childOf('{"ok":true,"format":"x","widthMm":1,"heightMm":1,"pictures":[]}');
    for (const ext of ['', 'TIF', '../x', 7]) {
      const { dir, done } = run({ ...SPEC, ext });
      expect(await done, String(ext)).toBeNull();
      expect(existsSync(path.join(dir, 'spec-seen.json'))).toBe(false);
    }
  });

  it('a child that fails, or gives no reply or no answer, is a failed job', async () => {
    for (const [reply, code] of [
      [null, 1],
      [null, 0],
      ['not json', 0],
      ['{"ok":false}', 0],
    ] as const) {
      childOf(reply, code);
      const err = await run().done.catch((e: unknown) => e);
      expect(err, String(reply)).toBeInstanceOf(JobFailure);
      expect((err as JobFailure).code).toBe('failed');
    }
  });

  it('refuses a bad spec as a bad_request, before any child', async () => {
    childOf('{"ok":true,"format":"x","widthMm":1,"heightMm":1,"pictures":[]}');
    const one = SPEC.pictures[0];
    const bad: unknown[] = [
      [],
      'sheet.png',
      [one, one, one, one, one],
      [{ ...one, file: '../sheet.png' }],
      [{ ...one, file: 'in.bin' }],
      [{ ...one, file: 'Sheet.PNG' }],
      [{ ...one, file: 'out.json' }],
      [{ ...one, part: [0, 0, 1] }],
      [{ ...one, part: [0.5, 0, 0.5, 1] }],
      [{ ...one, part: [0, 0, 1.5, 1] }],
      [{ ...one, part: [0, 0, Number.NaN, 1] }],
      [{ ...one, maxSide: 100_000 }],
      [{ ...one, maxSide: 12.5 }],
      [{ ...one, dpiCap: 1 }],
      [null],
    ];
    for (const pictures of bad) {
      const { dir, done } = run({ ext: 'tif', pictures });
      const err = await done.catch((e: unknown) => e);
      expect(err, JSON.stringify(pictures)).toBeInstanceOf(JobFailure);
      expect((err as JobFailure).code).toBe('bad_request');
      expect(existsSync(path.join(dir, 'spec-seen.json'))).toBe(false);
    }
  });
});
