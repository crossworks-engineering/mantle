/**
 * Behavioural tests for page_create, page_update, page_move and page_mention.
 *
 * These four are the tools where the PUBLISHED-vs-DRAFT line is easiest to
 * get wrong, and the line is the thing worth pinning. page_create and
 * page_update write the published doc directly (createPage / updatePage);
 * page_move is a structural change that publishes at once and never touches
 * a draft; page_mention goes through addPageMention, which lands in the
 * draft. A tool that quietly moved from one side of that line to the other
 * would still "work" in every happy-path test, so the assertions here name
 * which store edge was hit AND which one was not.
 *
 * The other thing worth pinning is the owner-only tag strip. `recall` and
 * `prompt` are owner gestures (docs/recall.md): an agent may draft a map
 * page, but only the owner activates it by tagging. The strip is a silent
 * filter on the way in, so a regression would be invisible in the output
 * unless the test looks at what reached the store.
 *
 * Store edges (createPage / updatePage / movePage / addPageMention) are
 * stubbed; markdownToDoc and the tools' own guards and mappings are real.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return {
    ...actual,
    createPage: vi.fn(),
    updatePage: vi.fn(),
    movePage: vi.fn(),
    addPageMention: vi.fn(),
    saveDraft: vi.fn(),
    nodeUrl: (id: string) => `https://brain.test/n/${id}`,
  };
});
vi.mock('@mantle/files', () => ({ fileById: vi.fn(), readFileById: vi.fn() }));
vi.mock('@mantle/tracing', () => ({ recordIngest: vi.fn() }));

import { createPage, updatePage, movePage, addPageMention, saveDraft } from '@mantle/content';
import { recordIngest } from '@mantle/tracing';
import { PAGE_TOOLS } from './builtins-pages';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const all = PAGE_TOOLS as readonly BuiltinToolDef[];
const create = all.find((t) => t.slug === 'page_create')!;
const update = all.find((t) => t.slug === 'page_update')!;
const move = all.find((t) => t.slug === 'page_move')!;
const mention = all.find((t) => t.slug === 'page_mention')!;

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const PAGE_ID = 'p-1';
const PARENT_ID = 'p-parent';

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

const created = (over: Record<string, unknown> = {}) => ({
  id: PAGE_ID,
  title: 'Runbook',
  tags: ['ops'],
  doc: { type: 'doc', content: [] },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createPage).mockResolvedValue(created() as never);
  vi.mocked(updatePage).mockResolvedValue(created() as never);
  vi.mocked(movePage).mockResolvedValue({
    id: PAGE_ID,
    title: 'Runbook',
    parentId: PARENT_ID,
  } as never);
  vi.mocked(addPageMention).mockResolvedValue({
    ref: 'node',
    label: 'Target',
    appended: true,
    afterBlockId: null,
  } as never);
});

describe('page_create', () => {
  it('refuses a blank title without creating anything', async () => {
    expect(errorOf(await create.handler({ title: '  ', markdown: 'x' }, ctx))).toMatch(
      /title is required/,
    );
    expect(createPage).not.toHaveBeenCalled();
    expect(recordIngest).not.toHaveBeenCalled();
  });

  it('creates a top-level page under the owner, with the body converted to a doc', async () => {
    const res = await create.handler(
      { title: 'Runbook', markdown: 'Hello world', tags: ['ops'] },
      ctx,
    );

    expect(createPage).toHaveBeenCalledWith(
      'o1',
      expect.objectContaining({ title: 'Runbook', tags: ['ops'] }),
    );
    // The body reached the store as a ProseMirror doc, not raw markdown.
    const arg = vi.mocked(createPage).mock.calls[0]![1] as unknown as { doc: { type: string } };
    expect(arg.doc.type).toBe('doc');
    // Omitting parent_id means top-level: no parentId key at all, not null.
    expect(arg).not.toHaveProperty('parentId');
    expect(outputOf(res)).toMatchObject({ id: PAGE_ID, title: 'Runbook', tags: ['ops'] });
    expect(outputOf(res)).not.toHaveProperty('parent_id');
    expect(outputOf(res).url).toContain(PAGE_ID);
  });

  it('writes the PUBLISHED doc, never a draft', async () => {
    await create.handler({ title: 'Runbook', markdown: 'body' }, ctx);
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it('nests under parent_id and echoes it back', async () => {
    const res = await create.handler({ title: 'Child', parent_id: PARENT_ID }, ctx);
    expect(createPage).toHaveBeenCalledWith('o1', expect.objectContaining({ parentId: PARENT_ID }));
    expect(outputOf(res).parent_id).toBe(PARENT_ID);
  });

  it('strips owner-only tags before they reach the store, and says so', async () => {
    const res = await create.handler({ title: 'Map', tags: ['work', 'recall', 'Prompt'] }, ctx);
    // An agent may DRAFT a map page; only the owner activates it by tagging.
    expect(createPage).toHaveBeenCalledWith('o1', expect.objectContaining({ tags: ['work'] }));
    expect(String(outputOf(res).note)).toMatch(/owner-only/);
  });

  it('records the ingest so the page reaches the brain', async () => {
    await create.handler({ title: 'Runbook', markdown: 'body' }, ctx);
    expect(recordIngest).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent_tool', ownerId: 'o1', nodeId: PAGE_ID }),
    );
  });

  it('turns a parent-page miss into a teaching error naming the id', async () => {
    vi.mocked(createPage).mockRejectedValue(new Error('createPage: parent page not found'));
    const res = await create.handler({ title: 'Child', parent_id: 'p-nope' }, ctx);
    expect(errorOf(res)).toContain('p-nope');
    expect(errorOf(res)).toMatch(/page_list/);
    expect(recordIngest).not.toHaveBeenCalled();
  });
});

describe('page_update', () => {
  it('refuses a blank id', async () => {
    expect(errorOf(await update.handler({ id: ' ', title: 'x' }, ctx))).toMatch(/id is required/);
    expect(updatePage).not.toHaveBeenCalled();
  });

  it('refuses an empty patch rather than issuing a no-op write', async () => {
    expect(errorOf(await update.handler({ id: PAGE_ID }, ctx))).toMatch(/nothing to update/);
    expect(updatePage).not.toHaveBeenCalled();
  });

  it('sends ONLY the fields given (a title fix must not touch the body)', async () => {
    await update.handler({ id: PAGE_ID, title: 'New title' }, ctx);
    expect(updatePage).toHaveBeenCalledWith('o1', PAGE_ID, { title: 'New title' });
  });

  it('replaces the PUBLISHED body when markdown is given, not the draft', async () => {
    const res = await update.handler({ id: PAGE_ID, markdown: 'Fresh body' }, ctx);
    // page_update is the one-shot published replace; the draft path is
    // page_update_draft / the block tools. Both edges being hit, or the
    // wrong one, would be a contract change.
    expect(updatePage).toHaveBeenCalledWith(
      'o1',
      PAGE_ID,
      expect.objectContaining({ doc: expect.objectContaining({ type: 'doc' }) }),
    );
    expect(saveDraft).not.toHaveBeenCalled();
    expect(outputOf(res)).toMatchObject({ id: PAGE_ID, title: 'Runbook' });
  });

  it('strips owner-only tags from a tag replacement', async () => {
    await update.handler({ id: PAGE_ID, tags: ['recall', 'ops'] }, ctx);
    expect(updatePage).toHaveBeenCalledWith('o1', PAGE_ID, { tags: ['ops'] });
  });

  it('reports a missing page with the lookup that fixes it', async () => {
    vi.mocked(updatePage).mockResolvedValue(null as never);
    expect(errorOf(await update.handler({ id: PAGE_ID, title: 'x' }, ctx))).toMatch(/page_list/);
  });
});

describe('page_move', () => {
  it('refuses a blank id', async () => {
    expect(errorOf(await move.handler({ id: ' ', to_top_level: true }, ctx))).toMatch(
      /id is required/,
    );
    expect(movePage).not.toHaveBeenCalled();
  });

  it('refuses both destinations at once, and neither, without moving', async () => {
    expect(
      errorOf(await move.handler({ id: PAGE_ID, parent_id: PARENT_ID, to_top_level: true }, ctx)),
    ).toMatch(/not both/);
    expect(errorOf(await move.handler({ id: PAGE_ID }, ctx))).toMatch(/specify a destination/);
    expect(movePage).not.toHaveBeenCalled();
  });

  it('refuses a page as its own parent before asking the store', async () => {
    expect(errorOf(await move.handler({ id: PAGE_ID, parent_id: PAGE_ID }, ctx))).toMatch(
      /own parent/,
    );
    expect(movePage).not.toHaveBeenCalled();
  });

  it('nests under parent_id and reports the new spot', async () => {
    const res = await move.handler({ id: PAGE_ID, parent_id: PARENT_ID }, ctx);
    expect(movePage).toHaveBeenCalledWith('o1', PAGE_ID, PARENT_ID);
    expect(outputOf(res)).toMatchObject({ parent_id: PARENT_ID, moved_to: 'sub-page' });
  });

  it('promotes to top level by passing a null parent', async () => {
    vi.mocked(movePage).mockResolvedValue({
      id: PAGE_ID,
      title: 'Runbook',
      parentId: null,
    } as never);
    const res = await move.handler({ id: PAGE_ID, to_top_level: true }, ctx);
    expect(movePage).toHaveBeenCalledWith('o1', PAGE_ID, null);
    expect(outputOf(res).moved_to).toBe('top-level');
  });

  it('is a structural change: no draft is written', async () => {
    await move.handler({ id: PAGE_ID, parent_id: PARENT_ID }, ctx);
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it('reports a missing page with the lookup that fixes it', async () => {
    vi.mocked(movePage).mockResolvedValue(null as never);
    expect(errorOf(await move.handler({ id: PAGE_ID, to_top_level: true }, ctx))).toMatch(
      /page_list/,
    );
  });

  it('explains a cycle refusal in terms of the target', async () => {
    vi.mocked(movePage).mockRejectedValue(
      new Error('movePage: cannot move a page under itself or one of its own descendants'),
    );
    const res = await move.handler({ id: PAGE_ID, parent_id: 'p-desc' }, ctx);
    expect(errorOf(res)).toMatch(/cycle/);
    expect(errorOf(res)).toContain('p-desc');
  });

  it('turns a parent-page miss into a teaching error naming the id', async () => {
    vi.mocked(movePage).mockRejectedValue(new Error('createPage: parent page not found'));
    const res = await move.handler({ id: PAGE_ID, parent_id: 'p-nope' }, ctx);
    expect(errorOf(res)).toContain('p-nope');
    expect(errorOf(res)).toMatch(/page_list/);
  });
});

describe('page_mention', () => {
  it('requires both ids and writes nothing without them', async () => {
    expect(errorOf(await mention.handler({ target_id: 't-1' }, ctx))).toMatch(
      /page_id is required/,
    );
    expect(errorOf(await mention.handler({ page_id: PAGE_ID }, ctx))).toMatch(
      /target_id is required/,
    );
    expect(addPageMention).not.toHaveBeenCalled();
  });

  it('defaults to a node ref appended at the end, forwarding only what was given', async () => {
    const res = await mention.handler({ page_id: PAGE_ID, target_id: 't-1' }, ctx);
    // Absent options must be ABSENT, not empty strings: addPageMention treats
    // a present label as an override of the target's title.
    expect(addPageMention).toHaveBeenCalledWith('o1', PAGE_ID, { targetId: 't-1', ref: 'node' });
    expect(outputOf(res)).toMatchObject({
      page_id: PAGE_ID,
      target_id: 't-1',
      placement: 'appended',
      draft_saved: true,
    });
    // The edge is built on commit; until then the mention lives in the draft.
    expect(String(outputOf(res).hint)).toMatch(/DRAFT/);
  });

  it('forwards entity ref, label, lead text and anchor when given', async () => {
    vi.mocked(addPageMention).mockResolvedValue({
      ref: 'entity',
      label: 'Sarah',
      appended: false,
      afterBlockId: 'b_2',
    } as never);
    const res = await mention.handler(
      {
        page_id: PAGE_ID,
        target_id: 'e-1',
        ref: 'entity',
        label: 'Sarah',
        lead_text: 'See also:',
        after_block_id: 'b_2',
      },
      ctx,
    );
    expect(addPageMention).toHaveBeenCalledWith('o1', PAGE_ID, {
      targetId: 'e-1',
      ref: 'entity',
      label: 'Sarah',
      leadText: 'See also:',
      afterBlockId: 'b_2',
    });
    expect(outputOf(res).placement).toBe('after b_2');
  });

  it('reports a missing page with the lookup that fixes it', async () => {
    vi.mocked(addPageMention).mockResolvedValue(null as never);
    expect(errorOf(await mention.handler({ page_id: PAGE_ID, target_id: 't-1' }, ctx))).toMatch(
      /page_list/,
    );
  });

  it('distinguishes a stale anchor from a bad target', async () => {
    vi.mocked(addPageMention).mockRejectedValue(
      new Error('addPageMention: anchor block b_gone not found'),
    );
    const anchor = await mention.handler(
      { page_id: PAGE_ID, target_id: 't-1', after_block_id: 'b_gone' },
      ctx,
    );
    // The recovery differs: a stale anchor means re-list blocks (or omit the
    // anchor); a bad target means find another id.
    expect(errorOf(anchor)).toContain('b_gone');
    expect(errorOf(anchor)).toMatch(/page_blocks_list/);

    vi.mocked(addPageMention).mockRejectedValue(new Error('addPageMention: target not found'));
    const target = await mention.handler({ page_id: PAGE_ID, target_id: 't-bad' }, ctx);
    expect(errorOf(target)).toContain('t-bad');
    expect(errorOf(target)).toMatch(/pages\/notes/);
  });
});
