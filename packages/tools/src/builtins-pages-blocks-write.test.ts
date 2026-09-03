/**
 * Behavioural tests for the four single-op block writers: page_block_update,
 * page_block_insert_after, page_block_insert_before and page_block_append.
 *
 * The block-edit transforms (replaceBlock / insertAfterBlock /
 * insertBeforeBlock / appendBlocks) and markdownToDoc are left REAL, so what
 * gets asserted is the doc that actually reached saveDraft: where the new
 * blocks landed, and that the replaced block kept its id. A stub would only
 * prove the tool forwarded arguments.
 *
 * Three things are worth pinning across all four:
 *
 *  1. Every write goes to the DRAFT via saveDraft, threaded with the rev
 *     that was read (`baseRev`). Dropping baseRev would make a user
 *     autosave between the read and the write silently disappear.
 *  2. The editing baseline is the draft when one exists, else the published
 *     doc. Editing the published doc while a draft is open would throw the
 *     user's pending edits away.
 *  3. A conflict is reported as "not saved, re-read", never as success.
 *
 * Store edges (getPage / saveDraft) are stubbed; everything else is real.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return {
    ...actual,
    getPage: vi.fn(),
    saveDraft: vi.fn(),
    nodeUrl: (id: string) => `https://brain.test/n/${id}`,
  };
});
vi.mock('@mantle/files', () => ({ fileById: vi.fn(), readFileById: vi.fn() }));
vi.mock('@mantle/tracing', () => ({ recordIngest: vi.fn() }));

import { getPage, saveDraft } from '@mantle/content';
import { PAGE_TOOLS } from './builtins-pages';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const all = PAGE_TOOLS as readonly BuiltinToolDef[];
const blockUpdate = all.find((t) => t.slug === 'page_block_update')!;
const insertAfter = all.find((t) => t.slug === 'page_block_insert_after')!;
const insertBefore = all.find((t) => t.slug === 'page_block_insert_before')!;
const append = all.find((t) => t.slug === 'page_block_append')!;

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

type Block = {
  type: string;
  attrs?: { id?: string };
  content?: Array<{ type: string; text?: string }>;
};

const para = (id: string, text: string): Block => ({
  type: 'paragraph',
  attrs: { id },
  content: [{ type: 'text', text }],
});

/** Three published paragraphs in a known order. */
const publishedDoc = () => ({
  type: 'doc',
  content: [para('b_1', 'one'), para('b_2', 'two'), para('b_3', 'three')],
});

const page = (over: Record<string, unknown> = {}) => ({
  id: PAGE_ID,
  title: 'Runbook',
  tags: [],
  doc: publishedDoc(),
  draft: null,
  draftRev: 3,
  ...over,
});

/** The doc that reached saveDraft on the most recent call. */
function savedDoc(): Block[] {
  const call = vi.mocked(saveDraft).mock.calls.at(-1);
  if (!call) throw new Error('saveDraft was not called');
  return (call[2] as { content: Block[] }).content;
}

const textOf = (b: Block) => b.content?.map((c) => c.text ?? '').join('') ?? '';
const idsOf = (blocks: Block[]) => blocks.map((b) => b.attrs?.id);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPage).mockResolvedValue(page() as never);
  vi.mocked(saveDraft).mockResolvedValue({ ok: true, rev: 4 } as never);
});

describe('page_block_update', () => {
  it('requires both ids and a body, reading nothing without them', async () => {
    expect(errorOf(await blockUpdate.handler({ page_id: PAGE_ID, markdown: 'x' }, ctx))).toMatch(
      /page_id and block_id are required/,
    );
    expect(errorOf(await blockUpdate.handler({ page_id: PAGE_ID, block_id: 'b_2' }, ctx))).toMatch(
      /page_block_delete/,
    );
    expect(getPage).not.toHaveBeenCalled();
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it('reports a missing page with the lookup that fixes it', async () => {
    vi.mocked(getPage).mockResolvedValue(null as never);
    const res = await blockUpdate.handler(
      { page_id: PAGE_ID, block_id: 'b_2', markdown: 'x' },
      ctx,
    );
    expect(errorOf(res)).toMatch(/page_list/);
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it('tells the caller to refresh stale block ids, and writes nothing', async () => {
    const res = await blockUpdate.handler(
      { page_id: PAGE_ID, block_id: 'b_gone', markdown: 'x' },
      ctx,
    );
    expect(errorOf(res)).toMatch(/page_blocks_list/);
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it('replaces in place, the first new block inheriting the target id', async () => {
    const res = await blockUpdate.handler(
      { page_id: PAGE_ID, block_id: 'b_2', markdown: 'TWO\n\nand a half' },
      ctx,
    );
    expect(saveDraft).toHaveBeenCalledWith('o1', PAGE_ID, expect.anything(), { baseRev: 3 });
    const blocks = savedDoc();
    expect(blocks.map(textOf)).toEqual(['one', 'TWO', 'and a half', 'three']);
    // The slot keeps its id so the next page_blocks_list still addresses it;
    // the extra block gets a fresh id rather than a duplicate.
    expect(blocks[1]!.attrs?.id).toBe('b_2');
    expect(blocks[2]!.attrs?.id).not.toBe('b_2');
    expect(idsOf(blocks)).toContain('b_1');
    expect(idsOf(blocks)).toContain('b_3');
    expect(outputOf(res)).toMatchObject({
      block_id: 'b_2',
      replaced_with_count: 2,
      draft_saved: true,
    });
  });

  it('edits the open DRAFT, not the published doc, when a draft exists', async () => {
    vi.mocked(getPage).mockResolvedValue(
      page({
        draft: { type: 'doc', content: [para('d_1', 'draft only'), para('b_2', 'two')] },
        draftRev: 7,
      }) as never,
    );
    await blockUpdate.handler({ page_id: PAGE_ID, block_id: 'b_2', markdown: 'TWO' }, ctx);
    // The user's pending draft edit ('draft only') must survive; starting
    // from the published doc would erase it.
    expect(savedDoc().map(textOf)).toEqual(['draft only', 'TWO']);
    expect(saveDraft).toHaveBeenCalledWith('o1', PAGE_ID, expect.anything(), { baseRev: 7 });
  });

  it('does NOT report success when the draft moved under it', async () => {
    vi.mocked(saveDraft).mockResolvedValue({ ok: false, conflict: true, rev: 9 } as never);
    const res = await blockUpdate.handler(
      { page_id: PAGE_ID, block_id: 'b_2', markdown: 'x' },
      ctx,
    );
    expect(errorOf(res)).toMatch(/NOT saved/);
    expect(errorOf(res)).toMatch(/re-read/i);
  });
});

describe('page_block_insert_after', () => {
  it('requires the anchor and a body, reading nothing without them', async () => {
    expect(errorOf(await insertAfter.handler({ page_id: PAGE_ID, markdown: 'x' }, ctx))).toMatch(
      /after_block_id are required/,
    );
    expect(
      errorOf(await insertAfter.handler({ page_id: PAGE_ID, after_block_id: 'b_1' }, ctx)),
    ).toMatch(/markdown is required/);
    expect(getPage).not.toHaveBeenCalled();
  });

  it('tells the caller to refresh stale anchors, and writes nothing', async () => {
    const res = await insertAfter.handler(
      { page_id: PAGE_ID, after_block_id: 'b_gone', markdown: 'x' },
      ctx,
    );
    expect(errorOf(res)).toMatch(/page_blocks_list/);
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it('lands the new blocks right after the anchor, keeping every existing id', async () => {
    const res = await insertAfter.handler(
      { page_id: PAGE_ID, after_block_id: 'b_1', markdown: 'new A\n\nnew B' },
      ctx,
    );
    expect(saveDraft).toHaveBeenCalledWith('o1', PAGE_ID, expect.anything(), { baseRev: 3 });
    const blocks = savedDoc();
    expect(blocks.map(textOf)).toEqual(['one', 'new A', 'new B', 'two', 'three']);
    expect(idsOf(blocks).filter((id) => ['b_1', 'b_2', 'b_3'].includes(id!))).toEqual([
      'b_1',
      'b_2',
      'b_3',
    ]);
    expect(outputOf(res)).toMatchObject({
      after_block_id: 'b_1',
      inserted_count: 2,
      draft_saved: true,
    });
  });

  it('uses baseRev 0 when the page has never had a draft', async () => {
    vi.mocked(getPage).mockResolvedValue(page({ draftRev: undefined }) as never);
    await insertAfter.handler({ page_id: PAGE_ID, after_block_id: 'b_1', markdown: 'x' }, ctx);
    expect(saveDraft).toHaveBeenCalledWith('o1', PAGE_ID, expect.anything(), { baseRev: 0 });
  });

  it('does NOT report success when the draft moved under it', async () => {
    vi.mocked(saveDraft).mockResolvedValue({ ok: false, conflict: true, rev: 9 } as never);
    const res = await insertAfter.handler(
      { page_id: PAGE_ID, after_block_id: 'b_1', markdown: 'x' },
      ctx,
    );
    expect(errorOf(res)).toMatch(/NOT saved/);
  });
});

describe('page_block_insert_before', () => {
  it('requires the anchor and a body, reading nothing without them', async () => {
    expect(errorOf(await insertBefore.handler({ page_id: PAGE_ID, markdown: 'x' }, ctx))).toMatch(
      /before_block_id are required/,
    );
    expect(
      errorOf(await insertBefore.handler({ page_id: PAGE_ID, before_block_id: 'b_1' }, ctx)),
    ).toMatch(/markdown is required/);
    expect(getPage).not.toHaveBeenCalled();
  });

  it('tells the caller to refresh stale anchors, and writes nothing', async () => {
    const res = await insertBefore.handler(
      { page_id: PAGE_ID, before_block_id: 'b_gone', markdown: 'x' },
      ctx,
    );
    expect(errorOf(res)).toMatch(/page_blocks_list/);
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it('lands the new blocks right before the anchor', async () => {
    const res = await insertBefore.handler(
      { page_id: PAGE_ID, before_block_id: 'b_3', markdown: 'intro' },
      ctx,
    );
    expect(saveDraft).toHaveBeenCalledWith('o1', PAGE_ID, expect.anything(), { baseRev: 3 });
    const blocks = savedDoc();
    expect(blocks.map(textOf)).toEqual(['one', 'two', 'intro', 'three']);
    expect(blocks[3]!.attrs?.id).toBe('b_3');
    expect(outputOf(res)).toMatchObject({
      before_block_id: 'b_3',
      inserted_count: 1,
      draft_saved: true,
    });
  });

  it('edits the open DRAFT, not the published doc, when a draft exists', async () => {
    vi.mocked(getPage).mockResolvedValue(
      page({ draft: { type: 'doc', content: [para('d_1', 'draft only')] }, draftRev: 5 }) as never,
    );
    await insertBefore.handler({ page_id: PAGE_ID, before_block_id: 'd_1', markdown: 'top' }, ctx);
    expect(savedDoc().map(textOf)).toEqual(['top', 'draft only']);
    expect(saveDraft).toHaveBeenCalledWith('o1', PAGE_ID, expect.anything(), { baseRev: 5 });
  });

  it('does NOT report success when the draft moved under it', async () => {
    vi.mocked(saveDraft).mockResolvedValue({ ok: false, conflict: true, rev: 9 } as never);
    const res = await insertBefore.handler(
      { page_id: PAGE_ID, before_block_id: 'b_1', markdown: 'x' },
      ctx,
    );
    expect(errorOf(res)).toMatch(/NOT saved/);
  });
});

describe('page_block_append', () => {
  it('requires a page id and a body, reading nothing without them', async () => {
    expect(errorOf(await append.handler({ markdown: 'x' }, ctx))).toMatch(/page_id is required/);
    expect(errorOf(await append.handler({ page_id: PAGE_ID }, ctx))).toMatch(
      /markdown is required/,
    );
    expect(getPage).not.toHaveBeenCalled();
  });

  it('reports a missing page with the lookup that fixes it', async () => {
    vi.mocked(getPage).mockResolvedValue(null as never);
    expect(errorOf(await append.handler({ page_id: PAGE_ID, markdown: 'x' }, ctx))).toMatch(
      /page_list/,
    );
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it('appends at the end by default', async () => {
    const res = await append.handler({ page_id: PAGE_ID, markdown: 'tail' }, ctx);
    expect(saveDraft).toHaveBeenCalledWith('o1', PAGE_ID, expect.anything(), { baseRev: 3 });
    expect(savedDoc().map(textOf)).toEqual(['one', 'two', 'three', 'tail']);
    expect(outputOf(res)).toMatchObject({ position: 'end', inserted_count: 1, draft_saved: true });
  });

  it('prepends when position is start, and treats anything else as end', async () => {
    await append.handler({ page_id: PAGE_ID, markdown: 'head', position: 'start' }, ctx);
    expect(savedDoc().map(textOf)).toEqual(['head', 'one', 'two', 'three']);

    // An unknown position must not throw or land somewhere surprising.
    const res = await append.handler({ page_id: PAGE_ID, markdown: 'x', position: 'middle' }, ctx);
    expect(outputOf(res).position).toBe('end');
    expect(savedDoc().map(textOf)).toEqual(['one', 'two', 'three', 'x']);
  });

  it('edits the open DRAFT, not the published doc, when a draft exists', async () => {
    vi.mocked(getPage).mockResolvedValue(
      page({ draft: { type: 'doc', content: [para('d_1', 'draft only')] }, draftRev: 5 }) as never,
    );
    await append.handler({ page_id: PAGE_ID, markdown: 'tail' }, ctx);
    expect(savedDoc().map(textOf)).toEqual(['draft only', 'tail']);
  });

  it('does NOT report success when the draft moved under it', async () => {
    vi.mocked(saveDraft).mockResolvedValue({ ok: false, conflict: true, rev: 9 } as never);
    const res = await append.handler({ page_id: PAGE_ID, markdown: 'x' }, ctx);
    expect(errorOf(res)).toMatch(/NOT saved/);
    expect(errorOf(res)).toMatch(/re-read/i);
  });
});
