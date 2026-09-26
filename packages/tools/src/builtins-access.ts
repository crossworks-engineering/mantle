/**
 * Builtins: access_get / access_set, the owner's levers for the one level
 * system (member logins Phase 0b): admin > team > client > public on brain
 * items, agents and tool groups. Owner-side only.
 */
import { and, eq } from 'drizzle-orm';
import { agents, db, isViewerLevel, nodes, toolGroups } from '@mantle/db';
import {
  AccessError,
  accessClosure,
  accessShadowReport,
  setAgentAudience,
  setItemLevel,
  setToolGroupAudience,
} from '@mantle/content';
import { errorMessage } from '@mantle/std';
import type { BuiltinToolDef, ToolHandlerContext, ToolHandlerResult } from './types';
import { str, strOpt } from './coerce';
import { NODE_ID_PRE } from './builtins-common';

const LEVELS = ['admin', 'team', 'client', 'public'];

function ownerOnly(ctx: ToolHandlerContext): ToolHandlerResult | null {
  if (ctx.surface?.kind === 'team' || ctx.surface?.kind === 'forum') {
    return {
      ok: false,
      error: 'access_get / access_set are owner-side only: ask the owner to change a level.',
    };
  }
  return null;
}

export const access_get: BuiltinToolDef = {
  slug: 'access_get',
  readOnly: true,
  preconditions: NODE_ID_PRE,
  name: 'Get an access level',
  description:
    'Read the level (admin, team, client or public) of one brain item, agent or tool group. For an item it also returns its CLOSURE: the embedded files, drawings or folder contents its share needs, each with its own level. Use before `access_set` to see what lowering an item would leave behind.',
  inputSchema: {
    type: 'object',
    properties: {
      node_id: {
        type: 'string',
        format: 'uuid',
        description: 'a brain item id (page, file, folder, …)',
      },
      agent_slug: { type: 'string', description: "an agent's slug, e.g. 'team-responder'" },
      tool_group_slug: { type: 'string', description: "a tool group's slug, e.g. 'team-read'" },
    },
  },
  handler: async (input, ctx) => {
    const refused = ownerOnly(ctx);
    if (refused) return refused;
    try {
      const nodeId = strOpt(input.node_id);
      const agentSlug = strOpt(input.agent_slug);
      const groupSlug = strOpt(input.tool_group_slug);
      if (nodeId) {
        const [row] = await db
          .select({ id: nodes.id, type: nodes.type, title: nodes.title, audience: nodes.audience })
          .from(nodes)
          .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ctx.ownerId)))
          .limit(1);
        if (!row) return { ok: false, error: 'item not found: find its id with search_nodes' };
        const closure = await accessClosure(ctx.ownerId, nodeId);
        return { ok: true, output: { item: row, closure } };
      }
      if (agentSlug) {
        const [row] = await db
          .select({ slug: agents.slug, audience: agents.audience, groups: agents.toolGroupSlugs })
          .from(agents)
          .where(and(eq(agents.ownerId, ctx.ownerId), eq(agents.slug, agentSlug)))
          .limit(1);
        if (!row)
          return { ok: false, error: `agent '${agentSlug}' not found: list them with agent_list` };
        return { ok: true, output: { agent: row } };
      }
      if (groupSlug) {
        const [row] = await db
          .select({ slug: toolGroups.slug, audience: toolGroups.audience })
          .from(toolGroups)
          .where(and(eq(toolGroups.ownerId, ctx.ownerId), eq(toolGroups.slug, groupSlug)))
          .limit(1);
        if (!row)
          return {
            ok: false,
            error: `tool group '${groupSlug}' not found: list them with tool_group_list`,
          };
        return { ok: true, output: { tool_group: row } };
      }
      return { ok: false, error: 'pass one of node_id, agent_slug or tool_group_slug' };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const access_set: BuiltinToolDef = {
  slug: 'access_set',
  preconditions: NODE_ID_PRE,
  name: 'Set an access level',
  description:
    "Set the level of one brain item, agent or tool group: admin (default), team, client or public. A caller sees what is at or below its level. Only pages, notes, drawings, tables, files, folders, apps and formulas go below admin. Lowering an item reports closure items still above it; `with_closure: true` lowers those too. Raising an item reports closure items still below it (a folder taken back to admin whose files stay at team); `raise_closure: true` raises those too. The item's share link follows its level: none at admin, team-only at team (it lists in the team workspace), open at client and public. An agent's level decides what it reads: `team-responder` at team reads only team-level items. Takes effect at once. To read a level use `access_get`.",
  inputSchema: {
    type: 'object',
    properties: {
      node_id: { type: 'string', format: 'uuid', description: 'a brain item id' },
      agent_slug: { type: 'string', description: "an agent's slug, e.g. 'team-responder'" },
      tool_group_slug: { type: 'string', description: "a tool group's slug, e.g. 'team-read'" },
      level: { type: 'string', enum: LEVELS, description: 'the new level' },
      with_closure: {
        type: 'boolean',
        default: false,
        description: "items only: also lower the item's embeds / folder contents",
      },
      raise_closure: {
        type: 'boolean',
        default: false,
        description:
          "items only: also raise the item's embeds / folder contents that sit below the new level",
      },
    },
    required: ['level'],
  },
  handler: async (input, ctx) => {
    const refused = ownerOnly(ctx);
    if (refused) return refused;
    const level = str(input.level).trim();
    if (!isViewerLevel(level))
      return { ok: false, error: `level must be one of ${LEVELS.join(', ')}` };
    try {
      const nodeId = strOpt(input.node_id);
      const agentSlug = strOpt(input.agent_slug);
      const groupSlug = strOpt(input.tool_group_slug);
      if (nodeId) {
        const res = await setItemLevel(ctx.ownerId, nodeId, level, {
          withClosure: input.with_closure === true,
          raiseClosure: input.raise_closure === true,
        });
        ctx.step?.setOutput({
          id: nodeId,
          level,
          lowered: res.lowered.length,
          raised: res.raised.length,
        });
        return { ok: true, output: res };
      }
      if (agentSlug) {
        const [row] = await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.ownerId, ctx.ownerId), eq(agents.slug, agentSlug)))
          .limit(1);
        if (!row)
          return { ok: false, error: `agent '${agentSlug}' not found: list them with agent_list` };
        const res = await setAgentAudience(ctx.ownerId, row.id, level);
        ctx.step?.setOutput({ agent: agentSlug, level });
        return { ok: true, output: { agent: res } };
      }
      if (groupSlug) {
        const res = await setToolGroupAudience(ctx.ownerId, groupSlug, level);
        ctx.step?.setOutput({ tool_group: groupSlug, level });
        return { ok: true, output: { tool_group: res } };
      }
      return { ok: false, error: 'pass one of node_id, agent_slug or tool_group_slug' };
    } catch (err) {
      if (err instanceof AccessError) return { ok: false, error: err.message };
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const access_shadow_report: BuiltinToolDef = {
  slug: 'access_shadow_report',
  readOnly: true,
  name: 'Access shadow report',
  description:
    'What the team responder would LOSE if it ran at team level today: items recent team and forum turns used that are still admin, shared items that can never go below admin (a shared task or event), shares whose embeds or folder contents sit above them, how many facts stay usable, and any tool group the responder holds above team. Read-only, no model call. Read it before lowering `team-responder` with `access_set`; fix what it lists first.',
  inputSchema: {
    type: 'object',
    properties: {
      days: {
        type: 'integer',
        minimum: 1,
        maximum: 365,
        default: 30,
        description: 'How far back to read recorded turns.',
      },
      agent_slug: {
        type: 'string',
        description: "the member-facing agent to check, e.g. 'team-responder'",
      },
    },
  },
  handler: async (input, ctx) => {
    const refused = ownerOnly(ctx);
    if (refused) return refused;
    try {
      const days = typeof input.days === 'number' ? input.days : undefined;
      const report = await accessShadowReport(ctx.ownerId, {
        days,
        agentSlug: strOpt(input.agent_slug),
      });
      ctx.step?.setOutput({
        turns: report.turns,
        usedAtAdmin: report.usedAtAdmin.length,
        closureGaps: report.closureGaps.length,
      });
      return { ok: true, output: report };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

/** The owner's level levers. */
export const ACCESS_TOOLS: readonly BuiltinToolDef[] = [
  access_get,
  access_set,
  access_shadow_report,
];
