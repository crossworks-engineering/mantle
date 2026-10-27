/**
 * Document → plain text, dispatched by extension: the brain's one entry,
 * shared by the extractor (durable index) and the conversational attachment
 * helper (live answer) so document handling stays identical wherever a file
 * enters.
 *
 * Nothing here opens a document. Three routes:
 *   1. Plain text formats (TEXT_EXTS: txt, md, csv, json, yaml): decoded as
 *      UTF-8 in this process. Reading a string is not parsing.
 *   2. DWG and DXF: the parser's CAD tier, through ./dwg.ts (the one
 *      exchange the digest, the registry workbook and the render share).
 *   3. Every other readable format: the parser service (server/parser,
 *      packages/files/src/read-document.ts), through the one parser client.
 *
 * Throws on a failed read so callers can tell a real failure apart from a
 * genuinely-empty file: the parser client's typed ParserError
 * (./parser-client.ts), whose `retryable` and `terminal` say what to do
 * next. Returns '' for an extension no reader takes; the caller (the
 * extractor) treats '' as the honest "no_text_layer" / "no_parser" skip.
 */

import { INGESTABLE_EXTS, TEXT_EXTS } from './slug';

export async function parseDocumentBytes(bytes: Buffer, ext: string): Promise<string> {
  const e = ext.toLowerCase();
  if (TEXT_EXTS.has(e)) return bytes.toString('utf8');
  // AutoCAD DWG/DXF: a sniff miss returns '' (the hollow skip); a failed
  // exchange throws the parser's typed error.
  if (e === 'dwg' || e === 'dxf') {
    const { sniffDwg, sniffDxf, parseDwg, parseDxf } = await import('./dwg');
    if (e === 'dwg') return sniffDwg(bytes) ? parseDwg(bytes) : '';
    return sniffDxf(bytes) ? parseDxf(bytes) : '';
  }
  if (!INGESTABLE_EXTS.has(e)) return '';
  return (await import('./parser-client')).parserText(bytes, e);
}
