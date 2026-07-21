/**
 * `worker_invoke` execution — one whole agent turn per item (plan §6/§6b:
 * agents are templates, run items are the executions; fresh context every
 * time). Mirrors the invoke_agent child-turn shape, with runner specifics:
 *
 * - Claimed under the per-run concurrency cap (`claimWorkerItem`); a capped
 *   wake-up just acks — slot-release re-dispatch or the sweep re-wakes it.
 * - Model inheritance: a worker whose model is the 'inherit' sentinel (the
 *   default) runs on the RESPONDER's route — model, provider, key. Cost is
 *   recorded at whichever model actually ran (the hermes lesson).
 * - Runs at delegation depth 2 with an empty delegate allowlist, so
 *   `invoke_agent` and `run_*` refuse — workers propose, never recurse.
 * - Evidence is MECHANICAL: the tool-loop's own call ledger is stored on the
 *   item result; the audit judges claims against it, not against prose. The
 *   full reply is spilled to a `tr_…` handle the responder can `read_result`.
 */
import { eq } from 'drizzle-orm';
import {
  agents,
  bumpAgentUsage,
  db,
  runs as runsTable,
  type Agent,
  type AgentParams,
  type RunItemFailure,
} from '@mantle/db';
import {
  claimWorkerItem,
  completeItem,
  ensureWorkerAgent,
  requeueForRetry,
  WORKER_MODEL_INHERIT,
} from '@mantle/runs';
import {
  resolveBackupAdapter,
  resolveChatKey,
  resolveAgentSkills,
  resolveAgentToolGroups,
  resolveAgentTools,
  runToolLoop,
  composeSystemPromptWithSkills,
  effectiveToolSlugs,
  type ChatMessage,
} from '@mantle/agent-runtime';
import { spillToolResult } from '@mantle/tools';
import { currentTrace, startTrace } from '@mantle/tracing';
import { getChatAdapter } from '@mantle/voice';

import type { ExecuteItemOutcome } from './execute-item';

const PROPOSAL_CAP_CHARS = 2_000;

type WorkerEvidence = { tool: string; ok: boolean; error?: string };

function buildEnvelopePrompt(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`## Delegated step\n${String(payload.step ?? '')}`);
  if (typeof payload.acceptance_criteria === 'string') {
    lines.push(`## Acceptance criteria\n${payload.acceptance_criteria}`);
  }
  const subjects = Array.isArray(payload.subject_node_ids)
    ? (payload.subject_node_ids as string[])
    : [];
  if (subjects.length > 0) {
    lines.push(
      `## Context pointers\nRead these nodes with your tools before proposing: ${subjects.join(', ')}`,
    );
  }
  if (Array.isArray(payload.audit_findings) && payload.audit_findings.length > 0) {
    lines.push(
      `## This is a REDO\nA previous attempt was rejected by audit. Findings to fix:\n` +
        (
          payload.audit_findings as Array<{
            severity?: string;
            claim?: string;
            suggested_fix?: string;
          }>
        )
          .map(
            (f) =>
              `- [${f.severity ?? 'finding'}] ${f.claim ?? ''}${f.suggested_fix ? ` — fix: ${f.suggested_fix}` : ''}`,
          )
          .join('\n'),
    );
  }
  if (typeof payload.audit_directive === 'string') {
    lines.push(`## Directive\n${payload.audit_directive}`);
  }
  return lines.join('\n\n');
}

export async function executeWorkerInvoke(itemId: string): Promise<ExecuteItemOutcome> {
  const { item, capped } = await claimWorkerItem(db, itemId);
  if (!item) return { claimed: false, actions: [], ...(capped ? { capped: true } : {}) };

  const fail = async (failure: RunItemFailure, extra?: Record<string, unknown>) => {
    const { actions } = await completeItem(db, {
      itemId: item.id,
      state: 'failed',
      failure,
      ...(extra ? { result: extra } : {}),
    });
    return { claimed: true, actions };
  };

  try {
    const [run] = await db.select().from(runsTable).where(eq(runsTable.id, item.runId));
    if (!run) return fail({ type: 'internal_error', message: 'run row vanished' });

    const worker = await ensureWorkerAgent(db, run.ownerId, item.agentId);
    if (!worker) {
      return fail({
        type: 'worker_missing',
        message: 'the routed worker agent no longer exists or is disabled — re-plan the step',
      });
    }

    // Route resolution: inherit → the responder's model/provider/key.
    let route: Agent = worker;
    let inherited = false;
    if (worker.model === WORKER_MODEL_INHERIT || !worker.apiKeyId) {
      const responderId = run.agentId;
      const [responder] = responderId
        ? await db.select().from(agents).where(eq(agents.id, responderId))
        : [];
      if (!responder) {
        return fail({
          type: 'worker_config',
          message:
            `worker '${worker.slug}' inherits the responder's model but the run has no ` +
            `resolvable responder agent — set a model + api key on the worker`,
        });
      }
      route = responder;
      inherited = true;
    }
    const keyCheck = await resolveChatKey(run.ownerId, route);
    if (!keyCheck.ok) {
      return fail({
        type: 'worker_config',
        message: `no usable api key for ${inherited ? 'the inherited responder route' : `worker '${worker.slug}'`}`,
      });
    }
    const adapter = getChatAdapter(route.provider);
    if (!adapter) {
      return fail({
        type: 'worker_config',
        message: `provider '${route.provider}' has no registered chat adapter`,
      });
    }

    const skills = await resolveAgentSkills(run.ownerId, worker.skillSlugs ?? []);
    const systemPrompt = composeSystemPromptWithSkills(worker.systemPrompt, skills);
    const payload = (item.payload ?? {}) as Record<string, unknown>;
    const initialMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildEnvelopePrompt(payload) },
    ];
    const groupTools = await resolveAgentToolGroups(run.ownerId, worker.toolGroupSlugs ?? []);
    const allowedTools = await resolveAgentTools(run.ownerId, effectiveToolSlugs(groupTools));

    let traceId: string | undefined;
    let costMicroUsd = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    const outcome = await startTrace(
      {
        ownerId: run.ownerId,
        kind: 'run_item',
        subjectKind: 'run_item',
        subjectId: item.id,
        agentId: worker.id,
        data: {
          run_id: run.id,
          worker_slug: worker.slug,
          model: route.model,
          inherited_route: inherited,
          ...(payload.redo_of ? { redo_of: payload.redo_of } : {}),
        },
      },
      async () => {
        const result = await runToolLoop({
          adapter,
          apiKey: keyCheck.apiKey,
          model: route.model,
          baseUrl: route.baseUrl,
          viaTailnet: route.viaTailnet,
          backup: await resolveBackupAdapter(run.ownerId, route),
          params: (worker.params ?? {}) as AgentParams,
          ownerId: run.ownerId,
          agentId: worker.id,
          agentSlug: worker.slug,
          // Depth 2 + empty allowlist: run_* and invoke_agent refuse —
          // propose-don't-mutate is enforced structurally, not by prompt.
          agentDepth: 2,
          delegateTo: [],
          initialMessages,
          tools: allowedTools,
        });
        const ctx = currentTrace();
        if (ctx) {
          traceId = ctx.id;
          costMicroUsd = ctx.costMicroUsd;
          tokensIn = ctx.tokens.in;
          tokensOut = ctx.tokens.out;
        }
        return result;
      },
    );

    void bumpAgentUsage(worker.id).catch(() => {});
    const accounting = {
      usage: { input: tokensIn, output: tokensOut },
      ...(costMicroUsd > 0 ? { costMicroUsd } : {}),
      ...(traceId ? { traceRef: traceId } : {}),
    };

    const reply = outcome.reply?.trim() ?? '';
    // Mechanical evidence — the runtime's own ledger, not the model's prose.
    const evidence: WorkerEvidence[] = outcome.toolCalls.map((tc) => ({
      tool: tc.slug,
      ok: !tc.error,
      ...(tc.error ? { error: tc.error.slice(0, 200) } : {}),
    }));

    if (!reply) {
      const maxAttempts = item.retryPolicy?.maxAttempts ?? 1;
      if (item.attempt + 1 < maxAttempts) {
        const retry = await requeueForRetry(db, item.id);
        if (retry) return { claimed: true, actions: [retry] };
      }
      return fail(
        { type: 'empty_output', message: 'worker turn produced no proposal', itemId: item.id },
        { evidence },
      );
    }

    let outputHandle: string | undefined;
    try {
      const spilled = await spillToolResult({
        ownerId: run.ownerId,
        traceId: traceId ?? null,
        toolSlug: 'worker_invoke',
        content: reply,
      });
      outputHandle = spilled.handle;
    } catch (err) {
      console.error('[runs] worker output spill failed (summary only):', err);
    }

    const proposal =
      reply.length <= PROPOSAL_CAP_CHARS ? reply : `${reply.slice(0, PROPOSAL_CAP_CHARS)}…`;
    const { actions } = await completeItem(db, {
      itemId: item.id,
      state: 'done',
      result: {
        proposal,
        evidence,
        worker: worker.slug,
        ...(outputHandle ? { output_handle: outputHandle } : {}),
        ...(reply.length > PROPOSAL_CAP_CHARS ? { proposal_truncated: true } : {}),
      },
      ...accounting,
    });
    return { claimed: true, actions };
  } catch (err) {
    // Model/transport failure — semantic retry, then structured failure.
    const maxAttempts = item.retryPolicy?.maxAttempts ?? 1;
    if (item.attempt + 1 < maxAttempts) {
      const retry = await requeueForRetry(db, item.id);
      if (retry) return { claimed: true, actions: [retry] };
    }
    const { actions } = await completeItem(db, {
      itemId: item.id,
      state: 'failed',
      failure: {
        type: 'worker_error',
        message: err instanceof Error ? err.message : String(err),
        itemId: item.id,
      },
    });
    return { claimed: true, actions };
  }
}
