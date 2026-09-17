/**
 * Builtins: invoke_agent — specialist delegation.
 *
 * Split out of builtins.ts on 2026-09-02 (audit, bloat B6) with behaviour
 * unchanged; builtins.ts assembles BUILTIN_TOOLS from these groups.
 */

import { and, eq } from 'drizzle-orm';
import { agents, db } from '@mantle/db';
import { type BuiltinToolDef } from './types';
import { str } from './coerce';

export const invoke_agent: BuiltinToolDef = {
  slug: 'invoke_agent',
  name: 'Delegate to another agent',
  description:
    "Hand off a single, self-contained prompt to another agent (e.g. a researcher with a stronger model + retrieval tools). Use only when the work would clearly benefit from a different persona or model — not for routing every turn. The child runs once and returns its final text; its conversation history is NOT shared with the parent. Pack the prompt to stand alone: the user's ask (their words, not a paraphrase), the exact node ids via `subject_node_ids`, any composed content IN FULL, and what 'done' looks like. The runtime also attaches the triggering user message automatically as a safety net. The parent agent's `memory_config.delegate_to` must list the target slug, or this call is refused.",
  inputSchema: {
    type: 'object',
    required: ['agent_slug', 'prompt'],
    properties: {
      agent_slug: {
        type: 'string',
        description: 'Slug of the target agent (the `agents.slug` column).',
      },
      prompt: {
        type: 'string',
        description:
          'Self-contained instructions for the child. Include any context it needs; the child does not see your conversation history. State the goal, the material (in full — never shortened), and the expected end state.',
        maxLength: 32_000,
      },
      subject_node_ids: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Ids of the nodes (pages, tables, files) the child should operate on. Always pass these when the work targets existing content — a child that has to SEARCH for its subject can pick the wrong one.',
      },
    },
  },
  handler: async (input, ctx) => {
    // Lazy imports keep the guard module + bridge out of the cold-
    // start path of every other builtin. They're tiny but the
    // separation lets us test them as pure helpers.
    const { MAX_AGENT_DEPTH, checkAgentDepth, checkDelegationAllowed, isTerminalDelegateConfig } =
      await import('./invoke-agent-guards');
    const { getAgentInvoker } = await import('./agent-bridge');

    if (!ctx.agent) {
      return {
        ok: false,
        error:
          'invoke_agent: missing parent agent context — runToolLoop did not populate ctx.agent. This is a wiring bug.',
      };
    }

    const targetSlug = str(input.agent_slug);
    const prompt = str(input.prompt);
    if (!targetSlug) return { ok: false, error: 'agent_slug is required' };
    if (!prompt) return { ok: false, error: 'prompt is required' };

    // Guardrail 3: explicit allowlist + no self-call.
    const allowed = checkDelegationAllowed(ctx.agent.slug, targetSlug, ctx.agent.delegateTo);
    if (!allowed.ok) return { ok: false, error: allowed.reason };

    // Guardrail 1: bounded depth. One sanctioned exception (see
    // invoke-agent-guards.ts): a child may go a single level deeper along its
    // declared edge to a TERMINAL specialist — no delegates of its own, so the
    // chain provably ends there (the appsmith → toolsmith hop mid app build).
    // The lookup only runs when the base cap would refuse; a missing/disabled
    // target fails closed to non-terminal and the plain cap applies.
    let targetIsTerminal = false;
    if (ctx.agent.depth + 1 > MAX_AGENT_DEPTH) {
      const [targetRow] = await db
        .select({ memoryConfig: agents.memoryConfig })
        .from(agents)
        .where(
          and(
            eq(agents.ownerId, ctx.ownerId),
            eq(agents.slug, targetSlug),
            eq(agents.enabled, true),
          ),
        )
        .limit(1);
      const dt = (targetRow?.memoryConfig as { delegate_to?: unknown } | null)?.delegate_to;
      targetIsTerminal = !!targetRow && isTerminalDelegateConfig(dt);
    }
    const depth = checkAgentDepth(ctx.agent.depth, { targetIsTerminal });
    if (!depth.ok) return { ok: false, error: depth.reason };

    const invoker = getAgentInvoker();
    if (!invoker) {
      return {
        ok: false,
        error:
          'invoke_agent: no agent invoker registered in this process. Call registerAgentInvoker() at boot.',
      };
    }

    // Auto-bundled delegation context (2026-07-18 delegation review): the
    // child sees ONLY this prompt, and under-packed prompts are the hand-off's
    // main miscommunication gap. Attach the explicit subject ids and the
    // user's verbatim ask mechanically instead of trusting every parent to
    // pack well. The verbatim ask is skipped when the parent already quoted
    // it (no point doubling it).
    const subjectIds = Array.isArray(input.subject_node_ids)
      ? (input.subject_node_ids as unknown[])
          .filter((s): s is string => typeof s === 'string' && s.length > 0)
          .slice(0, 20)
      : [];
    const envelope: string[] = [];
    if (subjectIds.length) {
      envelope.push(
        `Subject node ids (operate on exactly these; do not search for others): ${subjectIds.join(', ')}`,
      );
    }
    const userAsk = ctx.agent.lastUserMessage?.trim();
    if (userAsk && !prompt.includes(userAsk)) {
      const clipped = userAsk.length > 4000 ? `${userAsk.slice(0, 4000)} …[truncated]` : userAsk;
      envelope.push(
        `The user's verbatim message that triggered this delegation (ground truth for intent):\n"""\n${clipped}\n"""`,
      );
    }
    const childPrompt = envelope.length
      ? `${prompt}\n\n--- delegation context (attached automatically by the runtime) ---\n${envelope.join('\n\n')}`
      : prompt;

    // Guardrail 2: synchronous. Await the child's final result. The
    // child's cost is captured in the child's own trace; we surface
    // it in the parent step's meta for /traces visibility, but the
    // parent's `traces.cost_micro_usd` does NOT roll it up — that
    // would double-count in /debug aggregates.
    const result = await invoker({
      ownerId: ctx.ownerId,
      agentSlug: targetSlug,
      prompt: childPrompt,
      depth: depth.childDepth,
      parentTraceId: ctx.agent.parentTraceId ?? null,
      // Inherit the parent turn's thinking budget; the child re-clamps it.
      ...(ctx.agent.thinkingBudget ? { thinkingBudget: ctx.agent.thinkingBudget } : {}),
    });
    if (!result.ok) {
      return { ok: false, error: `child agent failed: ${result.error}` };
    }
    ctx.step?.setMeta({
      child_trace_id: result.childTraceId,
      child_cost_micro_usd: result.costMicroUsd,
      child_tokens_in: result.tokensIn,
      child_tokens_out: result.tokensOut,
      delegated_to: targetSlug,
    });
    return {
      ok: true,
      output: {
        text: result.text,
        child_trace_id: result.childTraceId,
      },
    };
  },
};

/** The file-manager verbs + the indexing switch, exported as a group so the
 *  MCP server can BRIDGE them (one implementation, one behaviour) instead of
 *  hand-writing twins — see mcp-core's no-duplicate-tools test for why twins
 *  rot. In-app registration still comes from BUILTIN_TOOLS below. */
/**
 * The tools that used to live only in this catch-all with no exported group,
 * which is the sole reason the MCP surface could not bridge them (see
 * packages/mcp-core/src/build-server.ts). Grouped by what they do, not by which
 * agent holds them — a group here is an addressable bundle, never a grant.
 */

/** Invoke a specialist sub-agent. */
export const DELEGATION_TOOLS: readonly BuiltinToolDef[] = [invoke_agent];
