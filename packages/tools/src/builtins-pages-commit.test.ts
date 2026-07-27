/**
 * Tests for page_commit / page_discard_draft — the tools that let an agent
 * FINISH a page edit.
 *
 * The gap they close: every agent body-write lands in `draft_doc`, and until
 * v0.206 nothing but the editor could publish one. So an agent could edit a
 * page and then not finish — the draft sat shadowing the published doc for
 * every later block tool, and `page_get` returned both.
 *
 * What's worth pinning here is the branching, because each outcome means
 * something different to the caller and two of them are easy to conflate:
 * `noDraft` (nothing to do) and `conflict` (something to do, but NOT this)
 * are both "did not publish", and only the second one must never be retried
 * blindly. The DB edge (commitPageDraft/discardDraft) is stubbed; the tools'
 * own logic is real.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/content', () => ({
  commitPageDraft: vi.fn(),
  discardDraft: vi.fn(),
  docToText: () => 'body text',
  nodeUrl: (id: string) => `https://brain.test/n/${id}`,
  markdownToDoc: (md: string) => ({ type: 'doc', content: [{ type: 'paragraph', text: md }] }),
}));
vi.mock('@mantle/files', () => ({ fileById: vi.fn(), readFileById: vi.fn() }));
vi.mock('@mantle/tracing', () => ({ recordIngest: vi.fn() }));

import { commitPageDraft, discardDraft } from '@mantle/content';
import { recordIngest } from '@mantle/tracing';
import { PAGE_TOOLS } from './builtins-pages';
import type { ToolHandlerContext } from './types';

const commit = PAGE_TOOLS.find((t) => t.slug === 'page_commit')!;
const discard = PAGE_TOOLS.find((t) => t.slug === 'page_discard_draft')!;
const ctx: ToolHandlerContext = { ownerId: 'o1' };
const PAGE_ID = 'p1';

type Result = Awaited<ReturnType<(typeof commit)['handler']>>;

/** Narrow to the failure arm, asserting it IS one — an unexpected success
 *  fails here rather than silently skipping the assertions after it. */
function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): unknown {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output;
}

const published = {
  id: PAGE_ID,
  title: 'Runbook',
  tags: ['ops'],
  doc: { type: 'doc', content: [] },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('page_commit', () => {
  it('publishes the draft and reports the page it landed on', async () => {
    vi.mocked(commitPageDraft).mockResolvedValue({
      ok: true,
      page: published,
    } as unknown as Awaited<ReturnType<typeof commitPageDraft>>);

    const res = await commit.handler({ id: PAGE_ID }, ctx);

    expect(outputOf(res)).toMatchObject({ id: PAGE_ID, committed: true, title: 'Runbook' });
    expect(commitPageDraft).toHaveBeenCalledWith('o1', PAGE_ID);
  });

  it('records the ingest, because publishing is the moment the body reaches the brain', async () => {
    vi.mocked(commitPageDraft).mockResolvedValue({
      ok: true,
      page: published,
    } as unknown as Awaited<ReturnType<typeof commitPageDraft>>);

    await commit.handler({ id: PAGE_ID }, ctx);

    // Same `source` as the editor's own commit route, so an agent commit sits
    // alongside a human one in the biography rather than being invisible.
    expect(recordIngest).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'page_commit', nodeId: PAGE_ID, ownerId: 'o1' }),
    );
  });

  it('says there is nothing to commit rather than implying a failure', async () => {
    vi.mocked(commitPageDraft).mockResolvedValue({ ok: false, noDraft: true });

    const res = await commit.handler({ id: PAGE_ID }, ctx);

    expect(errorOf(res)).toMatch(/no draft/i);
    // The distinction that matters: nothing is wrong and nothing is pending.
    expect(errorOf(res)).toMatch(/already current/i);
  });

  it('reports a conflict as "nothing published, re-read" — never as a retryable no-op', async () => {
    // An editor autosave landed between reading the draft and publishing it.
    vi.mocked(commitPageDraft).mockResolvedValue({ ok: false, conflict: true, rev: 7 });

    const res = await commit.handler({ id: PAGE_ID }, ctx);

    expect(errorOf(res)).toContain('7');
    expect(errorOf(res)).toMatch(/nothing was published/i);
    // Retrying blind would publish over someone's newer edit.
    expect(errorOf(res)).toMatch(/re-read/i);
    expect(recordIngest).not.toHaveBeenCalled();
  });

  it('reports a missing page with the lookup tool to try', async () => {
    vi.mocked(commitPageDraft).mockResolvedValue({ ok: false, missing: true });

    const res = await commit.handler({ id: PAGE_ID }, ctx);

    expect(errorOf(res)).toMatch(/page_list/);
  });

  it('rejects a blank id without touching the DB', async () => {
    const res = await commit.handler({ id: '  ' }, ctx);
    expect(errorOf(res)).toMatch(/id is required/);
    expect(commitPageDraft).not.toHaveBeenCalled();
  });
});

describe('page_discard_draft', () => {
  it('discards the draft', async () => {
    vi.mocked(discardDraft).mockResolvedValue(true);

    const res = await discard.handler({ id: PAGE_ID }, ctx);

    expect(outputOf(res)).toMatchObject({ id: PAGE_ID, discarded: true });
    expect(discardDraft).toHaveBeenCalledWith('o1', PAGE_ID);
  });

  it('reports a missing page rather than a silent success', async () => {
    vi.mocked(discardDraft).mockResolvedValue(false);

    const res = await discard.handler({ id: PAGE_ID }, ctx);

    expect(errorOf(res)).toMatch(/page_list/);
  });

  it('does not re-index — the published body never changed', async () => {
    vi.mocked(discardDraft).mockResolvedValue(true);

    await discard.handler({ id: PAGE_ID }, ctx);

    expect(recordIngest).not.toHaveBeenCalled();
  });
});
