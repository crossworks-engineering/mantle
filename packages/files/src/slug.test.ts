/**
 * The slug/filename normalisation rules are load-bearing: they
 * decide what ends up on disk, in `nodes.path`, and in `nodes.title`.
 * A regression here would let malformed filenames slip through to
 * the host filesystem or break ltree label validity, so we cover
 * the corner cases that historically tripped me up:
 *
 *   - non-ASCII normalised away
 *   - path separators stripped (anti-traversal)
 *   - leading dots scrubbed (no accidental hidden files)
 *   - extension lowercased
 *   - empty results reject explicitly with null
 */

import { describe, expect, it } from 'vitest';
import {
  dashToLtree,
  extOf,
  INGESTABLE_EXTS,
  ltreeToDash,
  mimeForExt,
  PREVIEWABLE_MARKDOWN_EXTS,
  sanitizeFilename,
  slugifyFolder,
  TEXT_EXTS,
} from './slug';

describe('slugifyFolder', () => {
  it('lowercases and dashes', () => {
    expect(slugifyFolder('Lister Printer')).toBe('lister-printer');
  });

  it('collapses runs of non-alphanumerics into a single dash', () => {
    expect(slugifyFolder('Hello/World!! 2026')).toBe('hello-world-2026');
  });

  it('trims leading/trailing dashes', () => {
    expect(slugifyFolder('  --hello--  ')).toBe('hello');
  });

  it('caps length at 64', () => {
    expect(slugifyFolder('a'.repeat(200))).toHaveLength(64);
  });

  it('normalises non-ASCII via NFKD (combining marks become dashes)', () => {
    // NFKD splits accented chars into base + combining mark; the
    // combining marks then get scrubbed as non-[a-z0-9]. Documenting
    // the current behaviour rather than fighting it: the user sees
    // "resume" in the URL/path with one dash, which is fine.
    expect(slugifyFolder('résumé')).toBe('re-sume');
  });

  it('returns null on empty', () => {
    expect(slugifyFolder('')).toBeNull();
  });

  it('returns null when the slug would be all-dashes', () => {
    expect(slugifyFolder('!!!')).toBeNull();
  });
});

describe('sanitizeFilename', () => {
  it('lowercases and preserves the extension', () => {
    expect(sanitizeFilename('Document.PDF')).toBe('document.pdf');
  });

  it('strips path components — anti-traversal', () => {
    // "foo/bar.txt" must NOT become "foo/bar.txt"; we want bar.txt.
    expect(sanitizeFilename('foo/bar.txt')).toBe('bar.txt');
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
  });

  it('scrubs leading dots so no accidental dotfiles', () => {
    expect(sanitizeFilename('..hidden.md')).toBe('hidden.md');
  });

  it('treats the last dot as the extension boundary', () => {
    expect(sanitizeFilename('archive.tar.gz')).toBe('archive-tar.gz');
  });

  it('handles names with no extension', () => {
    expect(sanitizeFilename('Makefile')).toBe('makefile');
  });

  it('returns null on empty input', () => {
    expect(sanitizeFilename('')).toBeNull();
  });

  it('treats a leading-dot input as a stem-only filename (no ext)', () => {
    // '.txt' has its dot at index 0, so per the lastIndexOf > 0 guard
    // it isn't an extension boundary. The result is the cleaned stem
    // with no extension — which is the right behaviour for inputs
    // like '.gitignore'. We're locking down the contract, not the
    // ideal.
    expect(sanitizeFilename('.txt')).toBe('txt');
    expect(sanitizeFilename('.gitignore')).toBe('gitignore');
  });

  it('caps total length', () => {
    const out = sanitizeFilename('a'.repeat(500) + '.md');
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(200);
    expect(out!.endsWith('.md')).toBe(true);
  });
});

describe('dashToLtree / ltreeToDash', () => {
  it('round-trips dashes ↔ underscores', () => {
    const slug = 'lister-printer-v2';
    expect(ltreeToDash(dashToLtree(slug))).toBe(slug);
  });

  it('dashToLtree replaces all dashes', () => {
    expect(dashToLtree('a-b-c')).toBe('a_b_c');
  });

  it('ltreeToDash replaces all underscores', () => {
    expect(ltreeToDash('a_b_c')).toBe('a-b-c');
  });
});

describe('extOf', () => {
  it('returns lowercased extension without the dot', () => {
    expect(extOf('Doc.PDF')).toBe('pdf');
  });

  it('returns "" when there is no extension', () => {
    expect(extOf('Makefile')).toBe('');
  });

  it('returns "" for hidden files with no real ext', () => {
    expect(extOf('.gitignore')).toBe('');
  });

  it('uses the last dot for compound extensions', () => {
    expect(extOf('foo.tar.gz')).toBe('gz');
  });
});

describe('mimeForExt', () => {
  it('maps the well-known text types', () => {
    expect(mimeForExt('md')).toMatch(/^text\/markdown/);
    expect(mimeForExt('txt')).toMatch(/^text\/plain/);
    expect(mimeForExt('json')).toMatch(/^application\/json/);
  });

  it('maps pdf and images', () => {
    expect(mimeForExt('pdf')).toBe('application/pdf');
    expect(mimeForExt('png')).toBe('image/png');
  });

  it('maps the office formats', () => {
    expect(mimeForExt('docx')).toMatch(/wordprocessingml/);
    expect(mimeForExt('xlsx')).toMatch(/spreadsheetml/);
    expect(mimeForExt('xls')).toBe('application/vnd.ms-excel');
    expect(mimeForExt('xlsm')).toMatch(/macroEnabled/);
    expect(mimeForExt('xlsb')).toMatch(/binary\.macroEnabled/);
    expect(mimeForExt('vsdx')).toMatch(/visio/);
    expect(mimeForExt('csv')).toMatch(/^text\/csv/);
  });

  it('falls back to octet-stream for unknown', () => {
    expect(mimeForExt('xyz123')).toBe('application/octet-stream');
  });
});

describe('extension sets', () => {
  it('TEXT_EXTS is a subset of INGESTABLE_EXTS', () => {
    for (const ext of TEXT_EXTS) {
      expect(INGESTABLE_EXTS.has(ext)).toBe(true);
    }
  });

  it('INGESTABLE_EXTS includes pdf (the binary text source)', () => {
    expect(INGESTABLE_EXTS.has('pdf')).toBe(true);
  });

  it('INGESTABLE_EXTS includes the office formats (incl. macro-enabled Excel)', () => {
    for (const ext of ['docx', 'xlsx', 'xls', 'xlsm', 'xlsb']) {
      expect(INGESTABLE_EXTS.has(ext)).toBe(true);
    }
  });

  it('csv is a text type (editable + cached at upload)', () => {
    expect(TEXT_EXTS.has('csv')).toBe(true);
  });

  it('office binaries are NOT in TEXT_EXTS (parsed, not editable)', () => {
    for (const ext of ['docx', 'xlsx', 'xls', 'pdf']) {
      expect(TEXT_EXTS.has(ext)).toBe(false);
    }
  });

  it('PREVIEWABLE_MARKDOWN_EXTS only contains markdown extensions', () => {
    expect([...PREVIEWABLE_MARKDOWN_EXTS].sort()).toEqual(['markdown', 'md']);
  });
});

import { parserRouteForExt, TIKA_EXTS } from './slug';

describe('parserRouteForExt', () => {
  it('routes PDFs to pdf-parse (tier 1: in-process)', () => {
    expect(parserRouteForExt('pdf')).toBe('pdf-parse');
  });

  it('routes DOCX to mammoth (tier 1)', () => {
    expect(parserRouteForExt('docx')).toBe('mammoth');
  });

  it('routes the whole Excel family — xlsx, legacy xls, macro xlsm, binary xlsb — to SheetJS (tier 1)', () => {
    expect(parserRouteForExt('xlsx')).toBe('sheetjs');
    expect(parserRouteForExt('xls')).toBe('sheetjs');
    expect(parserRouteForExt('xlsm')).toBe('sheetjs');
    expect(parserRouteForExt('xlsb')).toBe('sheetjs');
  });

  it('routes text-family extensions to utf8 (tier 1)', () => {
    for (const ext of ['md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'csv']) {
      expect(parserRouteForExt(ext)).toBe('utf8');
    }
  });

  it('routes every TIKA_EXTS extension to tika (tier 2)', () => {
    // Whatever Tika handles today — ensures no entry sneaks in without a route.
    for (const ext of TIKA_EXTS) {
      expect(parserRouteForExt(ext)).toBe('tika');
    }
  });

  it('routes specifically the formats we promised Tika would cover', () => {
    // Belt-and-braces: the exact set from the file-ingestion.md changelog.
    // If someone narrows TIKA_EXTS in the future, this fails loudly.
    for (const ext of ['odt', 'ods', 'odp', 'pptx', 'ppt', 'doc', 'rtf', 'epub', 'vsdx', 'vsd']) {
      expect(parserRouteForExt(ext)).toBe('tika');
    }
  });

  it('returns "none" for unknown / opaque-binary extensions', () => {
    // Images and unknown types fall through; the extractor records
    // skipped:no_text_layer rather than chasing them.
    for (const ext of ['png', 'jpg', 'gif', 'mp3', 'mp4', 'zip', 'exe', '']) {
      expect(parserRouteForExt(ext)).toBe('none');
    }
  });
});
