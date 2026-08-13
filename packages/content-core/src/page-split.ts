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

export type ExtractResult = {
  /** Plain-text heading → the child page title. */
  title: string;
  /** The section body (blocks under the heading, until the boundary) — verbatim. */
  childBlocks: PMNode[];
  /** Top-level blocks before the heading (kept on the parent, verbatim). */
  before: PMNode[];
  /** Top-level blocks from the boundary onward (kept on the parent, verbatim). */
  after: PMNode[];
};

/**
 * Promote one section to a sub-page (Phase 4c). Locate the TOP-LEVEL heading
 * with the given block id; its section runs until the next heading of EQUAL OR
 * HIGHER level (i.e. level ≤ the heading's — an h2 section ends at the next h2
 * or h1), or end of doc. The heading text becomes the child title; the blocks
 * under it become the child body (the heading itself is not repeated). Returns
 * the surrounding blocks so the caller can splice a `childPage` card into the
 * parent where the section was.
 *
 * Returns null when the id doesn't resolve to a top-level heading (nested
 * headings inside callouts/columns aren't promotable this way).
 */
export function extractSection(
  doc: Record<string, unknown>,
  headingId: string,
): ExtractResult | null {
  const blocks = ((doc as PMNode).content ?? []) as PMNode[];
  const hi = blocks.findIndex(
    (b) => b.type === 'heading' && (b.attrs?.id as string | undefined) === headingId,
  );
  if (hi === -1) return null;

  const level = Number(blocks[hi]!.attrs?.level) || 1;
  let end = blocks.length;
  for (let i = hi + 1; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (b.type === 'heading' && (Number(b.attrs?.level) || 1) <= level) {
      end = i;
      break;
    }
  }

  return {
    title: headingText(blocks[hi]!) || 'Untitled',
    childBlocks: blocks.slice(hi + 1, end),
    before: blocks.slice(0, hi),
    after: blocks.slice(end),
  };
}

/**
 * Partition a doc into an intro + one section per top-level heading of `level`.
 * Only TOP-LEVEL blocks are inspected (nested headings inside callouts/columns
 * stay with their container). A section runs from its heading until the next
 * heading of the same level (or end of doc).
 */
export function splitDocByHeading(doc: Record<string, unknown>, level: SplitLevel): SplitResult {
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
