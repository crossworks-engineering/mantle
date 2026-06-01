/**
 * Runtime implementation of the `invoke_agent` builtin's bridge target.
 *
 * Both `apps/agent` (Telegram responder) and `apps/web` (/assistant)
 * call `registerAgentInvoker(invokeAgent)` at boot, so the
 * `invoke_agent` builtin in @mantle/tools can synchronously hand a
 * one-shot prompt to a different agent and get back its final text.
 *
 * Design properties:
 *   - Child runs as its own trace (kind='manual', subject_kind='child_agent').
 *     The parent's invoke_agent step records `child_trace_id` for
 *     navigation; the child's trace owns its full cost. /debug
 *     aggregates over `traces.cost_micro_usd` keep adding up
 *     correctly — no double-count.
 *   - Child sees a fresh conversation (system prompt + the parent's
 *     prompt as the single user turn). The parent's history is
 *     intentionally NOT forwarded — delegation is one-shot.
 *   - Child inherits the depth+1 the bridge passes in. runToolLoop
 *     refuses to start if that's already over MAX_AGENT_DEPTH —
 *     defence-in-depth in case a caller routes around the dispatch
 *     guard.
 *   - Each child uses its own API key, model, params, skills, and
 *     tool allowlist — exactly what the agent row says, no
 *     inheritance from the parent. That's the whole point of
 *     delegation.
 */

import { and, eq } from 'drizzle-orm';
import {
  db,
  agents,
  bumpAgentUsage,
  type Agent,
  type AgentMemoryConfig,
  type AgentParams,
} from '@mantle/db';
import { currentTrace, startTrace } from '@mantle/tracing';
import type { AgentInvoker, InvokeAgentResult } from '@mantle/tools';
import { MAX_AGENT_DEPTH } from '@mantle/tools';
import { getChatAdapter } from '@mantle/voice';
import { resolveAgentTools, runToolLoop } from './tool-loop';
import { resolveBackupAdapter, resolveChatKey } from './chat-failover';
import { resolveAgentSkills, composeSystemPromptWithSkills, effectiveToolSlugs } from './skills';
import type { ChatMessage } from './messages';

export const invokeAgent: AgentInvoker = async ({
  ownerId,
  agentSlug,
  prompt,
  depth,
  parentTraceId,
}): Promise<InvokeAgentResult> => {
  if (depth > MAX_AGENT_DEPTH) {
    // Defence in depth: the dispatcher already refused, but a caller
    // that constructs InvokeAgentInput by hand could route around
    // the check. Refuse here too rather than start the child.
    return {
      ok: false,
      error: `child depth ${depth} exceeds MAX_AGENT_DEPTH ${MAX_AGENT_DEPTH}`,
    };
  }

  // Resolve the target agent. Slug must match an enabled row owned by
  // this user — the same scoping every other agent lookup uses.
  const [target] = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.ownerId, ownerId),
        eq(agents.slug, agentSlug),
        eq(agents.enabled, true),
      ),
    )
    .limit(1);
  if (!target) {
    return {
      ok: false,
      error: `agent '${agentSlug}' not found, not owned by this user, or disabled`,
    };
  }

  // Shared key resolver: keyless `local` → 'local' sentinel; cloud → pinned/
  // service key, else a structured miss.
  const keyCheck = await resolveChatKey(ownerId, target);
  if (!keyCheck.ok) {
    return {
      ok: false,
      error:
        keyCheck.disposition === 'no_api_key_id'
          ? `agent '${agentSlug}' has no api_key_id configured`
          : `agent '${agentSlug}' api key could not be decrypted`,
    };
  }
  const apiKey = keyCheck.apiKey;

  // Resolve the chat adapter for the child agent's provider. The
  // agents.provider column drives this; rows without an explicit
  // value get 'openrouter' via the column default (migration 0048).
  const childAdapter = getChatAdapter(target.provider);
  if (!childAdapter) {
    return {
      ok: false,
      error: `agent '${agentSlug}' provider '${target.provider}' has no registered chat adapter`,
    };
  }

  // Compose system prompt + tool allowlist exactly the same way the
  // entry-point flow does. The child gets full access to its own
  // configured skills + tools — but its own ones, not the parent's.
  const skills = await resolveAgentSkills(ownerId, (target as Agent).skillSlugs ?? []);
  const systemPrompt = composeSystemPromptWithSkills(target.systemPrompt, skills);
  const initialMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ];
  const allowedToolSlugs = effectiveToolSlugs(target.toolSlugs ?? [], skills);
  const allowedTools = await resolveAgentTools(ownerId, allowedToolSlugs);

  // Open the child's trace inside a startTrace block so the child's
  // own LLM calls and tool steps roll up here, not into the parent's
  // trace. We tag `data.parent_trace_id` so /traces can render a link.
  //
  // startTrace returns whatever fn returns; the trace context (with
  // running totals) lives in AsyncLocalStorage. We capture it into
  // `childTrace` from inside the closure so we can return its totals
  // to the parent step's meta after the fn settles.
  let childTraceId: string | null = null;
  let childCostMicroUsd = 0;
  let childTokensIn = 0;
  let childTokensOut = 0;
  const reply = await startTrace(
    {
      ownerId,
      kind: 'manual',
      subjectKind: 'child_agent',
      subjectId: target.id,
      agentId: target.id,
      data: {
        parent_trace_id: parentTraceId,
        delegated_agent_slug: agentSlug,
        delegation_depth: depth,
      },
    },
    async () => {
      // memory_config.max_iterations lets batch-edit agents (Pages) raise
      // the tool-loop ceiling above the default 6 — read N blocks + write
      // N blocks costs N+overhead iterations, which exceeds the default
      // for any non-trivial multi-block edit. Clamped at 30 to keep the
      // worst-case bounded.
      const mc = (target.memoryConfig as AgentMemoryConfig | null) ?? null;
      const requestedMaxIters = typeof mc?.max_iterations === 'number' ? mc.max_iterations : null;
      const maxIterations = requestedMaxIters && requestedMaxIters > 0
        ? Math.min(30, Math.floor(requestedMaxIters))
        : undefined;

      const result = await runToolLoop({
        adapter: childAdapter,
        apiKey,
        model: target.model,
        baseUrl: target.baseUrl,
        viaTailnet: target.viaTailnet,
        backup: await resolveBackupAdapter(ownerId, target),
        params: (target.params ?? {}) as AgentParams,
        ownerId,
        agentId: target.id,
        agentSlug: target.slug,
        agentDepth: depth,
        delegateTo: (mc?.delegate_to ?? []) as readonly string[],
        resultHandling: mc?.result_handling ?? null,
        parentTraceId,
        initialMessages,
        tools: allowedTools,
        ...(maxIterations !== undefined ? { maxIterations } : {}),
      });
      // Snapshot the running totals before startTrace's finally
      // block flushes them to the DB. Reading from currentTrace
      // here is safe — we're still inside its AsyncLocalStorage
      // scope.
      const ctx = currentTrace();
      if (ctx) {
        childTraceId = ctx.id;
        childCostMicroUsd = ctx.costMicroUsd;
        childTokensIn = ctx.tokens.in;
        childTokensOut = ctx.tokens.out;
      }
      return result.reply;
    },
  );

  // Telemetry: a delegated agent has now run. The responder bumps its
  // own agent at the entry points (assistant.ts / main.ts) and the
  // workers bump via bumpWorkerUsage, but delegation targets are reached
  // only here — without this, researcher/remy/coder show "0 runs /
  // never" on /debug/agents despite running. Reached only on success
  // (startTrace rethrows if the child failed). Fire-and-forget +
  // never-throws, like bumpWorkerUsage.
  void bumpAgentUsage(target.id);

  return {
    ok: true,
    text: reply,
    costMicroUsd: childCostMicroUsd,
    tokensIn: childTokensIn,
    tokensOut: childTokensOut,
    childTraceId,
  };
};
