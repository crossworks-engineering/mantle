/**
 * Document → plain text, dispatched by extension. The single place that knows
 * which parser handles which format, shared by the extractor (durable index)
 * and the conversational attachment helper (live answer) so document handling
 * stays identical wherever a file enters.
 *
 * Throws on a parser failure (encrypted / scanned / corrupt) so callers can
 * tell a real failure apart from an unsupported or genuinely-empty file.
 * Returns '' for an extension we don't extract text from (e.g. an image —
 * those go through the vision path, not here).
 */

import { TEXT_EXTS } from './slug';

export async function parseDocumentBytes(bytes: Buffer, ext: string): Promise<string> {
  if (ext === 'pdf') return (await import('./pdf')).parsePdf(bytes);
  if (ext === 'docx') return (await import('./docx')).parseDocx(bytes);
  if (ext === 'xlsx' || ext === 'xls') return (await import('./xlsx')).parseXlsx(bytes);
  if (TEXT_EXTS.has(ext)) return bytes.toString('utf8');
  return '';
}
