/**
 * Tests for page_blocks_apply — the atomic batch form of the block tools.
 *
 * The contract under test is what makes it safe to prefer over N single
 * calls: ops apply IN ORDER against one in-memory doc, the draft is saved
 * exactly once at the end, and ANY failure aborts before the save with a
 * teaching error naming the op index — all-or-nothing, never a half-edited
 * draft. Real block-edit transforms (replaceBlock/insertAfterBlock/
 * deleteBlock via @mantle/content) run under the mock; only the DB edges
 * (getPage/saveDraft) and the markdown parser are stubbed.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/content', async () => {
  const blockEdit = await vi.importActual<typeof import('../../content/src/block-edit')>(
    '../../content/src/block-edit',
  );
  const { ensureBlockIds } = await vi.importActual<typeof import('../../content/src/block-ids')>(
    '../../content/src/block-ids',
  );
  return {
    ...blockEdit,
    // Minimal deterministic markdown → PM doc: '## ' makes a heading,
    // anything else a paragraph; blank-line separated. Wrapped in
    // ensureBlockIds like the REAL markdownToDoc — parsed blocks arrive
    // with fresh ids, so these tests exercise the same id-inheritance
    // path production does (a bare mock without ids once hid the fact
    // that replaceBlock's inheritance branch never fired in prod).
    markdownToDoc: (md: string) =>
      ensureBlockIds({
        type: 'doc',
        content: md
          .split('\n\n')
          .filter((c) => c.trim() !== '')
          .map((chunk) =>
            chunk.startsWith('## ')
              ? {
                  type: 'heading',
                  attrs: { level: 2 },
                  content: [{ type: 'text', text: chunk.slice(3) }],
                }
              : { type: 'paragraph', content: [{ type: 'text', text: chunk }] },
          ),
      }),
    getPage: vi.fn(),
    saveDraft: vi.fn(),
  };
});
vi.mock('@mantle/files', () => ({ fileById: vi.fn(), readFileById: vi.fn() }));
vi.mock('@mantle/tracing', () => ({ recordIngest: vi.fn() }));

import { ensureBlockIds } from '../../content/src/block-ids';
import { getPage, saveDraft } from '@mantle/content';
import { PAGE_TOOLS } from './builtins-pages';
import type { ToolHandlerContext } from './types';

const apply = PAGE_TOOLS.find((t) => t.slug === 'page_blocks_apply')!;
const ctx: ToolHandlerContext = { ownerId: 'o1' };
const PAGE_ID = 'p1';

type Block = { type: string; attrs: { id: string }; content?: Array<{ text?: string }> };

function makeBaseline() {
  const doc = ensureBlockIds({
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Old title' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Keep me' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Delete me' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Anchor' }] },
    ],
  });
  const ids = (doc as unknown as { content: Block[] }).content.map((b) => b.attrs.id);
  return { doc, ids };
}

beforeEach(() => {
  vi.mocked(saveDraft).mockReset().mockResolvedValue(true);
  vi.mocked(getPage).mockReset();
});

describe('page_blocks_apply', () => {
  it('applies update + insert_after + delete in order and saves the draft ONCE', async () => {
    const { doc, ids } = makeBaseline();
    vi.mocked(getPage).mockResolvedValue({ doc, draft: null } as never);

    const res = await apply.handler(
      {
        page_id: PAGE_ID,
        ops: [
          { op: 'update', block_id: ids[0], markdown: '## New title' },
          { op: 'insert_after', block_id: ids[3], markdown: 'Appendix one\n\nAppendix two' },
          { op: 'delete', block_id: ids[2] },
        ],
      },
      ctx,
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.output).toMatchObject({
        ops_applied: 3,
        updated: 1,
        inserted: 2,
        deleted: 1,
        draft_saved: true,
      });
    }
    expect(saveDraft).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(saveDraft).mock.calls[0]![2] as { content: Block[] };
    const texts = saved.content.map((b) => b.content?.[0]?.text);
    expect(texts).toEqual(['New title', 'Keep me', 'Anchor', 'Appendix one', 'Appendix two']);
    // The updated heading keeps its original id (replaceBlock invariant).
    expect(saved.content[0]!.attrs.id).toBe(ids[0]);
    expect(saved.content[0]!.type).toBe('heading');
  });

  it('never produces duplicate block ids across an update + insert batch', async () => {
    // Regression for the refinery-SOP corruption class (2026-07-06):
    // after any insert/replace batch, every block id in the saved draft
    // must be unique — a duplicate makes all later occurrences invisible
    // to page_block_get/update/delete (findBlock stops at the first).
    const { doc, ids } = makeBaseline();
    vi.mocked(getPage).mockResolvedValue({ doc, draft: null } as never);

    const res = await apply.handler(
      {
        page_id: PAGE_ID,
        ops: [
          { op: 'update', block_id: ids[0], markdown: '## Retitled\n\nIntro under it' },
          { op: 'insert_after', block_id: ids[1], markdown: 'Step 1\n\nStep 2\n\nStep 3' },
          { op: 'insert_after', block_id: ids[3], markdown: 'Step 4' },
        ],
      },
      ctx,
    );

    expect(res.ok).toBe(true);
    const saved = vi.mocked(saveDraft).mock.calls[0]![2] as { content: Block[] };
    const savedIds = saved.content.map((b) => b.attrs.id);
    expect(savedIds.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(savedIds).size).toBe(savedIds.length);
    // The updated block still answers to its original id (no churn).
    expect(savedIds[0]).toBe(ids[0]);
  });

  it('a corrupted baseline (duplicated ids) heals on the save path and stays editable', async () => {
    // The exact corrupted-draft shape from the refinery-SOP incident:
    // several paragraphs sharing one id.
    // In production getPage heals this before the handler sees it; this
    // test drives the raw corrupted doc through the batch to prove (a)
    // ops on the duplicated id resolve deterministically to the FIRST
    // occurrence, and (b) the saveDraft-side ensureBlockIds pass leaves
    // every id unique — the repair a corrupted page gets on next touch.
    const DUP = 'a7f08640-07b3-44a5-bcb3-4bafb4fe3735';
    const p = (id: string, text: string) => ({
      type: 'paragraph',
      attrs: { id },
      content: [{ type: 'text', text }],
    });
    const corrupted = {
      type: 'doc',
      content: [p(DUP, 'Step 1'), p(DUP, 'Step 2'), p(DUP, 'Step 3'), p('u-78', 'Note'), p(DUP, 'Step 4')],
    };
    vi.mocked(getPage).mockResolvedValue({ doc: corrupted, draft: null } as never);

    const res = await apply.handler(
      { page_id: PAGE_ID, ops: [{ op: 'update', block_id: DUP, markdown: 'Step 1 (rewritten)' }] },
      ctx,
    );

    expect(res.ok).toBe(true);
    const saved = vi.mocked(saveDraft).mock.calls[0]![2] as { content: Block[] };
    // The update landed on the FIRST occurrence, which keeps the id.
    expect(saved.content[0]!.content?.[0]?.text).toBe('Step 1 (rewritten)');
    expect(saved.content[0]!.attrs.id).toBe(DUP);
    // saveDraft runs ensureBlockIds in production — after that pass every
    // block is uniquely addressable (Steps 2–4 get fresh ids, Note keeps its).
    const healed = ensureBlockIds(saved as unknown as Record<string, unknown>) as unknown as {
      content: Block[];
    };
    const healedIds = healed.content.map((b) => b.attrs.id);
    expect(new Set(healedIds).size).toBe(healedIds.length);
    expect(healedIds[0]).toBe(DUP);
    expect(healedIds[3]).toBe('u-78');
  });

  it('is atomic: a bad op aborts with the op index and nothing is saved', async () => {
    const { doc, ids } = makeBaseline();
    vi.mocked(getPage).mockResolvedValue({ doc, draft: null } as never);

    const res = await apply.handler(
      {
        page_id: PAGE_ID,
        ops: [
          { op: 'update', block_id: ids[0], markdown: '## New title' },
          { op: 'delete', block_id: 'nope-not-a-block' },
        ],
      },
      ctx,
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("op 1 ('delete' nope-not-a-block)");
      expect(res.error).toContain('block not found');
      expect(res.error).toContain('NOTHING was saved');
    }
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it('teaches when a later op references a block deleted earlier in the batch', async () => {
    const { doc, ids } = makeBaseline();
    vi.mocked(getPage).mockResolvedValue({ doc, draft: null } as never);

    const res = await apply.handler(
      {
        page_id: PAGE_ID,
        ops: [
          { op: 'delete', block_id: ids[2] },
          { op: 'update', block_id: ids[2], markdown: 'resurrect?' },
        ],
      },
      ctx,
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('op 1');
      expect(res.error).toContain('earlier delete in this batch removes its id');
    }
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it('refuses update ops with empty markdown, pointing at delete', async () => {
    const { doc, ids } = makeBaseline();
    vi.mocked(getPage).mockResolvedValue({ doc, draft: null } as never);

    const res = await apply.handler(
      { page_id: PAGE_ID, ops: [{ op: 'update', block_id: ids[1] }] },
      ctx,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("use op:'delete'");
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it('refuses oversized batches with guidance toward page_update_draft', async () => {
    const { doc } = makeBaseline();
    vi.mocked(getPage).mockResolvedValue({ doc, draft: null } as never);
    const ops = Array.from({ length: 51 }, (_, i) => ({ op: 'delete', block_id: `b${i}` }));
    const res = await apply.handler({ page_id: PAGE_ID, ops }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('max 50');
      expect(res.error).toContain('page_update_draft');
    }
    expect(getPage).not.toHaveBeenCalled();
  });

  it('rejects unknown op kinds with the valid set', async () => {
    const { doc, ids } = makeBaseline();
    vi.mocked(getPage).mockResolvedValue({ doc, draft: null } as never);
    const res = await apply.handler(
      { page_id: PAGE_ID, ops: [{ op: 'replace', block_id: ids[0], markdown: 'x' }] },
      ctx,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("op must be one of: 'update', 'insert_after', 'delete'");
  });
});
