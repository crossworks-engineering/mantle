/**
 * Behavioural tests for page_block_delete and page_share.
 *
 * `deleteBlock` itself is left REAL here rather than stubbed, so the
 * container-empty refusal is exercised for what it is: most ProseMirror
 * schemas reject an empty callout / column / listItem / tableCell, so a delete
 * that would empty one has to be refused BEFORE the draft is written. A stub
 * would assert only that the tool forwards a flag.
 *
 * page_share is the page-specific twin of node_share, and it carries one extra
 * thing worth pinning: `children` cascades to every sub-page. That makes the
 * "unspecified" case load-bearing — omitting `children` must leave sub-page
 * links exactly as they are. Sharing a whole documentation subtree because the
 * argument was absent rather than false is the failure to avoid.
 *
 * Store edges (getPage / saveDraft / the share writes) are stubbed; the tools'
 * own guards, ordering and branching are real.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return {
    ...actual,
    getPage: vi.fn(),
    saveDraft: vi.fn(),
    createShare: vi.fn(),
    applyShareMode: vi.fn(),
    setShareCascade: vi.fn(),
    shareUrlForToken: (token: string) => `https://brain.test/s/${token}`,
  };
});
vi.mock('@mantle/files', () => ({ fileById: vi.fn(), readFileById: vi.fn() }));
vi.mock('@mantle/tracing', () => ({ recordIngest: vi.fn() }));

import { getPage, saveDraft, createShare, applyShareMode, setShareCascade } from '@mantle/content';
import { PAGE_TOOLS } from './builtins-pages';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const all = PAGE_TOOLS as readonly BuiltinToolDef[];
const blockDel = all.find((t) => t.slug === 'page_block_delete')!;
const share = all.find((t) => t.slug === 'page_share')!;

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

/** A top-level paragraph, plus a callout whose ONLY child is a paragraph.
 *  Deleting `b_inner` would leave the callout empty — the refusal case. */
const doc = () => ({
  type: 'doc',
  content: [
    { type: 'paragraph', attrs: { id: 'b_top' }, content: [{ type: 'text', text: 'hello' }] },
    {
      type: 'callout',
      attrs: { id: 'c_1' },
      content: [
        { type: 'paragraph', attrs: { id: 'b_inner' }, content: [{ type: 'text', text: 'in' }] },
      ],
    },
  ],
});

const page = (over: Record<string, unknown> = {}) => ({
  id: PAGE_ID,
  title: 'Runbook',
  tags: [],
  doc: doc(),
  draft: null,
  draftRev: 3,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPage).mockResolvedValue(page() as never);
  vi.mocked(saveDraft).mockResolvedValue({ ok: true, rev: 4 } as never);
  vi.mocked(createShare).mockResolvedValue({ id: 's-1', token: 'tok', mode: 'public' } as never);
  vi.mocked(setShareCascade).mockResolvedValue({ count: 3 } as never);
});

describe('page_block_delete', () => {
  it('requires both ids and writes nothing without them', async () => {
    expect(errorOf(await blockDel.handler({ page_id: PAGE_ID }, ctx))).toMatch(
      /page_id and block_id are required/,
    );
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it('reports a missing page with the lookup that fixes it', async () => {
    vi.mocked(getPage).mockResolvedValue(null as never);
    const res = await blockDel.handler({ page_id: PAGE_ID, block_id: 'b_top' }, ctx);
    expect(errorOf(res)).toMatch(/page_list|search_nodes/);
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it('tells the caller to refresh stale block ids, and writes nothing', async () => {
    const res = await blockDel.handler({ page_id: PAGE_ID, block_id: 'b_gone' }, ctx);
    // Block ids go stale whenever the page is edited elsewhere, so the
    // recovery move has to be in the message.
    expect(errorOf(res)).toMatch(/page_blocks_list/);
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it('REFUSES a delete that would empty its container, before writing', async () => {
    // The real deleteBlock decides this. Emptying a callout produces a doc
    // most ProseMirror schemas reject, so the page would fail to load — the
    // refusal is what keeps a valid document valid.
    const res = await blockDel.handler({ page_id: PAGE_ID, block_id: 'b_inner' }, ctx);
    const err = errorOf(res);
    // Assert it failed for the RIGHT reason. `ok:false` alone would also be
    // satisfied by "block not found", which would make this test pass while
    // proving nothing about the refusal.
    expect(err).not.toMatch(/page_blocks_list/);
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it('deletes a top-level block and threads the read rev into the write', async () => {
    const res = await blockDel.handler({ page_id: PAGE_ID, block_id: 'b_top' }, ctx);
    // baseRev is the rev we READ. Passing it means a user autosave landing
    // between the read and this write conflicts instead of being clobbered.
    expect(saveDraft).toHaveBeenCalledWith('o1', PAGE_ID, expect.anything(), { baseRev: 3 });
    const out = outputOf(res);
    expect(out.deleted).toBe(true);
    expect(out.draft_saved).toBe(true);
  });

  it('does NOT report a deletion when the draft moved under it', async () => {
    vi.mocked(saveDraft).mockResolvedValue({ ok: false, conflict: true, rev: 9 } as never);
    const res = await blockDel.handler({ page_id: PAGE_ID, block_id: 'b_top' }, ctx);
    // The block is still there. Anything that reads as success here tells the
    // model to move on from work it did not do.
    expect(res.ok).toBe(false);
  });
});

describe('page_share', () => {
  it('is confirm-gated', () => {
    expect(share.requiresConfirm).toBe(true);
  });

  it('refuses a blank id WITHOUT minting a share', async () => {
    expect(errorOf(await share.handler({ id: '  ' }, ctx))).toMatch(/id is required/);
    expect(createShare).not.toHaveBeenCalled();
  });

  it('will not mint a share for a page that does not exist', async () => {
    vi.mocked(getPage).mockResolvedValue(null as never);
    const res = await share.handler({ id: PAGE_ID }, ctx);
    expect(errorOf(res)).toMatch(/page_list|search_nodes/);
    expect(createShare).not.toHaveBeenCalled();
  });

  it('leaves sub-pages ALONE when children is not given', async () => {
    const res = await share.handler({ id: PAGE_ID }, ctx);
    // The load-bearing default. An absent `children` must not be read as
    // "cascade" — that would publish a whole subtree nobody asked about.
    expect(setShareCascade).not.toHaveBeenCalled();
    expect(outputOf(res)).not.toHaveProperty('subpagesShared');
  });

  it('cascades and reports the count when children is true', async () => {
    const res = await share.handler({ id: PAGE_ID, children: true }, ctx);
    expect(setShareCascade).toHaveBeenCalledWith('o1', PAGE_ID, true);
    expect(outputOf(res).subpagesShared).toBe(3);
  });

  it('revokes sub-page links when children is false', async () => {
    const res = await share.handler({ id: PAGE_ID, children: false }, ctx);
    expect(setShareCascade).toHaveBeenCalledWith('o1', PAGE_ID, false);
    // Reported under a DIFFERENT key, so the caller can tell "shared 3" from
    // "revoked 3" without inspecting the request it sent.
    expect(outputOf(res).subpagesRevoked).toBe(3);
  });

  it('sets the mode BEFORE cascading, so descendants inherit it', async () => {
    await share.handler({ id: PAGE_ID, mode: 'team', children: true }, ctx);
    const modeAt = vi.mocked(applyShareMode).mock.invocationCallOrder[0]!;
    const cascadeAt = vi.mocked(setShareCascade).mock.invocationCallOrder[0]!;
    // Reversed, the children are cascaded at the OLD mode and a "share this
    // section with the team" call leaves the sub-pages public.
    expect(modeAt).toBeLessThan(cascadeAt);
  });

  it('treats an unrecognised mode as unspecified, never as public', async () => {
    vi.mocked(createShare).mockResolvedValue({ id: 's-1', token: 'tok', mode: 'team' } as never);
    const res = await share.handler({ id: PAGE_ID, mode: 'everyone' }, ctx);
    expect(applyShareMode).not.toHaveBeenCalled();
    expect(outputOf(res).mode).toBe('team');
  });
});
