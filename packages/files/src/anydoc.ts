/**
 * anydoc: the reader for the formats Tika used to own: legacy Word (.doc),
 * PowerPoint (.ppt, and the .pptx fallback), LibreOffice native
 * (.odt/.ods/.odp), Rich Text (.rtf), e-books (.epub) and the legacy sheets
 * (.xls/.xlsb, via ./legacy-sheet.ts). Runs in the parser service
 * (server/parser) only: a native addon reading untrusted bytes belongs in the
 * container whose memory limit the OS enforces.
 *
 * anydoc is a Rust library (Firecrawl, MIT) loaded as a native Node addon: no
 * JVM, no network. Output is GitHub Markdown, so headings, lists and tables
 * survive as structure the chunker can use.
 *
 * **Bytes never leave the box.** The package can send a scanned PDF to
 * Firecrawl's hosted OCR, but only when asked with `ocr: 'hosted'`. We never
 * pass options, so the default (`reject`) holds, and we never route a PDF
 * here: pdf-parse and the vision OCR tier own PDFs.
 *
 * Throws on a failed conversion, like the other readers, so the caller can
 * tell a real failure (encrypted, malformed) apart from an empty document.
 * The error carries anydoc's `code` (`unsupported`, `malformed`,
 * `encrypted`, `missingPart`), except `resourceLimit`, which becomes a
 * {@link DocumentTooLargeError} (the parser's `too_large`).
 */

import {
  toDocument,
  toMarkdownBytes,
  type Asset,
  type Block,
  type Format,
  type Inline,
} from '@firecrawl/anydoc';
import { errorMessage } from '@mantle/std';
import { DocumentTooLargeError } from './read-limit';
import type { EmbeddedImage } from './embedded-images';

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

/** anydoc's `resourceLimit` as a {@link DocumentTooLargeError}; any other
 *  error unchanged. The embedded-media budget gets its own wording, because
 *  the fix there is different (the text is fine, the pictures are not). */
function limitOr(err: unknown): unknown {
  if ((err as { code?: unknown } | null)?.code !== 'resourceLimit') return err;
  const detail = errorMessage(err);
  return new DocumentTooLargeError(
    /asset/i.test(detail)
      ? `The document's embedded pictures and objects are past the reader's budget (${detail}), so its text could not be read.`
      : `The document is past one of the reader's safety limits (${detail}).`,
  );
}

/** The document as Markdown. Throws on a failed conversion (see above). */
export async function parseAnydocBytes(bytes: Buffer, ext: string): Promise<string> {
  try {
    return (await toMarkdownBytes(bytes, formatFor(ext))).trim();
  } catch (err) {
    throw limitOr(err);
  }
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

/** A sheet anydoc read but the caller refused for its size, by name, with
 *  its rectangle: kept so the refusal can say which sheet and why. */
export type RefusedSheet = { name: string; rows: number; cols: number };

/**
 * The sheets of a legacy workbook, for ./legacy-sheet.ts to rebuild as a real
 * `.xlsx`. anydoc gives a heading (the sheet name) before each sheet's table;
 * a single-sheet workbook may come without one. A covered cell (inside a
 * merge) reads as empty, so columns never shift. Throws like
 * {@link parseAnydocBytes}.
 *
 * `maxCells` bounds each sheet's rectangle (rows x widest row) BEFORE any
 * row is copied out: a sheet past it is listed in `refused`, not read. A
 * workbook holding A1 and GR10000 is a 10,000 x 200 grid of empty strings
 * otherwise, and the rebuild after it is where the time and memory went.
 */
export async function anydocSheets(
  bytes: Buffer,
  ext: string,
  maxCells = Number.POSITIVE_INFINITY,
): Promise<{ sheets: AnydocSheet[]; refused: RefusedSheet[] }> {
  let doc;
  try {
    doc = await toDocument(bytes, formatFor(ext));
  } catch (err) {
    throw limitOr(err);
  }
  const sheets: AnydocSheet[] = [];
  const refused: RefusedSheet[] = [];
  let pendingName: string | null = null;
  for (const block of doc.blocks) {
    const kind: string = block.kind;
    if (kind === 'heading') {
      pendingName = inlineText(block.content) || null;
      continue;
    }
    if (kind !== 'table' || !block.table) continue;
    const name = pendingName ?? `Sheet${sheets.length + refused.length + 1}`;
    pendingName = null;
    const grid = block.table.grid;
    let cols = 0;
    for (const row of grid) cols = Math.max(cols, row.length);
    if (grid.length * cols > maxCells) {
      refused.push({ name, rows: grid.length, cols });
      continue;
    }
    const rows = grid.map((row) =>
      row.map((slot) => {
        const slotKind: string = slot.kind;
        return slotKind === 'origin' && slot.cell ? blocksText(slot.cell.blocks) : '';
      }),
    );
    sheets.push({ name, rows });
  }
  return { sheets, refused };
}

/** Where anydoc found each image: walked in reading order so `ordinal`
 *  follows the document, as the other image extractors do. */
type AssetRef = { assetId: number; alt?: string; heading?: string };

function collectImageRefs(blocks: Block[], refs: AssetRef[], ctx: { heading?: string }): void {
  const fromInlines = (inlines: Inline[] | undefined) => {
    for (const inline of inlines ?? []) {
      const kind: string = inline.kind;
      if (kind === 'image') {
        const source = inline.source;
        const sourceKind: string | undefined = source?.kind;
        if (sourceKind === 'asset' && source?.assetId != null) {
          refs.push({
            assetId: source.assetId,
            ...(inline.alt?.trim() ? { alt: inline.alt.trim() } : {}),
            ...(ctx.heading ? { heading: ctx.heading } : {}),
          });
        }
      }
      if (inline.content) fromInlines(inline.content);
    }
  };
  for (const block of blocks) {
    const kind: string = block.kind;
    if (kind === 'heading') {
      const text = inlineText(block.content);
      if (text) ctx.heading = text;
    }
    fromInlines(block.content);
    if (block.blocks) collectImageRefs(block.blocks, refs, ctx);
    for (const item of block.list?.items ?? []) collectImageRefs(item.blocks, refs, ctx);
    for (const row of block.table?.grid ?? []) {
      for (const slot of row) if (slot.cell) collectImageRefs(slot.cell.blocks, refs, ctx);
    }
  }
}

/**
 * The pictures anydoc carries in its document model (`Document.assets`), in
 * reading order: each image the text places, then any picture asset the text
 * never places (a slide background, a picture in a part anydoc does not
 * lay out). Alt text and the nearest heading come along for the titles.
 * Non-image assets (OLE payloads) are left out. Throws like
 * {@link parseAnydocBytes}.
 */
export async function anydocImages(bytes: Buffer, ext: string): Promise<EmbeddedImage[]> {
  let doc;
  try {
    doc = await toDocument(bytes, formatFor(ext));
  } catch (err) {
    throw limitOr(err);
  }
  const { describeImageBytes } = await import('./embedded-images');
  const byId = new Map<number, Asset>(doc.assets.map((a) => [a.id, a]));
  const refs: AssetRef[] = [];
  collectImageRefs(doc.blocks, refs, {});
  const placed = new Set(refs.map((r) => r.assetId));
  for (const a of doc.assets) if (!placed.has(a.id)) refs.push({ assetId: a.id });

  const out: EmbeddedImage[] = [];
  const emitted = new Set<number>();
  for (const ref of refs) {
    const asset = byId.get(ref.assetId);
    if (!asset || emitted.has(ref.assetId) || !asset.mediaType.startsWith('image/')) continue;
    emitted.add(ref.assetId);
    const data = Buffer.from(asset.data);
    if (data.length === 0) continue;
    const fallbackExt = asset.mediaType.slice('image/'.length).replace(/^(x-|vnd\.)/, '');
    out.push({
      bytes: data,
      ordinal: out.length + 1,
      ...describeImageBytes(data, fallbackExt),
      ...(ref.alt ? { altText: ref.alt } : {}),
      ...(ref.heading ? { heading: ref.heading } : {}),
    });
  }
  return out;
}
