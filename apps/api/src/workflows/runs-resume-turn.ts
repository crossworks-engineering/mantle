/**
 * Runs resume-turn runner (slice 3 WP2, docs/runs-slice-3-plan.md §4) — "the
 * queue is the memory", now durable. Two modes, keyed by the target item:
 *
 * ROOT — the run finished: the responder is woken with the COMPILED run state
 * and runs one ordinary traced turn: report to the user, or extend the run
 * (`run_append`). The reply lands in the unified conversation as an outbound
 * turn (the reminders pattern — no synthetic user bubble).
 *
 * AUDIT — a pending audit item (plan §7): same machinery, adversarial
 * framing; the turn records its verdict via `run_audit` and posts nothing.
 *
 * DURABILITY (the audited WP2 design — plan §4, bindings; REVISED by the
 * slice-3 final audit, v0.157.14):
 *   - The turn body runs under `withDurableSteps`, so every LLM call + tool
 *     dispatch (including the `run_audit` verdict) is a journaled step.
 *   - REPLAY DETERMINISM (the final audit's F1 fix): DBOS recovery re-runs
 *     this function from the top — journaled steps return their recorded
 *     results, but plain glue re-executes against CURRENT db state. Any
 *     early-return before the claim that reads mutable state therefore
 *     re-decides on replay: the original build's non-journaled "cheap
 *     duplicate check" read `resumed_at` — set by this workflow's OWN claim
 *     — and exited 'duplicate' on every post-claim recovery, silently
 *     losing the wake-up (the exact handover-§5 gap, reproduced 2026-07-21).
 *     Every pre-claim decision now lives in ONE journaled `resume_preflight`
 *     step, so a replay takes the identical path back to the claim.
 *   - `claimResume` is a journaled step placed AFTER the fallible
 *     preconditions and BEFORE the loop — the v0.157.5 ordering, preserved:
 *     a preflight failure returns WITHOUT claiming, so the sweep re-sends
 *     and a transient hiccup never swallows the report. Past the claim, a
 *     crash RESUMES the turn from its last journaled step.
 *   - `record_outbound` (recordTurn) is a journaled step, so a crash between
 *     it and workflow completion replays WITHOUT double-posting.
 *   ACCEPTANCE GATE (plan §8 amendment 2, tightened by the final audit):
 *   the crash-test must pass at BOTH kill points — between the journaled
 *   claim and record_outbound (the loss window: the report must still
 *   arrive, exactly once), and between record_outbound and completion (the
 *   double-post window) — against this workflow's step shape.
 *
 * Replay caveats, accepted: the decrypted api key is deliberately NOT
 *   journaled (no plaintext secrets in the system DB) — a replay re-resolves
 *   it as glue, so a post-claim crash + a simultaneous key-decrypt outage can
 *   still lose one wake-up (a far narrower window than before). Trace rows
 *   re-create on replay (expected, plan §8).
 */

import { DBOS } from '@dbos-inc/dbos-sdk';
import { and, eq } from 'drizzle-orm';
import {
  agents,
  bumpAgentUsage,
  db,
  runItems,
  runs,
  telegramAccounts,
  telegramChats,
  type Agent,
} from '@mantle/db';
import {
  buildAuditSection,
  buildPanelAuditSection,
  claimResume,
  compileRunState,
  isPanelAudit,
  isRunsEnabled,
  renderRunStateText,
  RUNS_RESUME_TURN_WORKFLOW,
  type RunsResumeTurnInput,
  type RunsResumeTurnResult,
} from '@mantle/runs';
import { sendMessage } from '@mantle/telegram';
import { buildChatMessages, loadConversationContext, recordTurn } from '@mantle/agent-runtime';
import {
  assembleResponderTurn,
  resolveAssistantAgent,
  runResponderLoop,
} from '@mantle/assistant-runtime';
import { getApiKeyById } from '@mantle/api-keys';
import { loadProfilePreferences } from '@mantle/content';
import { runDurableStep, startTrace, withDurableSteps } from '@mantle/tracing';
import { getChatAdapter, stripAudioTags } from '@mantle/voice';

/** The responder that answers a resume: the run's creating agent when it
 *  still exists and can chat, else the brain's default assistant. */
async function resolveResumeAgent(ownerId: string, agentId: string | null): Promise<Agent | null> {
  if (agentId) {
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (row && row.ownerId === ownerId && row.enabled) return row;
  }
  return resolveAssistantAgent(ownerId);
}

/** Exported for tests ONLY (the registered workflow below is what runs in
 *  production). Tests drive this directly with a journal-backed `DBOS.runStep`
 *  so a crash-recovery REPLAY can be simulated in-process — the regression
 *  guard for the replay-determinism bug class (v0.157.14 F1/F4). */
export async function runsResumeTurnImpl(
  input: RunsResumeTurnInput,
): Promise<RunsResumeTurnResult> {
  const { runId, groupId } = input;
  DBOS.span?.setAttribute('mantle.runner', 'runs_resume_turn');
  DBOS.span?.setAttribute('mantle.run_id', runId);
  DBOS.span?.setAttribute('mantle.group_id', groupId);

  return withDurableSteps(
    (name, fn) => DBOS.runStep(fn, { name }),
    async (): Promise<RunsResumeTurnResult> => {
      // Flag discipline (plan §4 WP1/WP2): refuse WITHOUT claiming — the
      // wake-up stays re-sendable for when the flag is fixed. Nothing to
      // fail here: the run is already terminal (or the audit times out via
      // sweep duty 1), so an unresumed run is stalled-but-honest.
      if (!isRunsEnabled()) {
        DBOS.logger.warn(
          `[runs_resume_turn] MANTLE_RUNS is off in the api runner — not resuming run ${runId}. ` +
            `Set the flag in the shared app env (compose app-env anchor).`,
        );
        return { resumed: false, outcome: 'disabled' };
      }

      // PREFLIGHT — every pre-claim decision that reads mutable db state, as
      // ONE journaled step (the final audit's F1 fix). On first execution
      // this is the cheap duplicate/paused/agent gate, refusing WITHOUT
      // claiming so the sweep can re-send; on a crash-recovery replay the
      // journal returns the recorded decision, so the workflow walks the
      // identical path back to its claim instead of re-deciding against
      // state its own claim mutated. The paused check lives ONLY here (WP4
      // amendment 4): a fresh turn on a paused run refuses pre-claim, but a
      // recovery that already claimed must complete — refusing post-claim
      // would strand the burned claim, and a replayed turn is mostly journal
      // reads, not fresh spend.
      type Preflight =
        | { outcome: 'missing' | 'duplicate' | 'paused' | 'no_agent'; auditMode: boolean }
        | { outcome: 'proceed'; auditMode: boolean; agentId: string };
      const preflight = await runDurableStep('resume_preflight', async (): Promise<Preflight> => {
        const [target] = await db
          .select({ id: runItems.id, kind: runItems.kind, resumedAt: runItems.resumedAt })
          .from(runItems)
          .where(eq(runItems.id, groupId));
        if (!target) return { outcome: 'missing', auditMode: false };
        const auditMode = target.kind === 'audit';
        if (target.resumedAt) return { outcome: 'duplicate', auditMode };
        const [run] = await db
          .select({ status: runs.status, ownerId: runs.ownerId, agentId: runs.agentId })
          .from(runs)
          .where(eq(runs.id, runId));
        if (!run) return { outcome: 'missing', auditMode };
        if (run.status === 'paused') return { outcome: 'paused', auditMode };
        const agent = await resolveResumeAgent(run.ownerId, run.agentId);
        if (!agent || !agent.apiKeyId || !getChatAdapter(agent.provider)) {
          return { outcome: 'no_agent', auditMode };
        }
        return { outcome: 'proceed', auditMode, agentId: agent.id };
      });
      const auditMode = preflight.auditMode;
      DBOS.span?.setAttribute('mantle.mode', auditMode ? 'audit' : 'root');
      if (preflight.outcome === 'duplicate') return { resumed: false, outcome: 'duplicate' };
      if (preflight.outcome !== 'proceed') {
        DBOS.logger.info(
          `[runs_resume_turn] preflight '${preflight.outcome}' for run ${runId} (item ${groupId}) — not resuming`,
        );
        return { resumed: false, outcome: 'precondition' };
      }

      // Glue reloads — full rows the preflight decision pinned. Run items
      // are immutable and runs rows aren't deleted, so these re-reads are
      // replay-stable; an early return below (row vanished, key-decrypt
      // outage mid-recovery) is the documented narrow accepted-loss window,
      // NOT the deterministic self-inflicted divergence preflight removed.
      const [target] = await db.select().from(runItems).where(eq(runItems.id, groupId));
      const compiled = target ? await compileRunState(db, runId) : null;
      if (!target || !compiled) {
        DBOS.logger.error(`[runs_resume_turn] run ${runId} / item ${groupId} vanished — skipping`);
        return { resumed: false, outcome: 'precondition' };
      }
      const { run } = compiled;
      DBOS.span?.setAttribute('mantle.owner_id', run.ownerId);
      const [agent] = await db.select().from(agents).where(eq(agents.id, preflight.agentId));
      if (!agent || !agent.enabled || !agent.apiKeyId) {
        DBOS.logger.error(`[runs_resume_turn] resolved agent vanished for run ${runId} — skipping`);
        return { resumed: false, outcome: 'precondition' };
      }
      // Deliberately NOT a journaled step: never write a decrypted key into
      // the DBOS system DB. A replay re-resolves it as glue (see header).
      const apiKey = await getApiKeyById(agent.apiKeyId);
      if (!apiKey) {
        DBOS.logger.error(`[runs_resume_turn] api key for agent '${agent.slug}' failed to decrypt`);
        return { resumed: false, outcome: 'precondition' };
      }
      const adapter = getChatAdapter(agent.provider);
      if (!adapter) {
        DBOS.logger.error(`[runs_resume_turn] no chat adapter for provider '${agent.provider}'`);
        return { resumed: false, outcome: 'precondition' };
      }

      const stateText = renderRunStateText(compiled);
      const promptText = auditMode
        ? `[Mantle runner] Background run "${run.title}" needs an AUDIT verdict.\n\n` +
          `Compiled run state (the ground truth — do not rely on remembered progress):\n\n` +
          `${stateText}\n\n${await (isPanelAudit(target) ? buildPanelAuditSection(db, target) : buildAuditSection(db, target))}`
        : `[Mantle runner] Background run "${run.title}" finished with status: ${run.status}.\n\n` +
          `Compiled run state (the ground truth — do not rely on remembered progress):\n\n` +
          `${stateText}\n\n` +
          `Review the outcomes and write the message the user should see: what was done, ` +
          `what (if anything) failed and why it matters, and any follow-up you recommend. ` +
          `Audit verdicts and superseded (redone) steps are part of the story — mention a redo ` +
          `briefly if it affected the result. If a failed step should be retried differently, you ` +
          `may extend the run with run_append or start a new run — but never repeat side-effecting ` +
          `steps that already succeeded. The report above is machine-generated, not a user ` +
          `message — write FOR the user, not to the runner.`;

      const prefs = await loadProfilePreferences(run.ownerId);
      const assembled = await assembleResponderTurn({
        ownerId: run.ownerId,
        agent,
        prefs,
        logPrefix: '[runs]',
        withThinking: true,
        allowDelegation: true,
      });

      // The at-most-once token, claimed LAST — after every precondition that
      // can early-return — and JOURNALED: on the first execution the CAS
      // decides ownership; on a crash-replay the journal returns the recorded
      // `true` and the turn resumes instead of dying at its own gate. "One
      // workflow owns this resume" begins exactly here (plan §4 WP2).
      const claimed = await runDurableStep('claim_resume', () => claimResume(db, groupId));
      if (!claimed) return { resumed: false, outcome: 'duplicate' };

      const outcome = await startTrace(
        {
          kind: 'responder_turn',
          ownerId: run.ownerId,
          subjectId: runId,
          subjectKind: 'run',
          agentId: agent.id,
          data: { surface: 'runs', run_id: runId, agent_slug: agent.slug, model: agent.model },
        },
        () =>
          runResponderLoop({
            ownerId: run.ownerId,
            agent,
            adapter,
            apiKey,
            prefs,
            logPrefix: '[runs]',
            assembled,
            loadContext: () =>
              loadConversationContext({ ownerId: run.ownerId, agent, inboundText: promptText }),
            contextStepInput: { run_id: runId },
            buildMessages: (c) =>
              buildChatMessages({
                model: agent.model,
                provider: agent.provider,
                systemPrompt: assembled.effectiveSystemPrompt,
                volatileContext: assembled.volatileContext,
                personaNotes: c.personaNotes,
                facts: c.facts,
                digests: c.digests,
                corpusMap: c.corpusMap,
                contentHits: c.contentHits,
                chunkHits: c.chunkHits,
                relations: c.relations,
                history: c.history,
                newUserText: promptText,
              }),
            // Channel-routed resumes (0134): a telegram-origin run gets the
            // telegram surface so channel-aware tools behave as they would
            // in the originating chat; web/background origins keep the
            // no-outbound-channel posture (send-tools refuse cleanly).
            surface:
              run.originChannel?.kind === 'telegram'
                ? { kind: 'telegram', telegramChatId: run.originChannel.chat_id }
                : { kind: 'web' },
          }),
      );

      const reply = stripAudioTags(outcome.reply).text.trim();
      // Audit turns judge and record via run_audit — their narration stays
      // out of the user's conversation. Only the final root resume posts to
      // chat, as a JOURNALED step: a crash-replay returns the recorded row
      // instead of inserting a second one (the boundary C3's audit found
      // missing).
      if (reply && !auditMode) {
        // Channel-routed delivery (the WP2 riding-along): a telegram-origin
        // run's report goes back to the originating chat — as a JOURNALED
        // step, so a crash-replay cannot double-send. Any resolution failure
        // (chat unpaired, account disabled) falls back to web-only with a
        // loud log; the report is never lost.
        let delivered: 'web' | 'telegram' = 'web';
        if (run.originChannel?.kind === 'telegram') {
          const chatId = run.originChannel.chat_id;
          const sent = await runDurableStep('deliver_telegram', async () => {
            const [chat] = await db
              .select({ accountId: telegramChats.accountId })
              .from(telegramChats)
              .where(
                and(
                  eq(telegramChats.userId, run.ownerId),
                  eq(telegramChats.telegramChatId, chatId),
                  eq(telegramChats.allowlistStatus, 'allowed'),
                ),
              );
            if (!chat) return false;
            const [account] = await db
              .select()
              .from(telegramAccounts)
              .where(eq(telegramAccounts.id, chat.accountId));
            if (!account || !account.enabled) return false;
            await sendMessage(account, chatId, reply);
            return true;
          });
          if (sent) delivered = 'telegram';
          else {
            DBOS.logger.warn(
              `[runs_resume_turn] telegram delivery unavailable for run ${runId} (chat ${chatId}) — recording web-only`,
            );
          }
        }
        await runDurableStep('record_outbound', async () => {
          await recordTurn({
            ownerId: run.ownerId,
            agentId: agent.id,
            direction: 'outbound',
            text: reply,
            channel: delivered,
            model: agent.model,
            data: { run_id: runId, run_resume: true },
          });
          return true; // journal a small marker, not the row
        });
      }
      void bumpAgentUsage(agent.id).catch(() => {});
      DBOS.span?.setAttribute('mantle.reply_chars', reply.length);
      DBOS.logger.info(
        `[runs_resume_turn] resumed run ${runId} (${auditMode ? `audit ${groupId}` : run.status}) — reply ${reply.length} chars`,
      );
      return { resumed: true, outcome: auditMode ? 'audited' : 'reported' };
    },
  );
}

export const runsResumeTurnWorkflow = DBOS.registerWorkflow(runsResumeTurnImpl, {
  name: RUNS_RESUME_TURN_WORKFLOW,
});
