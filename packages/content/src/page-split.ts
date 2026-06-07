/**
 * page-split — the pure, deterministic core of `page_split` (Phase 4b). Given a
 * ProseMirror page document, partition it into an intro plus one section per
 * top-level heading of a chosen level. The heading's text becomes the section
 * title; the blocks under it (until the next heading of that level) become the
 * section body — the heading block itself is NOT repeated in the body, since it
 * lives on as the child page's title.
 *
 * Byte-faithful: every non-heading block is carried through verbatim (same
 * object references), so the split redistributes content without rewriting it.
 * DB-free + side-effect-free, so it's unit-testable and safe to call anywhere;
 * `splitPage` in pages.ts wraps it with the page creation + draft write.
 */

type PMNode = {
  type?: string;
  attrs?: Record<string, unknown> | null;
  content?: PMNode[];
  text?: string;
};

/** Heading level to split on: h1 (top-level sections) or h2 (subsections). */
export type SplitLevel = 1 | 2;

export type SplitSection = {
  /** Plain-text heading, used as the child page title. */
  title: string;
  /** The blocks under the heading (verbatim), the child page body. */
  blocks: PMNode[];
};

export type SplitResult = {
  /** Blocks before the first split heading — kept on the parent if requested. */
  intro: PMNode[];
  sections: SplitSection[];
};

/** Plain text of a node — concatenate descendant text nodes, trimmed. */
export function headingText(node: PMNode): string {
  let out = '';
  const walk = (n: PMNode) => {
    if (typeof n.text === 'string') out += n.text;
    for (const c of n.content ?? []) walk(c);
  };
  walk(node);
  return out.trim();
}

function isSplitHeading(n: PMNode, level: SplitLevel): boolean {
  return n.type === 'heading' && Number(n.attrs?.level) === level;
}

/**
 * Partition a doc into an intro + one section per top-level heading of `level`.
 * Only TOP-LEVEL blocks are inspected (nested headings inside callouts/columns
 * stay with their container). A section runs from its heading until the next
 * heading of the same level (or end of doc).
 */
export function splitDocByHeading(
  doc: Record<string, unknown>,
  level: SplitLevel,
): SplitResult {
  const blocks = ((doc as PMNode).content ?? []) as PMNode[];
  const intro: PMNode[] = [];
  const sections: SplitSection[] = [];
  let current: SplitSection | null = null;

  for (const b of blocks) {
    if (isSplitHeading(b, level)) {
      current = { title: headingText(b) || 'Untitled', blocks: [] };
      sections.push(current);
    } else if (current) {
      current.blocks.push(b);
    } else {
      intro.push(b);
    }
  }

  return { intro, sections };
}
