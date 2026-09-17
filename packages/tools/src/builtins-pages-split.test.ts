/**
 * Behavioural tests for page_split and page_extract_section, the two
 * structural tools that carve sub-pages OUT of a page.
 *
 * Both delegate the walk to @mantle/content (splitPage /
 * extractSectionToChild), so the tools' own contribution is small and easy
 * to get subtly wrong: the `by` argument is a heading LEVEL, and 'h1' has
 * to reach the store as 1, not as the string; `preserve_intro` defaults to
 * true and only an explicit false turns it off; a bad level must be refused
 * before anything is created, because the store call creates child pages
 * that a discard of the parent's draft does not undo.
 *
 * The hint text is asserted too, because it carries the one thing the model
 * cannot see: the TOC (or link card) is in DRAFT while the children are
 * already real and indexed. A caller told "done" without that would assume
 * a discard undoes everything.
 *
 * Store edges are stubbed; the tools' own guards and mappings are real.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return {
    ...actual,
    splitPage: vi.fn(),
    extractSectionToChild: vi.fn(),
    nodeUrl: (id: string) => `https://brain.test/n/${id}`,
  };
});
vi.mock('@mantle/files', () => ({ fileById: vi.fn(), readFileById: vi.fn() }));
vi.mock('@mantle/tracing', () => ({ recordIngest: vi.fn() }));

import { splitPage, extractSectionToChild } from '@mantle/content';
import { PAGE_TOOLS } from './builtins-pages';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const all = PAGE_TOOLS as readonly BuiltinToolDef[];
const split = all.find((t) => t.slug === 'page_split')!;
const extract = all.find((t) => t.slug === 'page_extract_section')!;

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const PAGE_ID = 'p-1';

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

const children = [
  { id: 'c-1', title: 'Intro' },
  { id: 'c-2', title: 'Appendix' },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(splitPage).mockResolvedValue({ children, introKept: true } as never);
  vi.mocked(extractSectionToChild).mockResolvedValue({
    childId: 'c-9',
    title: 'Appendix',
  } as never);
});

describe('page_split', () => {
  it('refuses a blank page id without splitting', async () => {
    expect(errorOf(await split.handler({ page_id: ' ', by: 'h2' }, ctx))).toMatch(
      /page_id is required/,
    );
    expect(splitPage).not.toHaveBeenCalled();
  });

  it('refuses an unknown heading level BEFORE any child is created', async () => {
    // Children are created and indexed immediately; there is no undo for a
    // split at the wrong granularity, so the guard has to sit in front.
    expect(errorOf(await split.handler({ page_id: PAGE_ID, by: 'h3' }, ctx))).toMatch(
      /'h1' or 'h2'/,
    );
    expect(errorOf(await split.handler({ page_id: PAGE_ID }, ctx))).toMatch(/'h1' or 'h2'/);
    expect(splitPage).not.toHaveBeenCalled();
  });

  it('maps h1 to level 1 and keeps the intro by default', async () => {
    const res = await split.handler({ page_id: PAGE_ID, by: 'h1' }, ctx);
    expect(splitPage).toHaveBeenCalledWith('o1', PAGE_ID, { by: 1, preserveIntro: true });
    expect(outputOf(res)).toMatchObject({
      page_id: PAGE_ID,
      split_into: 2,
      children,
      intro_kept: true,
    });
  });

  it('maps h2 to level 2, case-insensitively, and honours preserve_intro:false', async () => {
    await split.handler({ page_id: PAGE_ID, by: 'H2', preserve_intro: false }, ctx);
    expect(splitPage).toHaveBeenCalledWith('o1', PAGE_ID, { by: 2, preserveIntro: false });
  });

  it('tells the caller the TOC is in DRAFT while the children are already real', async () => {
    const res = await split.handler({ page_id: PAGE_ID, by: 'h2' }, ctx);
    const hint = String(outputOf(res).hint);
    expect(hint).toMatch(/2 sub-pages/);
    expect(hint).toMatch(/DRAFT/);
    // Discarding the parent's draft does not remove the children.
    expect(hint).toMatch(/manual cleanup/);
  });

  it('surfaces a store failure as the error, not a partial success', async () => {
    vi.mocked(splitPage).mockRejectedValue(new Error(`splitPage: page ${PAGE_ID} not found`));
    expect(errorOf(await split.handler({ page_id: PAGE_ID, by: 'h2' }, ctx))).toMatch(/not found/);
  });
});

describe('page_extract_section', () => {
  it('requires both ids, extracting nothing without them', async () => {
    expect(errorOf(await extract.handler({ heading_block_id: 'h_1' }, ctx))).toMatch(
      /page_id is required/,
    );
    expect(errorOf(await extract.handler({ page_id: PAGE_ID }, ctx))).toMatch(
      /heading_block_id is required/,
    );
    expect(extractSectionToChild).not.toHaveBeenCalled();
  });

  it('moves the section into a child, owner-scoped, and reports the child', async () => {
    const res = await extract.handler({ page_id: PAGE_ID, heading_block_id: 'h_1' }, ctx);
    expect(extractSectionToChild).toHaveBeenCalledWith('o1', PAGE_ID, 'h_1');
    expect(outputOf(res)).toMatchObject({ page_id: PAGE_ID, child_id: 'c-9', title: 'Appendix' });
    const hint = String(outputOf(res).hint);
    expect(hint).toContain('Appendix');
    expect(hint).toMatch(/DRAFT/);
  });

  it('surfaces a store failure as the error', async () => {
    vi.mocked(extractSectionToChild).mockRejectedValue(
      new Error('extractSectionToChild: heading h_1 is not a top-level heading'),
    );
    const res = await extract.handler({ page_id: PAGE_ID, heading_block_id: 'h_1' }, ctx);
    expect(errorOf(res)).toMatch(/top-level heading/);
  });
});
