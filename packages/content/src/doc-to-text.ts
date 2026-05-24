/**
 * docToText — flatten a ProseMirror / TipTap JSON document to plaintext for
 * the brain (the extractor body source) and FTS. Lossy by design: it keeps
 * words, heading markers, and atom labels (mentions, image alt) and drops
 * styling. Defensive against arbitrary / unknown node types since the
 * editor's schema will grow over time.
 */

type PMNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
};

/** Block-level node types that should be separated by a newline. */
const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'code_block',
  'listItem',
  'list_item',
  'taskItem',
  'task_item',
  'bulletList',
  'orderedList',
  'taskList',
  'callout',
  'columnList',
  'column',
  'details',
  'detailsSummary',
  'detailsContent',
  'horizontalRule',
  'table',
  'tableRow',
  'tableCell',
  'tableHeader',
  'figure',
]);

/** Attribute keys, in priority order, that carry a human-readable label on
 *  childless atom nodes (mentions, images, file chips, math, emoji, youtube).
 *  `latex` surfaces formula source so the brain can index/recall equations;
 *  `src` surfaces an embed URL (e.g. a YouTube link) when nothing better. */
const LABEL_KEYS = ['label', 'title', 'alt', 'text', 'name', 'filename', 'latex', 'src'];

function render(node: PMNode | null | undefined): string {
  if (!node || typeof node !== 'object') return '';
  if (typeof node.text === 'string') return node.text;
  if (node.type === 'hardBreak' || node.type === 'hard_break') return '\n';

  const kids = Array.isArray(node.content) ? node.content : [];
  if (kids.length === 0) {
    // Atom node (mention, image, file chip, …) — surface a human label.
    const attrs = node.attrs ?? {};
    for (const key of LABEL_KEYS) {
      const v = attrs[key];
      if (typeof v === 'string' && v.trim()) return v;
    }
    return '';
  }

  let inner = '';
  for (const k of kids) {
    inner += render(k);
    if (k.type && BLOCK_TYPES.has(k.type)) inner += '\n';
  }

  if (node.type === 'heading') {
    const level = Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 6);
    return `${'#'.repeat(level)} ${inner.trim()}`;
  }
  // To-do items carry their state into the indexed text, so the brain can
  // tell "[x] booked flights" from "[ ] book flights".
  if (node.type === 'taskItem' || node.type === 'task_item') {
    return `${node.attrs?.checked ? '[x]' : '[ ]'} ${inner.trim()}`;
  }
  return inner;
}

/** Render a ProseMirror document object to plaintext. Returns '' for anything
 *  that isn't a non-null object. */
export function docToText(doc: unknown): string {
  if (!doc || typeof doc !== 'object') return '';
  return render(doc as PMNode)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
