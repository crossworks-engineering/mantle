import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain-JS module, no types shipped.
import { countedFiles, readRepoFile, stripComments } from './arch-counts.mjs';
import {
  mayRead,
  PARSING_LIBRARIES,
  READERS,
  readerImport,
  readerImportsIn,
  // @ts-expect-error: plain-JS module, no types shipped.
} from './readers-in-parser.mjs';

const ROOT = join(__dirname, '..');

describe('readers-in-parser: untrusted files are read only in the parser service', () => {
  it('no product file outside the parser and the readers imports a reader', () => {
    const offenders: string[] = [];
    for (const path of countedFiles(ROOT) as string[]) {
      if (mayRead(path)) continue;
      const text = readRepoFile(ROOT, path);
      if (!text) continue;
      for (const why of readerImportsIn(stripComments(text), path) as string[]) {
        offenders.push(`${path}: ${why}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('names every reader module that exists, and only those', () => {
    for (const name of READERS as string[]) {
      expect(existsSync(join(ROOT, 'packages/files/src', `${name}.ts`)), name).toBe(true);
    }
  });

  it('the parser and the readers may import them; a brain module may not', () => {
    expect(mayRead('server/parser/src/jobs.ts')).toBe(true);
    expect(mayRead('packages/files/src/pdf.ts')).toBe(true);
    expect(mayRead('packages/files/src/parse.ts')).toBe(false);
    expect(mayRead('server/api/src/agent/extract/load-body.ts')).toBe(false);
    expect(readerImport('@mantle/files/readers/pdf', 'server/web/lib/x.ts')).toMatch(/reader/);
    expect(readerImport('./pdf', 'packages/files/src/parse.ts')).toMatch(/reader/);
    expect(readerImport('./slug', 'packages/files/src/parse.ts')).toBeNull();
    for (const lib of PARSING_LIBRARIES as string[]) {
      expect(readerImport(`${lib}/x`, 'server/web/lib/x.ts'), lib).toMatch(/parses/);
    }
  });

  it('reads static, dynamic and re-export imports, never a type-only one', () => {
    const path = 'server/web/lib/x.ts';
    expect(readerImportsIn("import { parsePdf } from '@mantle/files/readers/pdf';", path)).toHaveLength(1);
    expect(readerImportsIn("const m = await import('pdfjs-dist/legacy/build/pdf.mjs');", path)).toHaveLength(1);
    expect(readerImportsIn("export { x } from '@mantle/files/readers/document';", path)).toHaveLength(1);
    expect(readerImportsIn("import type { X } from '@mantle/files/readers/pdf';", path)).toEqual([]);
  });
});
