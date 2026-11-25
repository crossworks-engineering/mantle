/**
 * The text of a code, script, config or log file (CODE_EXTS, ./slug.ts),
 * read in this process: decoding a string is not parsing. One guard: bytes
 * that are not text (a NUL in the head, as git decides) are refused with the
 * reader's typed verdict, so a renamed binary is never indexed as garbage.
 * The extract records it as `document_unreadable` and the file stays
 * findable by its name.
 *
 * Windows tools write some of these as UTF-16 LE with a byte-order mark
 * (PowerShell, `.reg`, some logs): decoded as that. A UTF-8 mark is dropped.
 */

/** Bytes looked at for a NUL, as git does (its `buffer_is_binary`). */
export const CODE_SNIFF_BYTES = 8000;

/** The text of the bytes, or null when they are not text. Pure. */
export function codeTextOf(bytes: Buffer): string | null {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  const utf8Mark = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = utf8Mark ? bytes.subarray(3) : bytes;
  if (body.subarray(0, CODE_SNIFF_BYTES).includes(0)) return null;
  return body.toString('utf8');
}

/** The text of a code file, or the reader's typed verdict when its bytes
 *  are not text. */
export async function readCodeText(bytes: Buffer, ext: string): Promise<string> {
  const text = codeTextOf(bytes);
  if (text !== null) return text;
  const { ParserError } = await import('./parser-client');
  throw new ParserError(
    'unsupported',
    `The file is named .${ext} but its bytes are not text (a renamed binary file?)`,
    { retryable: false, terminal: false },
  );
}
