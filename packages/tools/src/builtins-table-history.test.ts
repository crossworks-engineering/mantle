/**
 * The table history tools (apps first-class plan, Phase 4): table_history,
 * table_snapshot_create, table_snapshot_restore, table_snapshot_delete.
 *
 * The store (table-snapshots.ts) is stubbed and pinned on Postgres in
 * table-snapshots.db.test.ts. What the tools own: the owner-only refusal,
 * the confirmation gates, the actor a row names, the commit after a restore
 * when asked, and errors that say what to do next.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mantle/content/table-snapshots', () => ({
  listTableSnapshots: vi.fn(),
  createTableSnapshot: vi.fn(),
  restoreTableSnapshot: vi.fn(),
  deleteTableSnapshot: vi.fn(),
}));
vi.mock('@mantle/content', async (orig) => ({
  ...(await orig<typeof import('@mantle/content')>()),
  commitTable: vi.fn(async () => ({})),
}));

import { commitTable } from '@mantle/content';
import {
  createTableSnapshot,
  deleteTableSnapshot,
  listTableSnapshots,
  restoreTableSnapshot,
} from '@mantle/content/table-snapshots';
import { TABLE_TOOLS } from './builtins-tables';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const tool = (slug: string) => TABLE_TOOLS.find((t) => t.slug === slug)!;

const chat: ToolHandlerContext = { ownerId: 'o1', surface: { kind: 'web' } };
const mcp: ToolHandlerContext = { ownerId: 'o1', surface: { kind: 'owner', via: 'mcp' } };
const member: ToolHandlerContext = { ownerId: 'o1', surface: { kind: 'team', loginId: 'm1' } };
const TABLE = '11111111-2222-4333-8444-555555555555';
const SNAP = '99999999-2222-4333-8444-555555555555';
const ENTRY = { id: SNAP, seq: 3, trigger: 'commit', note: null, tableVersion: 2, bytes: 4096 };

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;
const errorOf = (res: Result) => {
  if (res.ok) throw new Error(`expected a failure, got ${JSON.stringify(res.output)}`);
  return res.error;
};
const outputOf = (res: Result) => {
  if (!res.ok) throw new Error(`expected success, got ${res.error}`);
  return res.output as Record<string, unknown>;
};

beforeEach(() => vi.clearAllMocks());

describe('the table history tools: who may run them', () => {
  it('all four are owner-only; restore and delete are confirm-gated', () => {
    for (const slug of [
      'table_history',
      'table_snapshot_create',
      'table_snapshot_restore',
      'table_snapshot_delete',
    ]) {
      expect(tool(slug).ownerOnly, slug).toBe(true);
    }
    expect(tool('table_snapshot_restore').requiresConfirm).toBe(true);
    expect(tool('table_snapshot_delete').requiresConfirm).toBe(true);
    expect(tool('table_history').readOnly).toBe(true);
  });
});

describe('table_history', () => {
  it('lists the entries; a member is refused', async () => {
    vi.mocked(listTableSnapshots).mockResolvedValueOnce([ENTRY] as never);
    expect(outputOf(await tool('table_history').handler({ id: TABLE }, chat))).toEqual({
      id: TABLE,
      entries: [ENTRY],
    });
    expect(listTableSnapshots).toHaveBeenCalledWith('o1', TABLE, { limit: 50 });
    expect(errorOf(await tool('table_history').handler({ id: TABLE }, member))).toMatch(/owner/);
  });
});

describe('table_snapshot_create', () => {
  it('takes a snapshot with the note and the actor; passes a refusal on', async () => {
    vi.mocked(createTableSnapshot).mockResolvedValueOnce({ ...ENTRY, trigger: 'manual' } as never);
    const out = outputOf(
      await tool('table_snapshot_create').handler({ id: TABLE, note: 'before import' }, mcp),
    );
    expect(out).toMatchObject({ id: TABLE, snapshot: { seq: 3 } });
    expect(createTableSnapshot).toHaveBeenCalledWith('o1', TABLE, {
      note: 'before import',
      actor: 'mcp',
    });
    vi.mocked(createTableSnapshot).mockRejectedValueOnce(
      new Error('snapshots already hold 2048 MB'),
    );
    expect(errorOf(await tool('table_snapshot_create').handler({ id: TABLE }, chat))).toMatch(
      /2048 MB/,
    );
    vi.mocked(createTableSnapshot).mockResolvedValueOnce(null);
    expect(errorOf(await tool('table_snapshot_create').handler({ id: TABLE }, chat))).toMatch(
      /table_list/,
    );
  });
});

describe('table_snapshot_restore', () => {
  const restore = tool('table_snapshot_restore');

  it('restores into the draft and says how to publish it', async () => {
    vi.mocked(restoreTableSnapshot).mockResolvedValueOnce({ restored: ENTRY } as never);
    const out = outputOf(await restore.handler({ id: TABLE, snapshot_id: SNAP }, chat));
    expect(out).toMatchObject({
      id: TABLE,
      committed: false,
      next: expect.stringMatching(/table_commit/),
    });
    expect(restoreTableSnapshot).toHaveBeenCalledWith('o1', TABLE, SNAP, { discardDraft: false });
    expect(commitTable).not.toHaveBeenCalled();
  });

  it('commits at once when asked, noting the restore on the replaced version', async () => {
    vi.mocked(restoreTableSnapshot).mockResolvedValueOnce({ restored: ENTRY } as never);
    const out = outputOf(
      await restore.handler(
        { id: TABLE, snapshot_id: SNAP, discard_draft: true, commit: true },
        mcp,
      ),
    );
    expect(out).toMatchObject({ committed: true });
    expect(restoreTableSnapshot).toHaveBeenCalledWith('o1', TABLE, SNAP, { discardDraft: true });
    expect(commitTable).toHaveBeenCalledWith('o1', TABLE, undefined, {
      actor: 'mcp',
      note: 'replaced by restoring v3',
    });
  });

  it('teaches the next move: a draft in the way, an unknown entry, a member', async () => {
    vi.mocked(restoreTableSnapshot).mockRejectedValueOnce(
      new Error('the table has an unpublished draft … pass discard_draft'),
    );
    expect(errorOf(await restore.handler({ id: TABLE, snapshot_id: SNAP }, chat))).toMatch(
      /discard_draft/,
    );
    vi.mocked(restoreTableSnapshot).mockResolvedValueOnce(null);
    expect(errorOf(await restore.handler({ id: TABLE, snapshot_id: SNAP }, chat))).toMatch(
      /table_history/,
    );
    expect(errorOf(await restore.handler({ id: TABLE, snapshot_id: SNAP }, member))).toMatch(
      /owner/,
    );
    expect(commitTable).not.toHaveBeenCalled();
  });
});

describe('table_snapshot_delete', () => {
  const del = tool('table_snapshot_delete');

  it('deletes an entry, and says where to look when it is not there', async () => {
    vi.mocked(deleteTableSnapshot).mockResolvedValueOnce(true);
    expect(outputOf(await del.handler({ id: TABLE, snapshot_id: SNAP }, chat))).toEqual({
      id: TABLE,
      deleted: SNAP,
    });
    expect(deleteTableSnapshot).toHaveBeenCalledWith('o1', TABLE, SNAP);
    vi.mocked(deleteTableSnapshot).mockResolvedValueOnce(false);
    expect(errorOf(await del.handler({ id: TABLE, snapshot_id: SNAP }, chat))).toMatch(
      /table_history/,
    );
    expect(errorOf(await del.handler({ id: TABLE, snapshot_id: SNAP }, member))).toMatch(/owner/);
  });
});
