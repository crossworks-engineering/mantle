/**
 * Builtins: the approval queue as an MCP client sees it, and the runner's
 * worker groups.
 *
 * An MCP client is the person's agent, not the person (owner decision,
 * 2026-11-07), and an agent cannot approve its own held call. So over MCP the
 * queue can be read and a call rejected, since rejecting only narrows. A person
 * approves in the app (PATCH /api/pending/:id) or on a Telegram card, both
 * through approvePendingCall (pending.ts).
 *
 * Every def here is `mcpOnly`: never seeded and never grantable (see
 * BuiltinToolDef.mcpOnly), so no in-app agent holds them either.
 */

import { and, eq } from 'drizzle-orm';
import { agentGroups, agents, db, onNarrowSpots, onFullSystemRoute } from '@mantle/db';
import { currentWorkspaceScope } from '@mantle/db/viewer';
import { type BuiltinToolDef } from './types';
import { ownerSurfaceLoginId } from './surface';
import { str, strOpt, numOpt as num, boolOpt as bool } from './coerce';
import {
  getPendingCall,
  listPendingCalls,
  rejectPendingCall,
  type ListPendingOptions,
} from './pending';
import { CS } from './client-sourced-rule';

const PENDING_STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const;

export const pending_list: BuiltinToolDef = {
  slug: 'pending_list',
  policy: { effect: 'read', spends: 'none', scope: 'admin' },
  mcpOnly: true,
  name: 'List pending tool calls',
  description:
    'List the tool calls agents have queued for approval and return their rows, by default the still-pending queue; `status` picks another queue. A person approves a call in the app (the Pending screen) or on a Telegram card, never over MCP; to turn one down use `pending_reject`.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: [...PENDING_STATUSES], description: 'queue to read' },
      limit: { type: 'integer', minimum: 1, maximum: 500, description: 'cap the rows returned' },
    },
  },
  handler: async (input, ctx) => {
    const status = strOpt(input.status);
    if (status && !(PENDING_STATUSES as readonly string[]).includes(status)) {
      return { ok: false, error: `status must be one of ${PENDING_STATUSES.join(', ')}` };
    }
    const rows = await listPendingCalls(ctx.ownerId, {
      status: (status as ListPendingOptions['status']) ?? 'pending',
      limit: num(input.limit),
    });
    return { ok: true, output: rows };
  },
};

export const pending_get: BuiltinToolDef = {
  slug: 'pending_get',
  policy: {
    matrix: { none: 'a pending call is not an item' },
    effect: 'read',
    spends: 'none',
    scope: 'admin',
  },
  mcpOnly: true,
  name: 'Get a pending tool call',
  description:
    'Fetch one queued tool call by id and return its row with its args. A person approves it in the app (the Pending screen) or on a Telegram card, never over MCP; to turn it down use `pending_reject`. For the whole queue use `pending_list`.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', format: 'uuid', description: 'the pending row id' } },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id);
    if (!id) return { ok: false, error: 'id required' };
    const row = await getPendingCall(ctx.ownerId, id);
    if (!row) return { ok: false, error: 'not found' };
    return { ok: true, output: row };
  },
};

export const pending_reject: BuiltinToolDef = {
  slug: 'pending_reject',
  policy: {
    matrix: { none: 'a pending call is not an item' },
    effect: 'write',
    spends: 'none',
    scope: 'admin',
    peerRisky: true,
    clientSourced: CS.free('drops a queued call'),
  },
  mcpOnly: true,
  name: 'Reject a pending tool call',
  description:
    "Reject a queued tool call by id and return its row: nothing runs, its status flips to 'rejected', and this cannot be undone. A runner `ask_human` question completes its run step failed(rejected) so the run advances instead of waiting forever. There is no approving over MCP: a person approves in the app (the Pending screen) or on a Telegram card.",
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', format: 'uuid', description: 'the pending row id' } },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id);
    if (!id) return { ok: false, error: 'id required' };
    const decider = ownerSurfaceLoginId(ctx.surface) ?? currentWorkspaceScope()?.loginId ?? null;
    const row = await rejectPendingCall(ctx.ownerId, id, decider ?? undefined);
    if (!row) return { ok: false, error: 'not found or already decided' };
    return { ok: true, output: row };
  },
};

export const worker_group_list: BuiltinToolDef = {
  slug: 'worker_group_list',
  policy: { effect: 'read', spends: 'none', scope: { area: 'assistants', systemWhole: true } },
  mcpOnly: true,
  name: 'List worker groups',
  description:
    'List worker groups (panels) for runner queues. A run step with group:<slug> fans out into one attempt per member worker plus a panel audit.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_input, ctx) => {
    const rows = await db.select().from(agentGroups).where(eq(agentGroups.ownerId, ctx.ownerId));
    return { ok: true, output: rows };
  },
};

export const worker_group_ensure: BuiltinToolDef = {
  slug: 'worker_group_ensure',
  policy: {
    idempotent: true, // idempotent upsert
    matrix: { none: 'a worker group is not an item' },
    effect: 'write',
    spends: 'none',
    scope: { area: 'assistants', systemWhole: true },
    clientSourced: CS.free('worker routing (MCP only)'),
  },
  mcpOnly: true,
  name: 'Create or update a worker group',
  description:
    "Create or update a worker group (panel) by slug. `members` are enabled worker-agent slugs — each must exist (agent_list shows agents; role 'worker'). Idempotent upsert.",
  inputSchema: {
    type: 'object',
    properties: {
      slug: { type: 'string', minLength: 1, maxLength: 64, description: 'the group slug' },
      name: { type: 'string', maxLength: 200, description: 'display name' },
      members: {
        type: 'array',
        minItems: 1,
        maxItems: 10,
        items: { type: 'string', minLength: 1 },
        description: 'enabled worker-agent slugs',
      },
      enabled: { type: 'boolean', description: 'whether the panel is live' },
    },
    required: ['slug', 'members'],
  },
  handler: async (input, ctx) => {
    const slug = str(input.slug);
    const members = Array.isArray(input.members) ? input.members.map((m) => String(m)) : [];
    if (!slug) return { ok: false, error: 'slug required' };
    if (members.length === 0) return { ok: false, error: 'members required' };
    const workers = await db
      .select({ slug: agents.slug })
      .from(agents)
      .where(
        and(eq(agents.ownerId, ctx.ownerId), eq(agents.role, 'worker'), eq(agents.enabled, true)),
      );
    const have = new Set(workers.map((w) => w.slug));
    const missing = members.filter((m) => !have.has(m));
    if (missing.length > 0) {
      const available = workers.map((w) => w.slug).join(', ') || '(none yet)';
      return {
        ok: false,
        error: `unknown worker(s): ${missing.join(', ')} — enabled worker agents: ${available}. Create workers first (settings → agents, role 'worker').`,
      };
    }
    const [existing] = await db
      .select({ id: agentGroups.id })
      .from(agentGroups)
      .where(and(eq(agentGroups.ownerId, ctx.ownerId), eq(agentGroups.slug, slug)));
    const name = strOpt(input.name);
    const enabled = bool(input.enabled);
    const values = {
      name: name ?? slug,
      memberSlugs: members,
      ...(enabled !== undefined ? { enabled } : {}),
      updatedAt: new Date(),
    };
    // Its members, name or a turn-on is the group's grant (the narrow login
    // keeps only the stamp): the same branch as its HTTP twin
    // (worker-groups.ts updateWorkerGroup; app LOW-2).
    const write = () =>
      db.update(agentGroups).set(values).where(eq(agentGroups.id, existing!.id)).returning();
    const [row] = existing
      ? await onNarrowSpots(agentGroups, 'update', values, write)
      : await onFullSystemRoute('agent-group-grant', () =>
          db
            .insert(agentGroups)
            .values({ ownerId: ctx.ownerId, slug, ...values })
            .returning(),
        );
    return { ok: true, output: row };
  },
};

/** The approval queue over MCP: read it, or reject from it. MCP only, never
 *  granted; a person approves elsewhere (see the file header). */
export const PENDING_TOOLS: readonly BuiltinToolDef[] = [pending_list, pending_get, pending_reject];

export const WORKER_GROUP_TOOLS: readonly BuiltinToolDef[] = [
  worker_group_list,
  worker_group_ensure,
];
