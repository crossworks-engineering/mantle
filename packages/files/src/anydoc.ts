/**
 * anydoc: the in-process reader for the formats Tika used to own: legacy
 * Word (.doc), PowerPoint (.ppt, and the .pptx fallback), LibreOffice native
 * (.odt/.ods/.odp), Rich Text (.rtf), e-books (.epub) and the legacy sheets
 * (.xls/.xlsb, via ./legacy-sheet.ts).
 *
 * anydoc is a Rust library (Firecrawl, MIT) loaded as a native Node addon: no
 * JVM, no container, no network. A parse takes milliseconds in the calling
 * process, where Tika took a forked JVM, an HTTP hop and a queue of one.
 * Output is GitHub Markdown, so headings, lists and tables survive as
 * structure the chunker can use (Tika gave flat text).
 *
 * **Bytes never leave the box.** The package can send a scanned PDF to
 * Firecrawl's hosted OCR, but only when asked with `ocr: 'hosted'`. We never
 * pass options, so the default (`reject`) holds, and we never route a PDF
 * here: pdf-parse and the vision OCR tier own PDFs.
 *
 * Throws on a failed conversion, like the other in-process parsers, so the
 * caller can tell a real failure (encrypted, malformed) apart from an empty
 * document. The error carries anydoc's `code` (`unsupported`, `malformed`,
 * `encrypted`, `resourceLimit`, `missingPart`).
 */

import {
  toDocument,
  toMarkdownBytes,
  type Block,
  type Format,
  type Inline,
} from '@firecrawl/anydoc';

/** Our extension → anydoc's format. Explicit rather than anydoc's own
 *  `formatFromExtension`, so a format we have not tested never reaches it.
 *  anydoc's enums are `const enum`s, which `isolatedModules` cannot read, so
 *  the values are their string forms. */
const FORMAT_FOR_EXT: Record<string, string> = {
  doc: 'doc',
  ppt: 'ppt',
  pptx: 'pptx',
  odt: 'odt',
  ods: 'ods',
  odp: 'odp',
  rtf: 'rtf',
  epub: 'epub',
  // anydoc's spreadsheet reader takes the binary BIFF and XLSB records too.
  xls: 'xlsx',
  xlsb: 'xlsx',
};

function formatFor(ext: string): Format {
  const format = FORMAT_FOR_EXT[ext.toLowerCase()];
  if (!format) throw new Error(`anydoc: no format for .${ext}`);
  return format as Format;
}

/** The document as Markdown. Throws on a failed conversion (see above). */
export async function parseAnydocBytes(bytes: Buffer, ext: string): Promise<string> {
  return (await toMarkdownBytes(bytes, formatFor(ext))).trim();
}

/** One sheet of a legacy workbook: its name and a rectangle of cell text. */
export type AnydocSheet = { name: string; rows: string[][] };

function inlineText(inlines: Inline[] | undefined): string {
  return (inlines ?? [])
    .map((i) => i.text ?? inlineText(i.content))
    .join('')
    .trim();
}

function blocksText(blocks: Block[]): string {
  return blocks
    .map((b) => (b.content ? inlineText(b.content) : b.blocks ? blocksText(b.blocks) : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * The sheets of a legacy workbook, for ./legacy-sheet.ts to rebuild as a real
 * `.xlsx`. anydoc gives a heading (the sheet name) before each sheet's table;
 * a single-sheet workbook may come without one. A covered cell (inside a
 * merge) reads as empty, so columns never shift. Throws like
 * {@link parseAnydocBytes}.
 */
export async function anydocSheets(bytes: Buffer, ext: string): Promise<AnydocSheet[]> {
  const doc = await toDocument(bytes, formatFor(ext));
  const sheets: AnydocSheet[] = [];
  let pendingName: string | null = null;
  for (const block of doc.blocks) {
    const kind: string = block.kind;
    if (kind === 'heading') {
      pendingName = inlineText(block.content) || null;
      continue;
    }
    if (kind !== 'table' || !block.table) continue;
    const rows = block.table.grid.map((row) =>
      row.map((slot) => {
        const slotKind: string = slot.kind;
        return slotKind === 'origin' && slot.cell ? blocksText(slot.cell.blocks) : '';
      }),
    );
    sheets.push({ name: pendingName ?? `Sheet${sheets.length + 1}`, rows });
    pendingName = null;
  }
  return sheets;
}
