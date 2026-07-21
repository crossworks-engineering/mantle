/**
 * The resume turn — "the queue is the memory". When a run's root group
 * completes, the responder is woken with the COMPILED run state (per-item
 * status, one-line outcomes, costs — never held context) and runs one
 * ordinary traced turn: report to the user, or extend the run (`run_append`)
 * if the outcomes demand it. The reply lands in the unified conversation as
 * an outbound turn (the reminders pattern — no synthetic user bubble).
 *
 * At-most-once: `claimResume` CASes `run_items.resumed_at` BEFORE the turn.
 * A duplicate resume job (pg-boss redelivery, sweep re-send) acks silently; a
 * crash mid-turn loses that one wake-up rather than ever double-posting. The
 * full run record survives in the run view either way.
 */
import { eq } from 'drizzle-orm';
import { agents, bumpAgentUsage, db, type Agent } from '@mantle/db';
import { claimResume, compileRunState, renderRunStateText } from '@mantle/runs';
import { buildChatMessages, loadConversationContext, recordTurn } from '@mantle/agent-runtime';
import {
  assembleResponderTurn,
  resolveAssistantAgent,
  runResponderLoop,
} from '@mantle/assistant-runtime';
import { getApiKeyById } from '@mantle/api-keys';
import { loadProfilePreferences } from '@mantle/content';
import { startTrace } from '@mantle/tracing';
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

export async function runResumeTurn(runId: string, groupId: string): Promise<void> {
  const claimed = await claimResume(db, groupId);
  if (!claimed) return; // duplicate wake-up — already resumed (or resuming)

  const compiled = await compileRunState(db, runId);
  if (!compiled) {
    console.error(`[runs] resume: run ${runId} not found`);
    return;
  }
  const { run } = compiled;
  const agent = await resolveResumeAgent(run.ownerId, run.agentId);
  if (!agent) {
    console.error(`[runs] resume: no chat-capable agent for run ${runId}`);
    return;
  }
  if (!agent.apiKeyId) {
    console.error(`[runs] resume: agent '${agent.slug}' has no api key — skipping resume turn`);
    return;
  }
  const apiKey = await getApiKeyById(agent.apiKeyId);
  if (!apiKey) {
    console.error(`[runs] resume: api key for agent '${agent.slug}' failed to decrypt`);
    return;
  }
  const adapter = getChatAdapter(agent.provider);
  if (!adapter) {
    console.error(`[runs] resume: no chat adapter for provider '${agent.provider}'`);
    return;
  }

  const stateText = renderRunStateText(compiled);
  const promptText =
    `[Mantle runner] Background run "${run.title}" finished with status: ${run.status}.\n\n` +
    `Compiled run state (the ground truth — do not rely on remembered progress):\n\n` +
    `${stateText}\n\n` +
    `Review the outcomes and write the message the user should see: what was done, ` +
    `what (if anything) failed and why it matters, and any follow-up you recommend. ` +
    `If a failed step should be retried differently, you may extend the run with run_append ` +
    `or start a new run — but never repeat side-effecting steps that already succeeded. ` +
    `The report above is machine-generated, not a user message — write FOR the user, not to the runner.`;

  const prefs = await loadProfilePreferences(run.ownerId);
  const assembled = await assembleResponderTurn({
    ownerId: run.ownerId,
    agent,
    prefs,
    logPrefix: '[runs]',
    withThinking: true,
    allowDelegation: true,
  });

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
        // Background surface: no outbound channel beyond the recorded reply —
        // send-tools refuse cleanly, matching /assistant.
        surface: { kind: 'web' },
      }),
  );

  const reply = stripAudioTags(outcome.reply).text.trim();
  if (reply) {
    await recordTurn({
      ownerId: run.ownerId,
      agentId: agent.id,
      direction: 'outbound',
      text: reply,
      channel: 'web',
      model: agent.model,
      data: { run_id: runId, run_resume: true },
    });
    void bumpAgentUsage(agent.id).catch(() => {});
  }
  console.log(`[runs] resumed run ${runId} (${run.status}) — reply ${reply.length} chars`);
}
