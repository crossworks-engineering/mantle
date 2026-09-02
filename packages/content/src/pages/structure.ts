/**
 * Pages · restructuring. Three operations that rearrange a page into or
 * against other pages: split it into sub-pages along its headings, promote one
 * heading's section into a sub-page, and insert a mention chip.
 *
 * They share one safety model, and it is the reason they live together. Every
 * one of them creates its children through `createPage` (so each child is
 * indexed independently, which is the whole point of splitting) and writes the
 * rewritten parent to `draft_doc` ONLY, so the restructure is reviewable and
 * the published doc is untouched until the user commits. All three operate on
 * `draft ?? doc`, the current working content.
 */
import { and, eq } from 'drizzle-orm';
import { db, entities, nodes } from '@mantle/db';
import { ensureBlockIds } from '@mantle/content-core/block-ids';
import {
  splitDocByHeading,
  extractSection,
  type SplitLevel,
} from '@mantle/content-core/page-split';
import { buildMentionParagraph, type MentionRef } from '../mention-refs';
import { insertAfterBlock, type PMBlockNode } from '../block-edit';
import { getPage } from './read';
import { createPage } from './tree';
import { saveDraft } from './draft';

/** Thrown by `splitPage` when the page has no heading at the requested level
 *  to split on. The tool layer maps this to a friendly message. */
export class NoSplitHeadingsError extends Error {
  constructor(level: SplitLevel) {
    super(`splitPage: no h${level} headings to split on`);
    this.name = 'NoSplitHeadingsError';
  }
}

export type SplitPageResult = {
  /** The created child pages, in document order. */
  children: { id: string; title: string }[];
  /** Whether intro content (before the first heading) was kept on the parent. */
  introKept: boolean;
};

/**
 * Split a long page into sub-pages along its headings (Phase 4b). Each heading
 * of `by` becomes a child page (title = heading text, body = the blocks under
 * it); the parent's body is replaced with a table-of-contents of `childPage`
 * cards pointing at those children.
 *
 * Safety + indexing model, mirroring the rest of Pages:
 *  - Children are created via `createPage`, whose `nodes` insert fires the
 *    extractor — so each child is indexed independently (its own summary /
 *    embedding / facts), the whole point of splitting.
 *  - The parent's new TOC is written to `draft_doc` ONLY (via `saveDraft`); the
 *    published `doc` is untouched until the user commits, so the restructure is
 *    reviewable. Operates on `draft ?? doc` (the current working content).
 *
 * Byte-faithful: blocks are redistributed, never rewritten (see page-split.ts).
 */
export async function splitPage(
  ownerId: string,
  pageId: string,
  opts: { by: SplitLevel; preserveIntro?: boolean },
): Promise<SplitPageResult> {
  const page = await getPage(ownerId, pageId);
  if (!page) throw new Error(`splitPage: page ${pageId} not found`);

  const source = (page.draft ?? page.doc) as Record<string, unknown>;
  const { intro, sections } = splitDocByHeading(source, opts.by);
  if (sections.length === 0) throw new NoSplitHeadingsError(opts.by);

  const preserveIntro = opts.preserveIntro ?? true;
  const children: { id: string; title: string }[] = [];
  const tocBlocks: Record<string, unknown>[] = preserveIntro
    ? (intro as Record<string, unknown>[])
    : [];

  for (const sec of sections) {
    const childDoc = ensureBlockIds({
      type: 'doc',
      content: sec.blocks.length ? sec.blocks : [{ type: 'paragraph' }],
    });
    const child = await createPage(ownerId, {
      title: sec.title,
      doc: childDoc,
      parentId: pageId,
    });
    children.push({ id: child.id, title: child.title });
    tocBlocks.push({
      type: 'childPage',
      attrs: { pageId: child.id, title: child.title, icon: null },
    });
  }

  const tocDoc = ensureBlockIds({
    type: 'doc',
    content: tocBlocks.length ? tocBlocks : [{ type: 'paragraph' }],
  });
  await saveDraft(ownerId, pageId, tocDoc);

  return { children, introKept: preserveIntro && intro.length > 0 };
}

/** Thrown by `extractSectionToChild` when the block id isn't a top-level
 *  heading (only top-level headings are promotable to sub-pages). */
export class SectionNotFoundError extends Error {
  constructor(headingBlockId: string) {
    super(`extractSectionToChild: no top-level heading with id ${headingBlockId}`);
    this.name = 'SectionNotFoundError';
  }
}

export type ExtractSectionResult = { childId: string; title: string };

/**
 * Promote a single heading + its body into a sub-page (Phase 4c). The section
 * runs from the heading until the next heading of equal-or-higher level; its
 * heading text becomes the child title, the blocks under it the child body, and
 * a `childPage` card replaces the section in the parent. Same safety + indexing
 * model as `splitPage`: child created via `createPage` (indexed on insert),
 * parent rewritten to `draft_doc` only. Operates on `draft ?? doc`.
 */
export async function extractSectionToChild(
  ownerId: string,
  pageId: string,
  headingBlockId: string,
): Promise<ExtractSectionResult> {
  const page = await getPage(ownerId, pageId);
  if (!page) throw new Error(`extractSectionToChild: page ${pageId} not found`);

  const source = (page.draft ?? page.doc) as Record<string, unknown>;
  const section = extractSection(source, headingBlockId);
  if (!section) throw new SectionNotFoundError(headingBlockId);

  const childDoc = ensureBlockIds({
    type: 'doc',
    content: section.childBlocks.length ? section.childBlocks : [{ type: 'paragraph' }],
  });
  const child = await createPage(ownerId, {
    title: section.title,
    doc: childDoc,
    parentId: pageId,
  });

  const newParent = ensureBlockIds({
    type: 'doc',
    content: [
      ...section.before,
      { type: 'childPage', attrs: { pageId: child.id, title: child.title, icon: null } },
      ...section.after,
    ],
  });
  await saveDraft(ownerId, pageId, newParent);

  return { childId: child.id, title: child.title };
}

/** Thrown by `addPageMention` when the mention target isn't one of the owner's
 *  nodes/entities. The tool layer maps this to a friendly message. */
export class MentionTargetNotFoundError extends Error {
  constructor(ref: MentionRef, id: string) {
    super(`addPageMention: ${ref} ${id} not found`);
    this.name = 'MentionTargetNotFoundError';
  }
}

/** Thrown by `addPageMention` when `afterBlockId` doesn't match any block in the
 *  page (stale id, or the user edited since). */
export class MentionAnchorNotFoundError extends Error {
  constructor(blockId: string) {
    super(`addPageMention: anchor block ${blockId} not found`);
    this.name = 'MentionAnchorNotFoundError';
  }
}

export type AddMentionResult = {
  targetId: string;
  /** The chip text written into the page (resolved from the target's title). */
  label: string;
  ref: MentionRef;
  /** The anchor block the chip was placed after, or null when appended. */
  afterBlockId: string | null;
  /** True when the chip was appended to the end of the page. */
  appended: boolean;
};

/**
 * Insert a mention chip into a page — the programmatic equivalent of typing
 * `@Target`. The chip is a REAL link, not plain text: ref='node' points at
 * another page/note and ref='entity' at a person/project/place. The target's
 * current title is resolved from `nodes`/`entities` so the chip text matches
 * what the user sees (override with `label`). The chip lands in a fresh
 * `[leadText ]@Target` paragraph, either appended to the end of the page or
 * dropped right after `afterBlockId` (a block id from listBlocks).
 *
 * Writes to `draft_doc` ONLY — the published doc is untouched. The graph edge
 * (`references` for a node, `mentioned_in` for an entity) is built by the
 * extractor when the user commits, exactly as for a hand-typed mention; this is
 * the same draft-then-review model the block tools use. Returns null if the
 * page doesn't exist.
 */
export async function addPageMention(
  ownerId: string,
  pageId: string,
  opts: {
    targetId: string;
    ref?: MentionRef;
    label?: string;
    leadText?: string;
    afterBlockId?: string | null;
  },
): Promise<AddMentionResult | null> {
  const page = await getPage(ownerId, pageId);
  if (!page) return null;

  const ref: MentionRef = opts.ref === 'entity' ? 'entity' : 'node';
  let label = opts.label?.trim() ?? '';
  let kind: string | null;

  // Resolve the target + its display label from the owner's own data, so a
  // mention can never link to (or leak the title of) something they don't own.
  if (ref === 'node') {
    const [n] = await db
      .select({ title: nodes.title, type: nodes.type })
      .from(nodes)
      .where(and(eq(nodes.id, opts.targetId), eq(nodes.ownerId, ownerId)))
      .limit(1);
    if (!n) throw new MentionTargetNotFoundError('node', opts.targetId);
    if (!label) label = n.title;
    kind = n.type;
  } else {
    const [e] = await db
      .select({ name: entities.name, kind: entities.kind })
      .from(entities)
      .where(and(eq(entities.id, opts.targetId), eq(entities.ownerId, ownerId)))
      .limit(1);
    if (!e) throw new MentionTargetNotFoundError('entity', opts.targetId);
    if (!label) label = e.name;
    kind = e.kind;
  }

  const paragraph = buildMentionParagraph({
    id: opts.targetId,
    label,
    ref,
    kind,
    leadText: opts.leadText,
  });

  // Block edits always operate on the current working copy (draft if one's open,
  // else the published doc) and write back to the draft — mirrors the block tools.
  const baseline = (page.draft ?? page.doc) as Record<string, unknown>;
  const afterBlockId = opts.afterBlockId?.trim() || null;

  let nextDoc: Record<string, unknown>;
  if (afterBlockId) {
    const res = insertAfterBlock(baseline, afterBlockId, [paragraph as PMBlockNode]);
    if (!res.found) throw new MentionAnchorNotFoundError(afterBlockId);
    nextDoc = res.doc;
  } else {
    const cloned = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown> & {
      content?: unknown[];
    };
    cloned.content = [...(Array.isArray(cloned.content) ? cloned.content : []), paragraph];
    nextDoc = cloned;
  }

  const res = await saveDraft(ownerId, pageId, nextDoc);
  if (!res.ok) return null;
  return { targetId: opts.targetId, label, ref, afterBlockId, appended: afterBlockId === null };
}
