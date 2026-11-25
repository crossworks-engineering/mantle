/**
 * Code, config and logs read as text (./code-text.ts, CODE_EXTS): the text
 * of the file through the one entry (parse.ts) and the parser's own
 * (read-document.ts), and the binary guard: bytes that are not text are the
 * reader's typed verdict, never indexed as garbage. Made-up bytes only.
 */
import { describe, expect, it } from 'vitest';
import { codeTextOf, CODE_SNIFF_BYTES } from './code-text';
import { parseDocumentBytes } from './parse';
import { isParserError } from './parser-client';
import { readDocumentText } from './read-document';

const PY = [
  '"""Pump seal checks, made up for the test."""',
  '',
  'def seal_ok(pressure_bar: float) -> bool:',
  '    # P-101 seal holds up to 16 bar',
  '    return pressure_bar <= 16.0',
  '',
].join('\n');

describe('codeTextOf', () => {
  it('gives UTF-8 text as it is', () => {
    expect(codeTextOf(Buffer.from(PY))).toBe(PY);
    expect(codeTextOf(Buffer.from('naïve = "café"\n'))).toBe('naïve = "café"\n');
  });

  it('drops a UTF-8 byte-order mark', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('[pump]\nid=1\n')]);
    expect(codeTextOf(bytes)).toBe('[pump]\nid=1\n');
  });

  it('decodes UTF-16 LE with its mark (PowerShell, .reg)', () => {
    const text = 'Write-Host "P-101"\r\n';
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    expect(codeTextOf(bytes)).toBe(text);
  });

  it('refuses bytes with a NUL in the head: a renamed binary', () => {
    expect(codeTextOf(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x00, 0x00]))).toBeNull();
    // MPEG transport stream (.ts video): sync bytes and NULs.
    const ts = Buffer.alloc(188 * 4, 0);
    for (let i = 0; i < ts.length; i += 188) ts[i] = 0x47;
    expect(codeTextOf(ts)).toBeNull();
  });

  it('looks at the head only, as git does', () => {
    const late = Buffer.concat([Buffer.alloc(CODE_SNIFF_BYTES, 0x61), Buffer.from([0])]);
    expect(codeTextOf(late)).not.toBeNull();
  });

  it('gives an empty file as empty text', () => {
    expect(codeTextOf(Buffer.alloc(0))).toBe('');
  });
});

describe('a code file through the one entry', () => {
  it('parseDocumentBytes gives its text, no parser asked', async () => {
    await expect(parseDocumentBytes(Buffer.from(PY), 'py')).resolves.toBe(PY);
    await expect(parseDocumentBytes(Buffer.from('select 1;\n'), 'SQL')).resolves.toBe(
      'select 1;\n',
    );
  });

  it('a binary under a code name is the typed verdict, not text', async () => {
    const err = await parseDocumentBytes(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]), 'py').catch(
      (e: unknown) => e,
    );
    expect(isParserError(err)).toBe(true);
    expect(err).toMatchObject({ code: 'unsupported', retryable: false, terminal: false });
    expect((err as Error).message).toMatch(/named \.py but its bytes are not text/);
  });

  it("the parser's own read agrees", async () => {
    await expect(readDocumentText(Buffer.from(PY), 'py')).resolves.toBe(PY);
    await expect(readDocumentText(Buffer.from([0, 1, 2]), 'tsx')).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});
