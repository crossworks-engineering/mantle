/**
 * Runs worker-turn runner (slice 3 WP1, docs/runs-slice-3-plan.md §4) — a
 * `worker_invoke` item's whole agent turn as a durable DBOS workflow. The runs
 * worker CLAIMS the item under the per-run cap (`claimWorkerItem`, the engine's
 * correctness gate — unchanged), then enqueues this workflow by name on the
 * dedicated RUNS_TURN_QUEUE (off the foreground RUNNER_QUEUE so background runs
 * never starve interactive turns) and acks its pg-boss job; the turn itself
 * executes here,
 * where every LLM call + tool dispatch is a journaled step (tracing `step()` →
 * `runDurableStep` under `withDurableSteps`), so a crash mid-turn resumes from
 * the last completed step instead of re-running the whole turn or eating the
 * 600 s deadline.
 *
 * ENGINE CONTRACT UNCHANGED (plan C4): the item arrives `running` with a
 * claim-stamped deadline; this workflow's terminal act is `completeItem` +
 * `enqueueRunActionsSafe` (journaled, so a post-completion crash replays the
 * recorded actions rather than losing them — duplicates no-op at the CAS); a
 * workflow that dies permanently looks to the engine exactly like a crashed
 * in-process handler and the sweep's deadline duty fails it. Late completion
 * no-ops at the CAS.
 *
 * The turn body is slice 2's `execute-worker.ts` post-claim logic, moved here
 * (the `'inherit'` route-resolution included); the web-side file shrank to
 * claim + enqueue. Replay caveat (same as the assistant turn): trace rows and
 * token/cost accumulation happen OUTSIDE the journal, so a crash-resume
 * re-creates trace rows and under-reports the replayed steps' cost on the item
 * row — duplicate traces after a recovery are expected, not a bug (plan §8).
 */

import { DBOS } from '@dbos-inc/dbos-sdk';
import { and, eq, sql } from 'drizzle-orm';
import {
  agents,
  bumpAgentUsage,
  db,
  runItems,
  runs as runsTable,
  type Agent,
  type AgentParams,
  type RunItemFailure,
} from '@mantle/db';
import {
  completeItem,
  enqueueRunActionsSafe,
  ensureWorkerAgent,
  isRunsEnabled,
  requeueForRetry,
  RUNS_WORKER_TURN_WORKFLOW,
  WORKER_MODEL_INHERIT,
  type PostCommitAction,
  type RunsWorkerTurnInput,
  type RunsWorkerTurnResult,
} from '@mantle/runs';
import {
  composeSystemPromptWithSkills,
  effectiveToolSlugs,
  resolveAgentSkills,
  resolveAgentToolGroups,
  resolveAgentTools,
  resolveBackupAdapter,
  resolveChatKey,
  runToolLoop,
  type ChatMessage,
} from '@mantle/agent-runtime';
import { spillToolResult } from '@mantle/tools';
import { currentTrace, runDurableStep, startTrace, withDurableSteps } from '@mantle/tracing';
import { getChatAdapter } from '@mantle/voice';

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

/** completeItem as a JOURNALED step: the returned PostCommitAction[] is
 *  recorded, so a crash between completion and enqueue replays the recorded
 *  actions instead of dropping them (the sweep stays the backstop either
 *  way; duplicate enqueues no-op at the engine's CAS). */
function completeDurable(
  opts: Parameters<typeof completeItem>[1],
): Promise<{ completed: boolean; actions: PostCommitAction[] }> {
  return runDurableStep('complete_item', () => completeItem(db, opts));
}

async function runsWorkerTurnImpl(input: RunsWorkerTurnInput): Promise<RunsWorkerTurnResult> {
  const { itemId } = input;
  DBOS.span?.setAttribute('mantle.runner', 'runs_worker_turn');
  DBOS.span?.setAttribute('mantle.item_id', itemId);

  return withDurableSteps(
    (name, fn) => DBOS.runStep(fn, { name }),
    async (): Promise<RunsWorkerTurnResult> => {
      // The claim happened in the runs worker (ready → running CAS under the
      // per-run cap). Anything else here is a stale wake-up: swept, cancelled,
      // or already completed — ack by returning (the §5b idempotency
      // discipline, applied to DBOS deliveries).
      //
      // JOURNALED (final audit F4): this stale check reads state the workflow
      // itself mutates (completeItem). As bare glue it re-decided on a
      // crash-recovery replay — the item, completed by the journaled
      // complete_item pre-crash, read as terminal and the replay exited
      // 'stale' before re-reaching the journaled actions, so
      // enqueueRunActionsSafe never re-ran and the recorded PostCommitActions
      // were dropped (sweep-healed, but the "replays the recorded actions"
      // contract was false). Journaling the load pins the decision: a replay
      // walks the same path to complete_item and re-enqueues its recorded
      // actions (duplicates no-op at the engine CAS).
      const item = await runDurableStep('load_item', async () => {
        const [row] = await db.select().from(runItems).where(eq(runItems.id, itemId));
        if (!row || row.kind !== 'worker_invoke' || row.state !== 'running') return null;
        return {
          id: row.id,
          runId: row.runId,
          attempt: row.attempt,
          payload: row.payload,
          retryPolicy: row.retryPolicy,
          agentId: row.agentId,
        };
      });
      if (!item) {
        DBOS.logger.info(`[runs_worker_turn] stale wake-up for ${itemId} — skipping`);
        return { executed: false, outcome: 'stale' };
      }

      // Flag discipline must not fork across runtimes (plan §4 WP1): the api
      // runner refuses with a structured, counter-driving failure when
      // MANTLE_RUNS is off HERE — visible in the run view, never a silent
      // stall. (The shared compose app-env anchor feeds both containers.)
      if (!isRunsEnabled()) {
        const { actions } = await completeDurable({
          itemId: item.id,
          state: 'failed',
          failure: {
            type: 'disabled',
            message:
              'MANTLE_RUNS is off in the api runner — worker turns cannot execute. ' +
              'Set it in the shared app env (compose app-env anchor) for web, worker_runs AND api.',
            itemId: item.id,
          },
        });
        await enqueueRunActionsSafe(actions);
        return { executed: false, outcome: 'disabled' };
      }

      const fail = async (
        failure: RunItemFailure,
        extra?: Record<string, unknown>,
      ): Promise<RunsWorkerTurnResult> => {
        const { actions } = await completeDurable({
          itemId: item.id,
          state: 'failed',
          failure,
          ...(extra ? { result: extra } : {}),
        });
        await enqueueRunActionsSafe(actions);
        return { executed: true, outcome: 'failed' };
      };

      const retryOrFail = async (
        failure: RunItemFailure,
        extra?: Record<string, unknown>,
      ): Promise<RunsWorkerTurnResult> => {
        const maxAttempts = item.retryPolicy?.maxAttempts ?? 1;
        if (item.attempt + 1 < maxAttempts) {
          const retry = await runDurableStep('requeue_for_retry', () =>
            requeueForRetry(db, item.id),
          );
          if (retry) {
            await enqueueRunActionsSafe([retry]);
            return { executed: true, outcome: 'retry' };
          }
        }
        return fail(failure, extra);
      };

      try {
        const [run] = await db.select().from(runsTable).where(eq(runsTable.id, item.runId));
        if (!run) return fail({ type: 'internal_error', message: 'run row vanished' });
        DBOS.span?.setAttribute('mantle.run_id', run.id);
        DBOS.span?.setAttribute('mantle.owner_id', run.ownerId);

        // Deadline re-stamp: the claim's stamp started ticking when the runs
        // worker won the CAS, but RUNS_TURN_QUEUE wait time is not execution.
        // Re-stamping here (state-guarded, plain UPDATE — no new transition)
        // keeps "deadline = execution budget" true under queue backpressure;
        // an enqueued-but-never-started workflow still times out on the
        // claim's original stamp (the sweep's loss backstop, plan C4).
        const timeoutRaw = (item.payload as Record<string, unknown> | null)?.['timeout_seconds'];
        const timeout =
          typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw) && timeoutRaw > 0
            ? Math.min(timeoutRaw, 6 * 3600)
            : 600;
        await runDurableStep('restamp_deadline', async () => {
          const rows = await db
            .update(runItems)
            .set({
              deadlineAt: sql`now() + make_interval(secs => ${timeout})`,
              updatedAt: sql`now()`,
            })
            .where(and(eq(runItems.id, item.id), eq(runItems.state, 'running')))
            .returning({ id: runItems.id });
          return rows.length > 0; // journal a plain boolean, not a driver row list
        });

        const worker = await ensureWorkerAgent(db, run.ownerId, item.agentId);
        if (!worker) {
          return fail({
            type: 'worker_missing',
            message: 'the routed worker agent no longer exists or is disabled — re-plan the step',
          });
        }

        // Route resolution: inherit → the responder's model/provider/key
        // (moved here from slice 2's execute-worker.ts, unchanged).
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
        DBOS.span?.setAttribute('mantle.cost_micro_usd', costMicroUsd);

        const reply = outcome.reply?.trim() ?? '';
        // Mechanical evidence — the runtime's own ledger, not the model's
        // prose. Rebuilt identically on replay: each tool step's journaled
        // result feeds the same toolCalls array.
        const evidence: WorkerEvidence[] = outcome.toolCalls.map((tc) => ({
          tool: tc.slug,
          ok: !tc.error,
          ...(tc.error ? { error: tc.error.slice(0, 200) } : {}),
        }));

        if (!reply) {
          return retryOrFail(
            { type: 'empty_output', message: 'worker turn produced no proposal', itemId: item.id },
            { evidence },
          );
        }

        let outputHandle: string | undefined;
        try {
          const spilled = await runDurableStep('spill_output', () =>
            spillToolResult({
              ownerId: run.ownerId,
              traceId: traceId ?? null,
              toolSlug: 'worker_invoke',
              content: reply,
            }),
          );
          outputHandle = spilled.handle;
        } catch (err) {
          DBOS.logger.warn(`[runs_worker_turn] output spill failed (summary only): ${String(err)}`);
        }

        const proposal =
          reply.length <= PROPOSAL_CAP_CHARS ? reply : `${reply.slice(0, PROPOSAL_CAP_CHARS)}…`;
        const { actions } = await completeDurable({
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
        await enqueueRunActionsSafe(actions);
        DBOS.logger.info(
          `[runs_worker_turn] done (item=${item.id}, run=${run.id}, cost=${costMicroUsd}µ$)`,
        );
        return { executed: true, outcome: 'done' };
      } catch (err) {
        // Model/transport failure — semantic retry, then structured failure
        // (same rules as slice 2's in-process handler).
        const msg = err instanceof Error ? err.message : String(err);
        DBOS.span?.setAttribute('mantle.error', msg);
        DBOS.logger.error(`[runs_worker_turn] FAILED (item=${item.id}): ${msg}`);
        return retryOrFail({ type: 'worker_error', message: msg, itemId: item.id });
      }
    },
  );
}

export const runsWorkerTurnWorkflow = DBOS.registerWorkflow(runsWorkerTurnImpl, {
  name: RUNS_WORKER_TURN_WORKFLOW,
});
