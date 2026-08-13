/**
 * buildPageToc — extract a navigable outline from a page's ProseMirror JSON:
 * headings (h1–h3) and sub-page cards (childPage), in document order. Pure +
 * leaf (no DB import) so both the client editor and the server-rendered public
 * page can build the same outline, and it's unit-testable.
 *
 * Indentation (`depth`):
 *   - a heading sits at `level - 1` (h1 → 0, h2 → 1, h3 → 2);
 *   - a sub-page sits one level deeper than the heading section it falls under
 *     (i.e. `depth = lastHeadingLevel`; 0 when it precedes any heading), so
 *     sub-pages nest visually inside their section.
 *
 * Each entry carries the block's stable `attrs.id`, which both surfaces use to
 * jump to it (the editor resolves it to a node; the public page anchors to an
 * element with that id).
 */

type PMNode = {
  type?: string;
  attrs?: Record<string, unknown> | null;
  text?: string;
  content?: PMNode[];
};

export interface TocEntry {
  /** The block's stable id (jump target). */
  id: string;
  kind: 'heading' | 'page';
  /** Heading level 1–3; for a sub-page, the level of the section it sits in. */
  level: number;
  /** Indentation depth for rendering (0 = flush). */
  depth: number;
  label: string;
}

/** Concatenate the visible text of a node's inline children (headings only
 *  hold inline content). Trimmed; empty → ''. */
function inlineText(node: PMNode): string {
  let out = '';
  for (const child of node.content ?? []) {
    if (typeof child.text === 'string') out += child.text;
    else if (child.content) out += inlineText(child);
  }
  return out.trim();
}

export function buildPageToc(doc: unknown): TocEntry[] {
  if (!doc || typeof doc !== 'object') return [];
  const entries: TocEntry[] = [];
  let lastHeadingLevel = 0;

  const walk = (node: PMNode) => {
    const id = typeof node.attrs?.id === 'string' ? node.attrs.id : null;

    if (node.type === 'heading' && id) {
      const level = Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 3);
      lastHeadingLevel = level;
      const label = inlineText(node);
      entries.push({
        id,
        kind: 'heading',
        level,
        depth: level - 1,
        label: label || 'Untitled heading',
      });
      return; // headings don't nest TOC-relevant children
    }

    if (node.type === 'childPage' && id) {
      const title =
        typeof node.attrs?.title === 'string' && node.attrs.title
          ? node.attrs.title
          : 'Untitled page';
      entries.push({
        id,
        kind: 'page',
        level: lastHeadingLevel,
        depth: lastHeadingLevel,
        label: title,
      });
      return;
    }

    for (const child of node.content ?? []) walk(child);
  };

  walk(doc as PMNode);
  return entries;
}
