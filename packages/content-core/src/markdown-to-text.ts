/**
 * markdownToPlainText: the words of a rich-markdown text with every mark
 * gone, on one line. For places that show a reply where nothing renders
 * markdown: a push notification's lock-screen line, a list preview.
 *
 * It reads the text with the SAME parser the rest of the brain uses for the
 * dialect (`markdownToDoc`: GFM plus callouts, columns, highlights, math and
 * the reference chips), then keeps the words:
 *
 *   headings, bold, italic, strike, highlight, colour   the text
 *   a link, a reference chip (`page:`, `media:`,
 *     `mention:`, `folder:`, `draw:`)                   its label, never its target
 *   an image or an embedded drawing                     its alt text, else nothing
 *   inline code and a code fence                        the code text (a short
 *                                                       command is the useful part)
 *   lists, block quotes, callouts, columns              their text, no markers
 *   a table                                             its cell text
 *   math                                                its source, no `$`
 *   a rule, a diagram, a folder index                   nothing
 *
 * Pure and browser-safe (only `marked`, through markdownToDoc). Never throws:
 * a text the parser cannot read comes back with its whitespace collapsed.
 */
import { markdownToDoc } from './markdown-to-doc';

type PMNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
};

/** How much of a text is read: a preview needs its start only. */
const READ_MAX = 4000;

/** What a childless node (a chip, an image, math) says, in this order. */
const LABEL_KEYS = ['label', 'title', 'alt', 'name', 'filename', 'latex'];

/** Nodes that say nothing in a preview. `diagram` holds source code of a
 *  picture; `folderIndex` is a live list, none of it this text's own words. */
const SILENT = new Set(['horizontalRule', 'diagram', 'folderIndex']);

function render(node: PMNode | null | undefined, out: string[]): void {
  if (!node || typeof node !== 'object') return;
  if (node.type && SILENT.has(node.type)) return;
  if (typeof node.text === 'string') {
    out.push(node.text);
    return;
  }
  if (node.type === 'hardBreak') {
    out.push(' ');
    return;
  }
  const kids = Array.isArray(node.content) ? node.content : [];
  if (kids.length === 0) {
    const attrs = node.attrs ?? {};
    for (const key of LABEL_KEYS) {
      const v = attrs[key];
      if (typeof v === 'string' && v.trim()) {
        out.push(v);
        break;
      }
    }
    out.push(' ');
    return;
  }
  for (const k of kids) render(k, out);
  // Every node with children is a block or a wrapper: its text never runs
  // into what follows.
  out.push(' ');
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The words of `source` on one line; '' when it has none. */
export function markdownToPlainText(source: string): string {
  if (typeof source !== 'string' || !source.trim()) return '';
  const text = source.length > READ_MAX ? source.slice(0, READ_MAX) : source;
  try {
    const out: string[] = [];
    render(markdownToDoc(text) as PMNode, out);
    // Raw HTML the dialect does not map arrives as text: drop the tags.
    return oneLine(out.join('').replace(/<\/?[a-zA-Z][^<>]*>/g, ' '));
  } catch {
    return oneLine(text);
  }
}

/**
 * A preview line: the plain words of `source`, cut to `max` characters with
 * an ellipsis. '' when the text has no words (the caller says something
 * generic instead: a preview is never empty and never raw markdown).
 */
export function markdownPreview(source: string, max = 140): string {
  const plain = markdownToPlainText(source);
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}
