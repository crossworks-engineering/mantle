/**
 * Table history (apps first-class plan, Phase 4): the line of versions a
 * table keeps. Each commit keeps the published table it replaces; the owner
 * can take a snapshot by hand; a restore puts a version back into the DRAFT
 * (and commits it when asked). The store is @mantle/content/table-snapshots.
 * Owner only: the history is admin data. Restore and delete are
 * confirm-gated.
 */
import { commitTable } from '@mantle/content';
import {
  createTableSnapshot,
  deleteTableSnapshot,
  listTableSnapshots,
  restoreTableSnapshot,
} from '@mantle/content/table-snapshots';
import { errorMessage } from '@mantle/std';
import type { BuiltinToolDef, ToolHandlerContext } from '../types';
import { str } from '../coerce';
import { notFound } from '../errors';
import { isOwnerSurface, OWNER_ONLY_ERROR } from '../surface';
import { TABLE_NODE_ID_PRE } from './common';

const ID = { type: 'string', description: "The table's id (UUID) — from `table_list`." };
const SNAPSHOT_ID = {
  type: 'string',
  description: 'The history entry id, from `table_history`.',
};

function refusal(ctx: ToolHandlerContext): { ok: false; error: string } | null {
  return isOwnerSurface(ctx.surface) ? null : { ok: false, error: OWNER_ONLY_ERROR };
}

/** Who a history row names: the owner's MCP client, or an agent. */
export function tableHistoryActor(ctx: ToolHandlerContext): 'mcp' | 'agent' {
  return ctx.surface?.kind === 'owner' && ctx.surface.via === 'mcp' ? 'mcp' : 'agent';
}

/** A refusal's message (a draft in the way, an app table, the budget) says
 *  what to do instead; it is passed on as it is. */
function historyError(err: unknown): { ok: false; error: string } {
  return { ok: false, error: errorMessage(err) };
}

export const table_history: BuiltinToolDef = {
  slug: 'table_history',
  ownerOnly: true,
  readOnly: true,
  preconditions: TABLE_NODE_ID_PRE,
  name: "List a table's history",
  description:
    "List a table's history, newest first: each commit keeps the published table it replaced (`commit`), and the owner's own snapshots (`manual`). Each entry has its id, seq (v1, v2 …), the table version it holds, when, who, its note and size. Use it to find the entry to pass to `table_snapshot_restore`.",
  inputSchema: {
    type: 'object',
    properties: {
      id: ID,
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 200,
        default: 50,
        description: 'Max entries to return.',
      },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const refused = refusal(ctx);
    if (refused) return refused;
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    try {
      const entries = await listTableSnapshots(ctx.ownerId, id, {
        limit: typeof input.limit === 'number' ? input.limit : 50,
      });
      ctx.step?.setOutput({ id, count: entries.length });
      return { ok: true, output: { id, entries } };
    } catch (err) {
      return historyError(err);
    }
  },
};

export const table_snapshot_create: BuiltinToolDef = {
  slug: 'table_snapshot_create',
  ownerOnly: true,
  preconditions: TABLE_NODE_ID_PRE,
  name: 'Snapshot a table',
  description:
    "Keep a copy of a table's published data now, as a `manual` entry on its history that is never pruned. Commits already keep the version they replace (the newest 20), so take one before a big change you may want to come back to much later. Refused past the owner's snapshot budget: delete old ones with `table_snapshot_delete`.",
  inputSchema: {
    type: 'object',
    properties: {
      id: ID,
      note: {
        type: 'string',
        maxLength: 500,
        description: "Why, shown on the history, e.g. 'before the price import'.",
      },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const refused = refusal(ctx);
    if (refused) return refused;
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    try {
      const snap = await createTableSnapshot(ctx.ownerId, id, {
        note: str(input.note) || null,
        actor: tableHistoryActor(ctx),
      });
      if (!snap) return notFound('table', id, 'table_list');
      ctx.step?.setOutput({ id, seq: snap.seq });
      return { ok: true, output: { id, snapshot: snap } };
    } catch (err) {
      return historyError(err);
    }
  },
};

export const table_snapshot_restore: BuiltinToolDef = {
  slug: 'table_snapshot_restore',
  ownerOnly: true,
  requiresConfirm: true,
  preconditions: TABLE_NODE_ID_PRE,
  name: 'Restore a table from its history',
  description:
    "Put an entry from `table_history` back into the table's DRAFT (the whole workbook: every tab, column and row). The published table is untouched until a commit; pass commit true to publish it at once. The commit keeps the version it replaces, so a restore can be undone the same way. Refused over an unpublished draft unless discard_draft is true, and for an app table (the app is its master). Confirm with the user first.",
  inputSchema: {
    type: 'object',
    properties: {
      id: ID,
      snapshot_id: SNAPSHOT_ID,
      discard_draft: {
        type: 'boolean',
        default: false,
        description: 'True: drop the unpublished draft the restore replaces.',
      },
      commit: {
        type: 'boolean',
        default: false,
        description: 'True: commit the restored draft right away (it goes live and is re-indexed).',
      },
    },
    required: ['id', 'snapshot_id'],
  },
  handler: async (input, ctx) => {
    const refused = refusal(ctx);
    if (refused) return refused;
    const id = str(input.id).trim();
    const snapshotId = str(input.snapshot_id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    if (!snapshotId) return { ok: false, error: 'snapshot_id is required' };
    try {
      const res = await restoreTableSnapshot(ctx.ownerId, id, snapshotId, {
        discardDraft: input.discard_draft === true,
      });
      if (!res) {
        return {
          ok: false,
          error: `table ${id} or entry ${snapshotId} not found: list the entries with table_history`,
        };
      }
      let committed = false;
      if (input.commit === true) {
        await commitTable(ctx.ownerId, id, undefined, {
          actor: tableHistoryActor(ctx),
          note: `replaced by restoring v${res.restored.seq}`,
        });
        committed = true;
      }
      ctx.step?.setOutput({ id, restored: res.restored.seq, committed });
      return {
        ok: true,
        output: {
          id,
          restored: res.restored,
          committed,
          ...(committed
            ? {}
            : { next: 'review the draft at /tables/' + id + ', then table_commit' }),
        },
      };
    } catch (err) {
      return historyError(err);
    }
  },
};

export const table_snapshot_delete: BuiltinToolDef = {
  slug: 'table_snapshot_delete',
  ownerOnly: true,
  requiresConfirm: true,
  preconditions: TABLE_NODE_ID_PRE,
  name: "Delete an entry from a table's history",
  description:
    "Delete one entry from a table's history (`table_history`) and its copy of the data, to free space. That version cannot be restored after. The table itself is not touched. Confirm with the user first.",
  inputSchema: {
    type: 'object',
    properties: { id: ID, snapshot_id: SNAPSHOT_ID },
    required: ['id', 'snapshot_id'],
  },
  handler: async (input, ctx) => {
    const refused = refusal(ctx);
    if (refused) return refused;
    const id = str(input.id).trim();
    const snapshotId = str(input.snapshot_id).trim();
    if (!id || !snapshotId) return { ok: false, error: 'id and snapshot_id are required' };
    try {
      const gone = await deleteTableSnapshot(ctx.ownerId, id, snapshotId);
      if (!gone) {
        return {
          ok: false,
          error: `entry ${snapshotId} is not on table ${id}'s history: list them with table_history`,
        };
      }
      ctx.step?.setOutput({ id, deleted: snapshotId });
      return { ok: true, output: { id, deleted: snapshotId } };
    } catch (err) {
      return historyError(err);
    }
  },
};

export const TABLE_HISTORY_TOOLS: BuiltinToolDef[] = [
  table_history,
  table_snapshot_create,
  table_snapshot_restore,
  table_snapshot_delete,
];
