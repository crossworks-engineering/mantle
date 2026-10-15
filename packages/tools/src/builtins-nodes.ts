/**
 * Builtins: node_read, brain_capacity, content_supersede, process_extraction — generic node reads + curation + ingest.
 *
 * Split out of builtins.ts on 2026-09-02 (audit, bloat B6) with behaviour
 * unchanged; builtins.ts assembles BUILTIN_TOOLS from these groups.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, nodes, resignalNode, workspaces } from '@mantle/db';
import { resolveSupersededTargets } from '@mantle/search';
import { corpusCapacity, nodeUrl, supersedeNode, unsupersedeNode } from '@mantle/content';
import { areaSystem } from './admin-gate';
import { type BuiltinToolDef } from './types';
import { str, strOpt, numOpt as num } from './coerce';
import { errorMessage } from '@mantle/std';
import { NODE_ID_PRE } from './builtins-common';
import { HIDDEN_NODE_ERROR, surfaceHiddenNodeTypes } from './team-visibility';
import { isOwnerSurface } from './surface';
import { edit, read } from './item-write-gate';
import { CS } from './client-sourced-rule';

export const brain_capacity: BuiltinToolDef = {
  slug: 'brain_capacity',
  policy: { effect: 'read', spends: 'none', scope: { area: 'settings' } },
  name: 'Check brain capacity',
  description:
    "Corpus size vs the split policy: document and passage-vector counts with a zone per axis — 'green' (no action), 'watch' (run recall checks, identify the growing category), 'split' (break the dominant category into a federated breakout brain). Use for capacity/health checks and scheduled monitoring; alert the user when the zone is not green. Read-only.",
  inputSchema: { type: 'object', properties: {} },
  handler: async (_input, ctx) => {
    // The split policy is the whole brain's (W7a fix round 2): two counts on
    // the system pool after the settings area check, numbers and never a
    // row; the latest recall score's note is read in the caller's scope.
    const capacity = await corpusCapacity(ctx.ownerId, {
      countsVia: (fn) => areaSystem('settings', fn),
    });
    ctx.step?.setMeta({ zone: capacity.zone, pct_of_split: capacity.pctOfSplit });
    return { ok: true, output: capacity };
  },
};

// ─── files / folders ──────────────────────────────────────────────────────

export const node_read: BuiltinToolDef = {
  slug: 'node_read',
  usageTier: 6,
  policy: { effect: 'read', spends: 'none', scope: 'any' },
  name: 'Read a node',
  description:
    'Universal reader — read the full content of any node by id. Returns title, type, tags, path, summary, and the full `data` blob (markdown body for notes, body+location+starts_at for events, status+due_at for tasks, etc.). ' +
    '**Prefer type-specific readers when available** — `note_get` / `event_get` / `task_get` / `page_get` / `email_get` — they return cleaner shapes for their type. ' +
    "For nodes of `type='file'` the body lives in object storage — use `file_read` instead. This tool is the fallback that works for any node type (incl. secret, sermon, contact, telegram_message). " +
    'Returns a `url` permalink — link the item as a markdown `[title](url)` when you reference it to the user.',
  preconditions: NODE_ID_PRE,
  inputSchema: {
    type: 'object',
    properties: {
      node_id: {
        type: 'string',
        format: 'uuid',
        description: "The node's id (UUID) — from `search_nodes` / `tree_list` or any list tool.",
      },
    },
    required: ['node_id'],
  },
  handler: async (input, ctx) => {
    const nodeId = str(input.node_id);
    if (!nodeId) return { ok: false, error: 'node_id required' };
    const [row] = await db
      .select({
        id: nodes.id,
        type: nodes.type,
        title: nodes.title,
        path: nodes.path,
        tags: nodes.tags,
        data: nodes.data,
        supersededBy: nodes.supersededBy,
        supersededReason: nodes.supersededReason,
        createdAt: nodes.createdAt,
        updatedAt: nodes.updatedAt,
      })
      .from(nodes)
      .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ctx.ownerId)))
      .limit(1);
    if (!row || surfaceHiddenNodeTypes(ctx.surface)?.includes(row.type))
      return { ok: false, error: HIDDEN_NODE_ERROR };
    ctx.step?.setOutput({ type: row.type });
    // Content-currency annotation: reading a superseded node names its living
    // successor so stale content is never presented as current.
    const succ = row.supersededBy
      ? (await resolveSupersededTargets(ctx.ownerId, [row.id])).get(row.id)
      : undefined;
    return {
      ok: true,
      output: {
        id: row.id,
        type: row.type,
        title: row.title,
        path: row.path,
        tags: row.tags,
        url: nodeUrl(row.id),
        data: row.data,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        ...(succ
          ? {
              superseded_by: {
                id: succ.id,
                title: succ.title,
                url: nodeUrl(succ.id),
                note: 'SUPERSEDED — prefer this successor; do not present the old copy as current.',
              },
            }
          : {}),
        // A bare mark (or a dangling successor) has no pointer to offer but
        // must still read as outdated.
        ...(row.supersededReason && !succ
          ? {
              superseded: {
                reason: row.supersededReason,
                note: 'MARKED OUTDATED — no living successor recorded; treat the content with caution.',
              },
            }
          : {}),
      },
    };
  },
};

/** The workspaces other than Admin that read an item, by name. */
async function readingWorkspaces(nodeId: string): Promise<string[]> {
  const rows = await db
    .select({ name: workspaces.name })
    .from(nodes)
    .innerJoin(workspaces, sql`${workspaces.id} = any(${nodes.readWs})`)
    .where(and(eq(nodes.id, nodeId), eq(workspaces.isAdmin, false)))
    .orderBy(workspaces.name);
  return rows.map((r) => r.name);
}

export const content_supersede: BuiltinToolDef = {
  slug: 'content_supersede',
  policy: {
    effect: 'write',
    spends: 'none',
    scope: 'admin',
    items: [edit('node_id')],
    clientSourced: CS.onNodes('node_id', 'superseded_by'),
  },
  ownerOnly: true,
  name: 'Mark content superseded',
  description:
    'Mark a node OUTDATED, optionally naming its replacement — the old copy is down-weighted in retrieval, and when a replacement is named every future hit on it carries a "superseded by" pointer to the successor (a bare mark down-weights only). Returns the updated mark. ' +
    'Use when the user says content is stale, wrong, or replaced ("this file is outdated — the page is the current version"). For deleting content outright use the type\'s delete tool instead; this is the reversible, history-preserving move. ' +
    'Pass `clear: true` to un-mark (restores full weight); omit `superseded_by` for a bare outdated mark. ' +
    '`page_from_file` / `page_from_note` stamp this automatically; use this for corrections and lineage the system could not see.',
  preconditions: NODE_ID_PRE,
  inputSchema: {
    type: 'object',
    properties: {
      node_id: {
        type: 'string',
        format: 'uuid',
        description:
          'the outdated node (file, page, note, … — not emails or folders; those are refused)',
      },
      superseded_by: {
        type: 'string',
        format: 'uuid',
        description:
          'the node that replaces it, e.g. the corrected page built from a stale file; omit for a bare "outdated" mark',
      },
      reason: {
        type: 'string',
        enum: ['version', 'migrated', 'corrected'],
        default: 'corrected',
        description:
          "why: 'migrated' (content moved to the successor), 'corrected' (the old content is wrong — demotes harder), 'version' (an older export of the same artifact)",
      },
      clear: {
        type: 'boolean',
        default: false,
        description: 'un-mark instead: clear the supersession and restore full retrieval weight',
      },
    },
    required: ['node_id'],
  },
  handler: async (input, ctx) => {
    // Members and clients must not re-weight the owner's brain: curation is
    // an owner-side action (the other owner-only tools refuse the same way).
    if (!isOwnerSurface(ctx.surface)) {
      return {
        ok: false,
        error:
          'content_supersede is owner-side only: ask the owner (or file a request with team_request_create) instead of re-weighting content directly.',
      };
    }
    const nodeId = str(input.node_id).trim();
    if (!nodeId) return { ok: false, error: 'node_id required' };
    try {
      if (input.clear === true) {
        const row = await unsupersedeNode(ctx.ownerId, nodeId);
        ctx.step?.setOutput({ id: row.id, cleared: true });
        return {
          ok: true,
          output: { id: row.id, title: row.title, cleared: true },
        };
      }
      const successorId = str(input.superseded_by).trim() || null;
      const reason = (strOpt(input.reason) ?? 'corrected') as 'version' | 'migrated' | 'corrected';
      const row = await supersedeNode({
        ownerId: ctx.ownerId,
        id: nodeId,
        supersededBy: successorId,
        reason,
      });
      ctx.step?.setOutput({ id: row.id, superseded_by: successorId, reason });
      // Superseding re-weights; it never changes who reads it. An old version
      // that workspaces other than Admin read stays readable there, so say so
      // (and how to hide it).
      const stillVisible = await readingWorkspaces(row.id);
      return {
        ok: true,
        output: {
          id: row.id,
          title: row.title,
          superseded_by: row.supersededBy,
          reason: row.supersededReason,
          note: 'Down-weighted in retrieval (reversible with clear: true) — not deleted.',
          ...(stillVisible.length
            ? {
                warning: `The old version is still visible in ${stillVisible.join(', ')}: superseding does not change who can open it. To hide it, remove ${stillVisible.length === 1 ? 'that workspace' : 'those workspaces'} in its Grant Access panel.`,
              }
            : {}),
        },
      };
    } catch (err) {
      const msg = errorMessage(err);
      if (msg.includes('successor node not found')) {
        return {
          ok: false,
          error: `superseded_by '${str(input.superseded_by)}' is not one of the user's nodes — find the replacement's id with search_nodes / page_list, then re-issue.`,
        };
      }
      return { ok: false, error: msg };
    }
  },
};

export const process_extraction: BuiltinToolDef = {
  slug: 'process_extraction',
  policy: {
    effect: 'write',
    spends: 'ownerKey',
    scope: 'any',
    items: [read('node_id')],
    clientSourced: CS.onNodes('node_id'),
  },
  name: 'Kick the extractor',
  description:
    "Re-fires the pg_notify('node_ingested') signal for any nodes missing data.summary or embedding. Optional `node_id` to target a single node; optional `types` to restrict by node kind; optional `limit` to cap (default 100). Idempotent — already-extracted nodes are short-circuited by the extractor.",
  preconditions: NODE_ID_PRE,
  inputSchema: {
    type: 'object',
    properties: {
      node_id: {
        type: 'string',
        format: 'uuid',
        description: 'optional single node to re-extract',
      },
      types: {
        type: 'array',
        items: { type: 'string' },
        description: 'optional node-type filter (e.g. ["file","note"])',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 1000,
        default: 100,
        description: 'Max nodes to re-signal in one sweep.',
      },
    },
  },
  handler: async (input, ctx) => {
    const limit = num(input.limit, 100) ?? 100;
    if (typeof input.node_id === 'string' && input.node_id) {
      // Fire for exactly one node, no eligibility check — operator chose it.
      // Only a node the caller reads (W7a fix round 1, L1): read in its
      // scope first, so an id from another workspace starts no model work.
      const nodeId = input.node_id.trim();
      const [seen] = await db
        .select({ id: nodes.id })
        .from(nodes)
        .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ctx.ownerId)))
        .limit(1);
      if (!seen) {
        return {
          ok: false,
          error: `node ${nodeId} not found: find the id with search_nodes, then re-issue.`,
        };
      }
      await resignalNode(nodeId);
      ctx.step?.setOutput({ fired: 1, node_id: input.node_id });
      return { ok: true, output: { fired: 1, node_id: input.node_id } };
    }
    const typeFilter = Array.isArray(input.types) ? (input.types as string[]) : null;
    const conds = [
      eq(nodes.ownerId, ctx.ownerId),
      sql`${nodes.type} <> 'branch'`,
      sql`${nodes.type} <> 'secret'`,
      sql`(${nodes.data}->>'summary' is null or ${nodes.embedding} is null)`,
      // A row the clean-derived mark flagged has no summary on purpose (its
      // old one is set aside, workspaces plan 5.3). Re-folded ones too: they
      // get a summary only from their next edit or a per-node call (node_id
      // above), never from a sweep, so a sweep never spends a model call on
      // the marked rows of a whole brain at once (cost).
      sql`not ${nodes.derivedMixed}`,
    ];
    if (typeFilter && typeFilter.length > 0) {
      conds.push(inArray(sql`${nodes.type}::text`, typeFilter));
    }
    const rows = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(...conds))
      .orderBy(desc(nodes.createdAt))
      .limit(limit);
    for (const r of rows) await resignalNode(r.id);
    ctx.step?.setOutput({ fired: rows.length });
    return { ok: true, output: { fired: rows.length } };
  },
};

export const NODE_READ_TOOLS: readonly BuiltinToolDef[] = [node_read, brain_capacity];

/** Mark content superseded so retrieval prefers the living copy. */
export const CONTENT_CURATION_TOOLS: readonly BuiltinToolDef[] = [content_supersede];

/** Kick off content extraction on an uploaded or referenced source. */
export const INGEST_TOOLS: readonly BuiltinToolDef[] = [process_extraction];
