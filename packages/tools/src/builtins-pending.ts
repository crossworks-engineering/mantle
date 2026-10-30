/**
 * Builtins: the operator-approval queue and the runner's worker groups.
 *
 * The approval surface has ONE implementation: no hand-written MCP twin.
 * Every def here is `mcpOnly`: the MCP client is the OWNER, and
 * these are the owner's controls over what agents queued. An agent that could
 * call `pending_approve` would approve its own gated call, which is exactly the
 * gate these rows exist to impose — so they are never seeded and never
 * grantable (see BuiltinToolDef.mcpOnly).
 */

import { and, eq } from 'drizzle-orm';
import { agentGroups, agents, db, onNarrowSpots, onFullSystemRoute } from '@mantle/db';
import { currentWorkspaceScope } from '@mantle/db/viewer';
import { ASK_HUMAN_FORM_LIMITS as FORM_LIMITS } from '@mantle/client-types';
import { type BuiltinToolDef } from './types';
import { ownerSurfaceLoginId } from './surface';
import { str, strOpt, numOpt as num, boolOpt as bool } from './coerce';
import {
  approvePendingCall,
  getPendingCall,
  listPendingCalls,
  rejectPendingCall,
  type ListPendingOptions,
} from './pending';
import { CS } from './client-sourced-rule';
import { ApprovalRefusedError } from './pending-approval';

const PENDING_STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const;

export const pending_list: BuiltinToolDef = {
  slug: 'pending_list',
  policy: { effect: 'read', spends: 'none', scope: 'admin' },
  mcpOnly: true,
  name: 'List pending tool calls',
  description:
    "List operator-approval-required tool calls an agent has queued. By default returns the still-pending queue; pass `status` ('pending'|'approved'|'rejected'|'expired') to filter, and `limit` to cap.",
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
  description: 'Fetch a pending tool call by id — useful to inspect the args before deciding.',
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

export const pending_approve: BuiltinToolDef = {
  slug: 'pending_approve',
  policy: {
    matrix: { none: 'a pending call is not an item' },
    effect: 'write',
    spends: 'none',
    scope: 'admin',
    peerRisky: true,
    clientSourced: CS.always('it runs a queued call (MCP only)'),
  },
  mcpOnly: true,
  name: 'Approve a pending tool call',
  description:
    'Approve a queued tool call by id. The handler runs immediately under a fresh `manual` trace; the result is stored on the pending row and returned. For a runner `ask_human` question, approval completes the run step and `answer` carries the free-text reply the run continues with (omit it for a plain yes / option-pick approval). When the row carries a `form` (see its args), answer per sub-question with `answers` instead. A change to a stored key (`api_key_set`, `api_key_delete`, `api_key_import`) is approved by a person in the app, never here.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid', description: 'the pending row id' },
      answer: { type: 'string', maxLength: 4000, description: 'free-text reply for ask_human' },
      answers: {
        type: 'array',
        maxItems: FORM_LIMITS.maxQuestions,
        description: "structured answers, one entry per question in the row's `form`",
        items: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              maxLength: 200,
              description: "the form question's id, e.g. 'env'",
            },
            selected: {
              type: 'array',
              maxItems: FORM_LIMITS.maxOptions,
              items: { type: 'string', maxLength: FORM_LIMITS.maxLabelChars },
              description: 'chosen option labels',
            },
            other: {
              type: 'string',
              maxLength: FORM_LIMITS.maxOtherChars,
              description: 'free text when no option fits',
            },
          },
          required: ['question', 'selected'],
        },
      },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id);
    if (!id) return { ok: false, error: 'id required' };
    const answer = strOpt(input.answer);
    const answers = Array.isArray(input.answers)
      ? (input.answers as Array<Record<string, unknown>>)
      : undefined;
    const decision =
      answer || answers?.length
        ? { ...(answer ? { answer } : {}), ...(answers?.length ? { answers } : {}) }
        : undefined;
    // The approver is this connection's login. A connection that names none
    // to the tools (a peer bound to an Admin login) still runs in that
    // login's scope: the scope names it, so the approved call never runs as
    // the bare owner.
    const approver = ownerSurfaceLoginId(ctx.surface) ?? currentWorkspaceScope()?.loginId ?? null;
    let row;
    try {
      // Over MCP: a held vault change is refused here (held-tools.ts).
      row = await approvePendingCall(ctx.ownerId, id, {
        ...decision,
        ...(approver ? { approverLoginId: approver } : {}),
        viaMcp: true,
      } as never);
    } catch (err) {
      // The approval rule refused this approver (pending-approval.ts): the
      // call stays pending for an Admin user who may approve it.
      if (err instanceof ApprovalRefusedError) return { ok: false, error: err.message };
      throw err;
    }
    if (!row) return { ok: false, error: 'not found or already decided' };
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
    "Reject a queued tool call by id. No execution; just flips status to 'rejected'. A runner `ask_human` question completes its run step failed(rejected) so the run advances instead of waiting forever.",
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

/** The owner's approval queue and runner panels — MCP-only, never granted. */
export const PENDING_TOOLS: readonly BuiltinToolDef[] = [
  pending_list,
  pending_get,
  pending_approve,
  pending_reject,
];

export const WORKER_GROUP_TOOLS: readonly BuiltinToolDef[] = [
  worker_group_list,
  worker_group_ensure,
];
