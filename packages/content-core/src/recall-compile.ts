/**
 * Recall — the pure compile core (S1 of the Recall plan; design page
 * "Recall — architecture plan v1" on the dev brain, roadmap task 97cf7850).
 *
 * Recall serves two kinds of content to agents: MAPS (curated knowledge
 * walked by structure — an index node whose Options block says where to go
 * next and when) and PROMPTS (the actual prompt text, found by similarity).
 * Pages are the authoring layer; at commit they are COMPILED into small
 * serving rows so the hot path is a single indexed read — this module is the
 * parse-and-lint half of that compiler, DB-free so it can be unit-tested and
 * shared.
 *
 * The authoring convention (settled with Jason 2026-08-23):
 *  - a map is a page tree whose ROOT page carries the `recall` tag;
 *  - a node's next steps live in a trailing `## Options` section — a bullet
 *    list of `[label](page:<id>) — use when …` (a mention chip or child-page
 *    card work identically as the target);
 *  - a prompt is a page tagged `prompt`, and declares its matcher line in a
 *    leading "Use when: …" paragraph;
 *  - bodies are budgeted in CHARACTERS (the repo's size-budget convention —
 *    there is deliberately no tokenizer dependency here).
 *
 * Lint severity contract: `error` blocks the COMPILE (the page still commits
 * and the map keeps serving its last good rev); `warning` never blocks.
 */

import { PAGE_HREF } from './markdown-refs';
import { docToMarkdown } from './doc-to-markdown';

/** Tag on a tree's ROOT page that makes the whole tree a Recall map. */
export const RECALL_TAG = 'recall';

/** Tag on a page (inside a map, or standalone-tagged `recall`) marking it a
 *  prompt — embedded for `recall_match`, and required to carry a use-when. */
export const RECALL_PROMPT_TAG = 'prompt';

/** Body budget per node, in characters of rendered markdown (~1.5k tokens).
 *  Character-based on purpose: it matches `EMBED_TEXT_*`'s convention and
 *  keeps this package dependency-free. */
export const RECALL_BODY_CHAR_BUDGET = 6000;

/** Hard cap on members per map. The compiler recompiles the WHOLE map on any
 *  member commit, so an unbounded tree turns every save into a bulk job —
 *  past this, the lint refuses (last good rev keeps serving). A map this big
 *  has stopped being a map anyway. */
export const RECALL_MAX_MAP_NODES = 100;

export type RecallOption = {
  label: string;
  /** The target page's node id, from `page:`/`mention:node:` refs or a
   *  child-page card. Resolved to a slug by the DB half of the compiler. */
  targetPageId: string;
  useWhen: string;
};

export type RecallLintIssue = {
  severity: 'error' | 'warning';
  code:
    | 'options-shape'
    | 'option-no-target'
    | 'option-no-use-when'
    | 'body-over-budget'
    | 'prompt-no-use-when'
    | 'index-no-options'
    | 'target-outside-map'
    | 'map-too-big'
    | 'orphan-node';
  message: string;
  /** Which page the issue is about (filled by the map-level compiler when it
   *  aggregates; the doc-level parser leaves it for the caller). */
  pageId?: string;
};

export type ParsedRecallNode = {
  /** Rendered markdown of the body — everything BEFORE the Options section. */
  bodyMarkdown: string;
  /** The "Use when: …" declaration from the leading paragraph, if present. */
  useWhen: string | null;
  /** Parsed options, or null when the doc has no Options section at all. */
  options: RecallOption[] | null;
  issues: RecallLintIssue[];
};

type PMNode = {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
  text?: string;
};

const s = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Plain text of a node's inline content (text runs + mention labels). */
function inlineText(node: PMNode): string {
  if (node.type === 'text') return s(node.text);
  if (node.type === 'mention') return s(node.attrs?.label);
  if (node.type === 'hardBreak') return ' ';
  return (node.content ?? []).map(inlineText).join('');
}

/** The heading that opens the Options section: any level, text "options". */
function isOptionsHeading(node: PMNode): boolean {
  return node.type === 'heading' && inlineText(node).trim().toLowerCase() === 'options';
}

const USE_WHEN_RE = /^use when\b[:\s—–-]*/i;

/** A leading "Use when: …" paragraph anywhere in the first three blocks —
 *  title-adjacent, so authors can open with an intro line first. */
function extractUseWhen(body: PMNode[]): string | null {
  for (const node of body.slice(0, 3)) {
    if (node.type !== 'paragraph') continue;
    const text = inlineText(node).trim();
    if (USE_WHEN_RE.test(text)) {
      const rest = text.replace(USE_WHEN_RE, '').trim();
      if (rest) return rest;
    }
  }
  return null;
}

/** Flatten a list item's leaf nodes in document order — the basis for the
 *  positional label/use-when split (a string search would misfire when the
 *  label's text also appears elsewhere in the item). */
function flattenLeaves(node: PMNode, out: PMNode[] = []): PMNode[] {
  if (node.type === 'text' || node.type === 'mention' || node.type === 'childPage') {
    out.push(node);
    return out;
  }
  for (const child of node.content ?? []) flattenLeaves(child, out);
  return out;
}

function pageLinkHref(node: PMNode): string | null {
  if (node.type !== 'text') return null;
  for (const mark of node.marks ?? []) {
    if (mark.type === 'link' && PAGE_HREF.test(s(mark.attrs?.href))) return s(mark.attrs?.href);
  }
  return null;
}

/** Leading separators between the link and its use-when text: "— use when…". */
const SEPARATOR_RE = /^[\s—–:-]+/;

function parseOptionItem(
  item: PMNode,
  ordinal: number,
): { option?: RecallOption; issue?: RecallLintIssue } {
  const leaves = flattenLeaves(item);

  // Find the target span: contiguous text runs sharing one page-link href,
  // or a single mention chip / child-page card.
  let target: { id: string; label: string } | null = null;
  let afterAt = leaves.length;
  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i]!;
    const href = pageLinkHref(leaf);
    if (href) {
      const id = PAGE_HREF.exec(href)![1]!;
      let end = i;
      while (end + 1 < leaves.length && pageLinkHref(leaves[end + 1]!) === href) end++;
      target = {
        id,
        label: leaves
          .slice(i, end + 1)
          .map(inlineText)
          .join('')
          .trim(),
      };
      afterAt = end + 1;
      break;
    }
    if (leaf.type === 'mention' && s(leaf.attrs?.ref) === 'node') {
      target = { id: s(leaf.attrs?.id), label: s(leaf.attrs?.label).trim() };
      afterAt = i + 1;
      break;
    }
    if (leaf.type === 'childPage') {
      target = { id: s(leaf.attrs?.pageId), label: s(leaf.attrs?.title).trim() };
      afterAt = i + 1;
      break;
    }
  }

  if (!target || !target.id) {
    return {
      issue: {
        severity: 'error',
        code: 'option-no-target',
        message: `Option ${ordinal}: no page link — each option needs a [label](page:<id>) target.`,
      },
    };
  }
  const useWhen = leaves.slice(afterAt).map(inlineText).join('').replace(SEPARATOR_RE, '').trim();
  if (!useWhen) {
    return {
      issue: {
        severity: 'error',
        code: 'option-no-use-when',
        message: `Option ${ordinal} (“${target.label || target.id}”): missing the “use when …” line that tells an agent when to follow it.`,
      },
    };
  }
  return { option: { label: target.label || 'Untitled', targetPageId: target.id, useWhen } };
}

/**
 * Parse one committed page doc into its Recall shape. Pure — no DB, no
 * throwing; problems come back as lint issues. `isPrompt` adds the
 * prompt-specific checks (a prompt must declare its use-when).
 */
export function parseRecallDoc(
  doc: unknown,
  opts: { isPrompt?: boolean; bodyCharBudget?: number } = {},
): ParsedRecallNode {
  const budget = opts.bodyCharBudget ?? RECALL_BODY_CHAR_BUDGET;
  const issues: RecallLintIssue[] = [];
  const content: PMNode[] = Array.isArray((doc as PMNode)?.content)
    ? ((doc as PMNode).content as PMNode[])
    : [];

  // The LAST "Options" heading opens the section; an author writing about
  // options earlier in the body keeps that text in the body.
  let headingAt = -1;
  for (let i = 0; i < content.length; i++) {
    if (isOptionsHeading(content[i]!)) headingAt = i;
  }

  const body = headingAt === -1 ? content : content.slice(0, headingAt);
  let options: RecallOption[] | null = null;

  if (headingAt !== -1) {
    const tail = content
      .slice(headingAt + 1)
      .filter((n) => !(n.type === 'paragraph' && inlineText(n).trim() === ''));
    const [list, ...extra] = tail;
    if (!list || list.type !== 'bulletList' || extra.length > 0) {
      issues.push({
        severity: 'error',
        code: 'options-shape',
        message:
          'The Options section must be exactly one bullet list of “[label](page:<id>) — use when …” items, with nothing after it.',
      });
      options = [];
    } else {
      options = [];
      (list.content ?? []).forEach((item, i) => {
        const parsed = parseOptionItem(item, i + 1);
        if (parsed.issue) issues.push(parsed.issue);
        if (parsed.option) options!.push(parsed.option);
      });
    }
  }

  const bodyMarkdown = docToMarkdown({ type: 'doc', content: body }).trim();
  if (bodyMarkdown.length > budget) {
    issues.push({
      severity: 'error',
      code: 'body-over-budget',
      message: `Body is ${bodyMarkdown.length} characters; the budget is ${budget}. Recall nodes stay small — split the page or trim it.`,
    });
  }

  const useWhen = extractUseWhen(body);
  if (opts.isPrompt && !useWhen) {
    issues.push({
      severity: 'error',
      code: 'prompt-no-use-when',
      message:
        'A prompt page must open with a “Use when: …” paragraph — it is the line recall_match shows to callers.',
    });
  }

  return { bodyMarkdown, useWhen, options, issues };
}

/**
 * The ONE writer for a node's `## Options` section. Every author path — the
 * owner UI's routing editor and the agent-side authoring tools — must emit
 * options through this, so human-authored and agent-authored options are
 * byte-identical and always round-trip through `parseRecallDoc`. Compose a
 * full body as `bodyMarkdown + '\n\n' + recallOptionsMarkdown(options)`.
 */
export function recallOptionsMarkdown(
  options: { label: string; targetPageId: string; useWhen: string }[],
): string {
  if (options.length === 0) return '';
  const line = (v: string) => v.replace(/\s+/g, ' ').trim();
  const items = options.map((o) => {
    const label = line(o.label).replace(/[[\]]/g, '') || 'Untitled';
    return `- [${label}](page:${o.targetPageId.trim()}) — ${line(o.useWhen)}`;
  });
  return `## Options\n\n${items.join('\n')}\n`;
}

/** Kebab-case a title into a stable slug ('Fleet, access & MCP' → 'fleet-access-mcp'). */
export function recallSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'node';
}

/** Assign unique slugs in tree order: first keeps the bare slug, collisions
 *  count up until FREE — checked against every emitted slug, so a literal
 *  title like "Setup 2" can never collide with a generated "setup-2". Stable
 *  as long as titles and order are stable. */
export function assignRecallSlugs(titles: { id: string; title: string }[]): Map<string, string> {
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const { id, title } of titles) {
    const base = recallSlug(title);
    let slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
    used.add(slug);
    out.set(id, slug);
  }
  return out;
}
