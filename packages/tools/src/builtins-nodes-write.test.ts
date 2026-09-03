/**
 * Behavioural tests for content_supersede: the one curation WRITE in the
 * generic node group. It had no test.
 *
 * Supersession re-weights retrieval for the whole brain, which is why the
 * tool refuses on the team and forum surfaces: a member contact must not be
 * able to demote the owner's content by asking the assistant nicely. That
 * refusal has to fire BEFORE the store is touched, and it has to be keyed on
 * `ctx.surface` (runtime-stamped), not on anything in the arguments.
 *
 * The other property is the successor check. A dangling `superseded_by`
 * would produce a mark that points at nothing, so the store rejects it; the
 * tool must turn that particular rejection into a corrective error naming
 * the lookups, not a raw message.
 *
 * `supersedeNode` / `unsupersedeNode` are stubbed; the tool's surface gate,
 * clear-vs-mark branching and error mapping are real.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return {
    ...actual,
    supersedeNode: vi.fn(),
    unsupersedeNode: vi.fn(),
    nodeUrl: (id: string) => `https://brain.test/n/${id}`,
  };
});
vi.mock('@mantle/search', () => ({ resolveSupersededTargets: vi.fn() }));

import { supersedeNode, unsupersedeNode } from '@mantle/content';
import { CONTENT_CURATION_TOOLS } from './builtins-nodes';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const teamCtx: ToolHandlerContext = { ownerId: 'o1', surface: { kind: 'team', contactId: 'c1' } };
const OLD = '11111111-2222-4333-8444-555555555555';
const NEW = '22222222-2222-4333-8444-555555555555';

const supersede = CONTENT_CURATION_TOOLS.find((t) => t.slug === 'content_supersede')!;

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(supersedeNode).mockResolvedValue({
    id: OLD,
    title: 'Old spec',
    supersededBy: NEW,
    supersededReason: 'migrated',
  } as never);
  vi.mocked(unsupersedeNode).mockResolvedValue({
    id: OLD,
    title: 'Old spec',
    supersededBy: null,
    supersededReason: null,
  } as never);
});

describe('content_supersede', () => {
  it('refuses on the team surface BEFORE touching the store', async () => {
    const err = errorOf(await supersede.handler({ node_id: OLD, superseded_by: NEW }, teamCtx));
    expect(err).toMatch(/owner-side only/);
    expect(err).toMatch(/team_request_create/);
    expect(supersedeNode).not.toHaveBeenCalled();
    expect(unsupersedeNode).not.toHaveBeenCalled();
  });

  it('refuses a blank node_id without calling the store', async () => {
    expect(errorOf(await supersede.handler({ node_id: '  ' }, ctx))).toMatch(/node_id/);
    expect(supersedeNode).not.toHaveBeenCalled();
  });

  it('marks under the owner with the successor and reason, and says it is reversible', async () => {
    const res = await supersede.handler(
      { node_id: OLD, superseded_by: NEW, reason: 'migrated' },
      ctx,
    );

    expect(supersedeNode).toHaveBeenCalledWith({
      ownerId: 'o1',
      id: OLD,
      supersededBy: NEW,
      reason: 'migrated',
    });
    expect(unsupersedeNode).not.toHaveBeenCalled();
    expect(outputOf(res)).toMatchObject({ id: OLD, superseded_by: NEW, reason: 'migrated' });
    expect(String(outputOf(res).note)).toMatch(/not deleted/);
  });

  it("a bare mark defaults to reason 'corrected' with no successor", async () => {
    await supersede.handler({ node_id: OLD }, ctx);
    expect(supersedeNode).toHaveBeenCalledWith({
      ownerId: 'o1',
      id: OLD,
      supersededBy: null,
      reason: 'corrected',
    });
  });

  it('clear:true takes the un-mark path and never calls the mark', async () => {
    const res = await supersede.handler({ node_id: OLD, clear: true, superseded_by: NEW }, ctx);

    expect(unsupersedeNode).toHaveBeenCalledWith('o1', OLD);
    expect(supersedeNode).not.toHaveBeenCalled();
    expect(outputOf(res)).toMatchObject({ id: OLD, cleared: true });
  });

  it('turns a dangling successor into a corrective error naming the lookups', async () => {
    vi.mocked(supersedeNode).mockRejectedValue(new Error('successor node not found'));

    const err = errorOf(await supersede.handler({ node_id: OLD, superseded_by: NEW }, ctx));

    expect(err).toContain(NEW);
    expect(err).toMatch(/search_nodes/);
    expect(err).toMatch(/page_list/);
  });

  it('passes any other store failure through as-is', async () => {
    vi.mocked(supersedeNode).mockRejectedValue(new Error('emails cannot be superseded'));
    expect(errorOf(await supersede.handler({ node_id: OLD }, ctx))).toMatch(
      /emails cannot be superseded/,
    );
  });
});
