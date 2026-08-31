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
  EXPORT_REQUIRED_EXTS,
  exportHintForExt,
  extOf,
  INGESTABLE_EXTS,
  isVisionImage,
  ltreeToDash,
  MEDIA_EXTS,
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
  it('covers media and archive families (previously octet-stream)', () => {
    // A Telegram voice note is ogg/opus and the transcriber's clips are m4a —
    // both stored as application/octet-stream before this map learned audio,
    // so the client could only ever show a generic binary icon.
    expect(mimeForExt('opus')).toBe('audio/ogg');
    expect(mimeForExt('m4a')).toBe('audio/mp4');
    expect(mimeForExt('mp3')).toBe('audio/mpeg');
    expect(mimeForExt('mp4')).toBe('video/mp4');
    expect(mimeForExt('mov')).toBe('video/quicktime');
    expect(mimeForExt('zip')).toBe('application/zip');
    expect(mimeForExt('tiff')).toBe('image/tiff');
    expect(mimeForExt('avif')).toBe('image/avif');
  });

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

  it('maps media to real audio/video types (the inline players key on the prefix)', () => {
    expect(mimeForExt('mp4')).toBe('video/mp4');
    expect(mimeForExt('mov')).toBe('video/quicktime');
    expect(mimeForExt('webm')).toBe('video/webm');
    expect(mimeForExt('mkv')).toBe('video/x-matroska');
    expect(mimeForExt('mp3')).toBe('audio/mpeg');
    expect(mimeForExt('m4a')).toBe('audio/mp4');
    expect(mimeForExt('wav')).toBe('audio/wav');
    expect(mimeForExt('ogg')).toBe('audio/ogg');
    expect(mimeForExt('flac')).toBe('audio/flac');
  });

  it('every MEDIA_EXTS entry resolves to an audio/ or video/ mime', () => {
    for (const ext of MEDIA_EXTS) {
      expect(mimeForExt(ext)).toMatch(/^(audio|video)\//);
    }
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

  it('MEDIA_EXTS stays out of INGESTABLE_EXTS (no parser; transcription is an explicit action)', () => {
    for (const ext of MEDIA_EXTS) {
      expect(INGESTABLE_EXTS.has(ext)).toBe(false);
      expect(parserRouteForExt(ext)).toBe('none');
    }
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

  it('routes modern Excel to exceljs and the legacy binaries to the converter', () => {
    expect(parserRouteForExt('xlsx')).toBe('exceljs');
    expect(parserRouteForExt('xls')).toBe('legacy-sheet');
    expect(parserRouteForExt('xlsm')).toBe('exceljs');
    expect(parserRouteForExt('xlsb')).toBe('legacy-sheet');
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

  it('routes .xml to tika rather than leaving it unreadable', () => {
    // Regression guard. `.xml` used to route to `none`, so an upload was
    // indexed by its filename alone — the same silent-nothing `.mpp` had, for a
    // plainly readable format. Tika strips markup and keeps content.
    expect(parserRouteForExt('xml')).toBe('tika');
    expect(mimeForExt('xml')).toBe('application/xml; charset=utf-8');
  });

  it('keeps .xml out of TEXT_EXTS', () => {
    // As text the body would be copied into data.content and the summary,
    // embedding and chunks would be dominated by tag names — retrieval would
    // degrade while appearing to work.
    expect(TEXT_EXTS.has('xml')).toBe(false);
  });

  it('returns "none" for unknown / opaque-binary extensions', () => {
    // Images and unknown types fall through; the extractor records
    // skipped:no_text_layer rather than chasing them.
    for (const ext of ['png', 'jpg', 'gif', 'mp3', 'mp4', 'zip', 'exe', '']) {
      expect(parserRouteForExt(ext)).toBe('none');
    }
  });
});

describe('exportHintForExt', () => {
  it('names Microsoft Project plans and the export that fixes them', () => {
    const hint = exportHintForExt('mpp');
    expect(hint).toBeDefined();
    // The value of this entry is entirely in what it tells the user to DO —
    // a refusal that doesn't name the recovery move is the thing it replaced.
    expect(hint).toMatch(/Save As/i);
    expect(hint).toMatch(/XML/);
  });

  it('covers Project templates too', () => {
    expect(exportHintForExt('mpt')).toMatch(/XML/);
  });

  it('is case-insensitive — Windows hands us .MPP', () => {
    expect(exportHintForExt('MPP')).toBe(exportHintForExt('mpp'));
  });

  it('stays silent for everything the parser ladder actually handles', () => {
    // A false positive here would BLOCK a readable format at ingest, which is
    // far worse than the silence this feature replaced.
    for (const ext of [...INGESTABLE_EXTS, 'png', 'jpg', 'svg', 'xml', '']) {
      expect(exportHintForExt(ext), `${ext} must stay readable`).toBeUndefined();
    }
  });

  it('does not overlap the parser routing table', () => {
    for (const ext of EXPORT_REQUIRED_EXTS.keys()) {
      expect(parserRouteForExt(ext)).toBe('none');
    }
  });
});

describe('isVisionImage (ext routing beats client-supplied mime)', () => {
  it('a DWG upload claiming image/vnd.dwg stays on the dwg route, never vision', () => {
    // The replayed defect: the upload request's mime sent the CAD binary to
    // the vision worker → empty read → terminal no_vision_text skip.
    expect(isVisionImage('dwg', 'image/vnd.dwg')).toBe(false);
  });

  it('no ingestable extension ever routes to vision, whatever the mime claims', () => {
    for (const ext of INGESTABLE_EXTS) {
      expect(isVisionImage(ext, 'image/png'), `${ext} must keep its parser route`).toBe(false);
    }
  });

  it('real images route to vision by mime or by extension', () => {
    expect(isVisionImage('png', 'image/png')).toBe(true);
    expect(isVisionImage('png', 'application/octet-stream')).toBe(true);
    // Email attachments: no usable extension, truth in data.mimeType.
    expect(isVisionImage('', 'image/jpeg')).toBe(true);
  });

  it('unrouted non-images stay off the vision path', () => {
    expect(isVisionImage('bin', 'application/octet-stream')).toBe(false);
  });
});
