/**
 * ProseMirror-JSON → Word (.docx) renderer. A FIFTH representation of the page
 * schema (alongside the TipTap editor, `markdownToDoc`, the public-page
 * `renderPageDoc`, and the email renderer `render-page-email.ts`). Word needs
 * its own renderer because the output is an OOXML document, not HTML: text is
 * built from `docx` `TextRun`/`Paragraph` objects, lists use real Word
 * numbering, and tables/images are native document parts.
 *
 * Notes (stored as markdown) reach this renderer by first going through
 * `markdownToDoc` — so one renderer covers both Pages and Notes. The same
 * `.docx` opens faithfully in Word, Google Docs, and LibreOffice Writer, so we
 * don't need a separate ODF (.odt) path.
 *
 * Pure-ish: the only side effect is `opts.loadImage`, an injected callback the
 * caller wires to `@mantle/files` so this package needn't depend on the file
 * store. Anything it can't map degrades to a paragraph rather than throwing.
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IParagraphOptions,
  type ParagraphChild,
} from 'docx';

type PMMark = { type?: string; attrs?: Record<string, unknown> };
type PMNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: PMMark[];
  content?: PMNode[];
};

export type LoadedImage = { bytes: Buffer };

export type RenderDocxOptions = {
  /** Rendered as the document title (large bold heading) above the body. */
  title?: string;
  /** Resolve a page-image file id to its bytes so it can be embedded. Injected
   *  by the caller (web route / export tool) from `@mantle/files`; when absent
   *  or it returns null, the image degrades to its alt text. */
  loadImage?: (fileId: string) => Promise<LoadedImage | null>;
};

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

const CALLOUT_FILL: Record<string, string> = {
  info: 'EFF6FF',
  success: 'F0FDF4',
  warning: 'FFFBEB',
  danger: 'FEF2F2',
};
// Concrete colours for the themed chart-N tokens (Word has no CSS vars).
const CHART_HEX: Record<string, string> = {
  'chart-1': '2563EB',
  'chart-2': '16A34A',
  'chart-3': 'D97706',
  'chart-4': 'DB2777',
  'chart-5': '7C3AED',
};
const ASIDE_FILL = 'F3F4F6';
const CONTENT_PX = 600; // ~ usable body width at 96dpi for image scaling

// ─── inline (marks) ───────────────────────────────────────────────────────

type RunOptions = Exclude<ConstructorParameters<typeof TextRun>[0], string>;

function runsFromText(node: PMNode): ParagraphChild[] {
  const text = node.text ?? '';
  const opts: Record<string, unknown> = { text };
  let href: string | null = null;
  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case 'bold':
        opts.bold = true;
        break;
      case 'italic':
        opts.italics = true;
        break;
      case 'strike':
        opts.strike = true;
        break;
      case 'code':
        opts.font = 'Consolas';
        opts.shading = { type: ShadingType.CLEAR, fill: 'F3F4F6' };
        break;
      case 'highlight':
        opts.highlight = 'yellow';
        break;
      case 'textColor': {
        const hex = CHART_HEX[str(mark.attrs?.color)];
        if (hex) opts.color = hex;
        break;
      }
      case 'link': {
        const h = str(mark.attrs?.href).trim();
        if (/^(https?:|mailto:)/i.test(h)) href = h;
        break;
      }
    }
  }
  if (href) {
    // Hyperlinks get the conventional blue underline via the built-in style.
    opts.style = 'Hyperlink';
    const run = new TextRun(opts as unknown as RunOptions);
    return [new ExternalHyperlink({ children: [run], link: href })];
  }
  return [new TextRun(opts as unknown as RunOptions)];
}

function inlineChildren(nodes: PMNode[] | undefined): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  for (const n of nodes ?? []) {
    if (n.type === 'text') out.push(...runsFromText(n));
    else if (n.type === 'hardBreak') out.push(new TextRun({ break: 1 }));
    else if (n.type === 'inlineMath')
      out.push(new TextRun({ text: str(n.attrs?.latex), font: 'Consolas' }));
    else if (n.type === 'mention')
      out.push(new TextRun({ text: str(n.attrs?.label) || str(n.attrs?.id), color: '2563EB' }));
    else if (n.content) out.push(...inlineChildren(n.content));
  }
  return out;
}

// ─── numbering (ordered lists) ─────────────────────────────────────────────

type NumberingConfigItem = NonNullable<
  NonNullable<ConstructorParameters<typeof Document>[0]['numbering']>['config']
>[number];

/** A mutable accumulator threaded through the walk: each ordered list gets its
 *  own numbering instance so separate lists restart at 1 instead of continuing. */
class DocxCtx {
  olConfigs: NumberingConfigItem[] = [];
  readonly images: Map<string, LoadedImage | null>;
  private olSeq = 0;
  constructor(images: Map<string, LoadedImage | null>) {
    this.images = images;
  }
  /** Register a fresh ordered-list numbering instance and return its reference. */
  newOrderedRef(): string {
    const reference = `mantle-ol-${this.olSeq++}`;
    const formats = [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN];
    const levels = Array.from({ length: 6 }, (_, level) => ({
      level,
      format: formats[level % formats.length]!,
      text: `%${level + 1}.`,
      alignment: AlignmentType.LEFT,
    }));
    this.olConfigs.push({ reference, levels });
    return reference;
  }
}

// ─── blocks ─────────────────────────────────────────────────────────────────

const HEADING_BY_LEVEL = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
];

type DocxBlock = Paragraph | Table;

function listItems(
  node: PMNode,
  ordered: boolean,
  level: number,
  ctx: DocxCtx,
  ref: string | null,
): DocxBlock[] {
  const out: DocxBlock[] = [];
  const reference = ordered ? ref ?? ctx.newOrderedRef() : null;
  for (const item of node.content ?? []) {
    if (item.type !== 'listItem' && item.type !== 'taskItem') continue;
    const checked = item.type === 'taskItem' ? Boolean(item.attrs?.checked) : null;
    let first = true;
    for (const child of item.content ?? []) {
      if (child.type === 'bulletList') {
        out.push(...listItems(child, false, level + 1, ctx, null));
      } else if (child.type === 'orderedList') {
        out.push(...listItems(child, true, level + 1, ctx, null));
      } else if (child.type === 'paragraph' || child.type === 'heading') {
        const listProps: Partial<IParagraphOptions> =
          checked !== null
            ? { indent: { left: 360 * (level + 1) } }
            : reference
              ? { numbering: { reference, level } }
              : { bullet: { level } };
        const children = inlineChildren(child.content);
        if (checked !== null && first) {
          children.unshift(new TextRun({ text: checked ? '☑ ' : '☐ ' }));
        }
        out.push(new Paragraph({ ...listProps, children }));
        first = false;
      } else {
        out.push(...renderBlocks([child], ctx));
      }
    }
  }
  return out;
}

function shadedBox(children: DocxBlock[], fill: string, borderColor: string): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: borderColor },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: borderColor },
      left: { style: BorderStyle.SINGLE, size: 4, color: borderColor },
      right: { style: BorderStyle.SINGLE, size: 4, color: borderColor },
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            shading: { type: ShadingType.CLEAR, fill },
            margins: { top: 100, bottom: 100, left: 150, right: 150 },
            children: children.length ? children : [new Paragraph({})],
          }),
        ],
      }),
    ],
  });
}

function gridCells(cellNodes: PMNode[], ctx: DocxCtx): TableCell[] {
  return cellNodes.map(
    (cell) =>
      new TableCell({
        shading:
          cell.type === 'tableHeader'
            ? { type: ShadingType.CLEAR, fill: 'F9FAFB' }
            : undefined,
        margins: { top: 40, bottom: 40, left: 80, right: 80 },
        children: (() => {
          const blocks = renderBlocks(cell.content, ctx);
          return blocks.length ? blocks : [new Paragraph({})];
        })(),
      }),
  );
}

function renderBlock(node: PMNode, ctx: DocxCtx): DocxBlock[] {
  switch (node.type) {
    case 'paragraph':
      return [new Paragraph({ children: inlineChildren(node.content) })];
    case 'heading': {
      const level = Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 4);
      return [
        new Paragraph({ heading: HEADING_BY_LEVEL[level - 1], children: inlineChildren(node.content) }),
      ];
    }
    case 'blockquote':
      // Indent + a left rule on each contained paragraph. Build the paragraphs
      // directly (docx paragraphs are immutable once constructed, so we can't
      // restyle the output of renderBlocks).
      return (node.content ?? []).map(
        (child) =>
          new Paragraph({
            indent: { left: 360 },
            border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'D1D5DB', space: 12 } },
            children: inlineChildren(child.content),
          }),
      );
    case 'bulletList':
      return listItems(node, false, 0, ctx, null);
    case 'orderedList':
      return listItems(node, true, 0, ctx, null);
    case 'taskList':
      return listItems(node, false, 0, ctx, null);
    case 'codeBlock': {
      const text = (node.content ?? []).map((c) => c.text ?? '').join('');
      return text.split('\n').map(
        (line, i) =>
          new Paragraph({
            shading: { type: ShadingType.CLEAR, fill: 'F6F8FA' },
            spacing: { before: i === 0 ? 80 : 0, after: 0 },
            children: [new TextRun({ text: line, font: 'Consolas', size: 20 })],
          }),
      );
    }
    case 'horizontalRule':
      return [
        new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'E5E7EB', space: 1 } },
          children: [],
        }),
      ];
    case 'blockMath':
      return [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: str(node.attrs?.latex), font: 'Consolas' })],
        }),
      ];
    case 'callout': {
      const variant = str(node.attrs?.variant);
      const fill = CALLOUT_FILL[variant] ?? CALLOUT_FILL.info!;
      const border =
        variant === 'success'
          ? '16A34A'
          : variant === 'warning'
            ? 'D97706'
            : variant === 'danger'
              ? 'DC2626'
              : '2563EB';
      return [shadedBox(renderBlocks(node.content, ctx), fill, border)];
    }
    case 'aside':
      return [shadedBox(renderBlocks(node.content, ctx), ASIDE_FILL, 'D1D5DB')];
    case 'columnList': {
      const cols = (node.content ?? []).filter((c) => c.type === 'column');
      if (cols.length === 0) return [];
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: noBorders(),
          rows: [
            new TableRow({
              children: cols.map(
                (c) =>
                  new TableCell({
                    margins: { left: 80, right: 80 },
                    children: (() => {
                      const b = renderBlocks(c.content, ctx);
                      return b.length ? b : [new Paragraph({})];
                    })(),
                  }),
              ),
            }),
          ],
        }),
      ];
    }
    case 'table': {
      const rows = (node.content ?? []).filter((r) => r.type === 'tableRow');
      if (rows.length === 0) return [];
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: rows.map(
            (r) => new TableRow({ children: gridCells(r.content ?? [], ctx) }),
          ),
        }),
      ];
    }
    case 'image': {
      const fileId = str(node.attrs?.nodeId);
      const alt = str(node.attrs?.alt);
      const loaded = fileId ? ctx.images.get(fileId) : null;
      if (loaded?.bytes) {
        const dims = imageInfo(loaded.bytes);
        if (dims) {
          const scale = dims.width > CONTENT_PX ? CONTENT_PX / dims.width : 1;
          return [
            new Paragraph({
              children: [
                new ImageRun({
                  data: loaded.bytes,
                  type: dims.type,
                  transformation: {
                    width: Math.round(dims.width * scale),
                    height: Math.round(dims.height * scale),
                  },
                } as never),
              ],
            }),
          ];
        }
      }
      return alt
        ? [new Paragraph({ children: [new TextRun({ text: `[image: ${alt}]`, italics: true })] })]
        : [];
    }
    case 'fileEmbed': {
      const name = str(node.attrs?.filename) || 'file';
      return [
        new Paragraph({
          shading: { type: ShadingType.CLEAR, fill: 'F3F4F6' },
          children: [new TextRun({ text: `📎 ${name}` })],
        }),
      ];
    }
    default:
      return node.content ? renderBlocks(node.content, ctx) : [];
  }
}

function noBorders() {
  const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  return { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none };
}

function renderBlocks(nodes: PMNode[] | undefined, ctx: DocxCtx): DocxBlock[] {
  const out: DocxBlock[] = [];
  for (const n of nodes ?? []) out.push(...renderBlock(n, ctx));
  return out;
}

// ─── image dimension probe (png / jpeg / gif) ───────────────────────────────

type DocxImageType = 'png' | 'jpg' | 'gif' | 'bmp';
function imageInfo(buf: Buffer): { width: number; height: number; type: DocxImageType } | null {
  if (buf.length < 24) return null;
  // PNG: 89 50 4E 47 … IHDR width/height at bytes 16..24 (big-endian)
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), type: 'png' };
  }
  // GIF: 'GIF8' … width/height little-endian at 6..10
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), type: 'gif' };
  }
  // BMP: 'BM' … width/height at 18..26 (little-endian)
  if (buf[0] === 0x42 && buf[1] === 0x4d) {
    return { width: buf.readInt32LE(18), height: buf.readInt32LE(22), type: 'bmp' };
  }
  // JPEG: FF D8 … scan SOF0/2 markers for dimensions
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = buf[off + 1]!;
      // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 carry dimensions.
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7), type: 'jpg' };
      }
      const segLen = buf.readUInt16BE(off + 2);
      if (segLen <= 0) break;
      off += 2 + segLen;
    }
  }
  return null;
}

/** Collect every page-image file id (in document order) so the caller can
 *  pre-load their bytes before rendering. Mirrors `referencedFileIds` but
 *  scoped to inline `image` nodes (the only ones docx embeds). */
function collectImageIds(node: PMNode | undefined, acc: string[]): void {
  if (!node) return;
  if (node.type === 'image') {
    const id = str(node.attrs?.nodeId);
    if (id) acc.push(id);
  }
  for (const c of node.content ?? []) collectImageIds(c, acc);
}

/**
 * Render a ProseMirror page document to a Word (.docx) file. Returns the OOXML
 * bytes ready to stream as a download or persist as a file node.
 */
export async function renderDocx(doc: unknown, opts: RenderDocxOptions = {}): Promise<Buffer> {
  const root = doc && typeof doc === 'object' ? (doc as PMNode) : { content: [] };

  // Pre-load image bytes (the walk is synchronous; image fetches are async).
  const ids: string[] = [];
  collectImageIds(root, ids);
  const images = new Map<string, LoadedImage | null>();
  if (opts.loadImage) {
    for (const id of ids) {
      if (images.has(id)) continue;
      try {
        images.set(id, await opts.loadImage(id));
      } catch {
        images.set(id, null);
      }
    }
  }

  const ctx = new DocxCtx(images);
  const body: DocxBlock[] = [];
  if (opts.title) {
    body.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: opts.title })] }));
  }
  body.push(...renderBlocks(root.content, ctx));
  if (body.length === 0) body.push(new Paragraph({}));

  const document = new Document({
    numbering: { config: ctx.olConfigs },
    sections: [{ children: body }],
  });
  return Packer.toBuffer(document);
}
