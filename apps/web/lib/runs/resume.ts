/**
 * The resume turn — "the queue is the memory". Two modes, keyed by the item
 * the resume targets:
 *
 * ROOT — the run finished: the responder is woken with the COMPILED run state
 * (per-item status, one-line outcomes, costs — never held context) and runs
 * one ordinary traced turn: report to the user, or extend the run
 * (`run_append`). The reply lands in the unified conversation as an outbound
 * turn (the reminders pattern — no synthetic user bubble).
 *
 * AUDIT — a pending audit item (plan §7): same machinery, adversarial
 * framing. The prompt carries the audited worker's proposal, its MECHANICAL
 * tool ledger, and the pre-check auto-flags; the turn records its verdict via
 * `run_audit` and posts nothing to chat (the trace + run view carry it).
 *
 * At-most-once: `claimResume` CASes `run_items.resumed_at` BEFORE the turn.
 * A duplicate resume job (pg-boss redelivery, sweep re-send) acks silently; a
 * crash mid-turn loses that one wake-up rather than ever double-posting. The
 * full run record survives in the run view either way.
 */
import { eq } from 'drizzle-orm';
import { agents, bumpAgentUsage, db, runItems, type Agent, type RunItemRow } from '@mantle/db';
import {
  claimResume,
  compileRunState,
  findAuditedWorkerItem,
  mechanicalPreCheck,
  renderRunStateText,
} from '@mantle/runs';
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

/** Audit-mode addendum: the pending audit, the audited worker's proposal +
 *  MECHANICAL tool ledger, pre-check auto-flags, and the verdict contract. */
async function buildAuditSection(audit: RunItemRow): Promise<string> {
  const audited = await findAuditedWorkerItem(db, audit);
  const parts: string[] = [];
  parts.push(
    `## PENDING AUDIT — judge it now\n` +
      `Audit item: ${audit.id}\n` +
      `You are the auditor for the worker step below. Fresh eyes, adversarial ` +
      `framing: assume the proposal is wrong until its recorded evidence says otherwise.`,
  );
  if (!audited) {
    parts.push(
      'No completed worker step precedes this audit — record verdict pass with an advisory finding explaining the anomaly.',
    );
  } else {
    const r = (audited.result ?? {}) as Record<string, unknown>;
    const flags = mechanicalPreCheck(r);
    parts.push(
      `### Audited worker step\n${JSON.stringify((audited.payload as Record<string, unknown>)?.step ?? '')}`,
    );
    if (typeof r.proposal === 'string') {
      parts.push(`### Proposal${r.proposal_truncated ? ' (truncated)' : ''}\n${r.proposal}`);
    }
    parts.push(
      `### Recorded tool ledger (mechanical — the worker cannot fake this)\n` +
        (Array.isArray(r.evidence) && r.evidence.length > 0
          ? (r.evidence as Array<{ tool: string; ok: boolean; error?: string }>)
              .map((e) => `- ${e.tool}: ${e.ok ? 'ok' : `FAILED${e.error ? ` (${e.error})` : ''}`}`)
              .join('\n')
          : '(no tool calls — the worker consulted nothing)'),
    );
    if (typeof r.output_handle === 'string') {
      parts.push(`Full worker output: read_result handle '${r.output_handle}' (query/grep/page).`);
    }
    if (flags.length > 0) {
      parts.push(`### Mechanical pre-check\n${flags.map((f) => `- ${f}`).join('\n')}`);
    }
  }
  parts.push(
    `### Verdict contract\n` +
      `Call run_audit with audit_item_id ${audit.id}. Only BLOCKING findings justify verdict ` +
      `'redo' (one redo max, then it escalates to a human); style preferences and nice-to-haves ` +
      `are 'advisory' on a 'pass'. Provide a 'directive' — the authoritative instruction the next ` +
      `step executes without re-deriving. Do NOT write a user-facing message this turn; judge, ` +
      `call run_audit, and end.`,
  );
  return parts.join('\n\n');
}

export async function runResumeTurn(runId: string, groupId: string): Promise<void> {
  // Mode: an audit item's resume is a judgment turn; the root's is the final
  // report-to-the-user turn.
  const [target] = await db.select().from(runItems).where(eq(runItems.id, groupId));
  if (!target) {
    console.error(`[runs] resume: item ${groupId} not found`);
    return;
  }
  const auditMode = target.kind === 'audit';

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
  const promptText = auditMode
    ? `[Mantle runner] Background run "${run.title}" needs an AUDIT verdict.\n\n` +
      `Compiled run state (the ground truth — do not rely on remembered progress):\n\n` +
      `${stateText}\n\n${await buildAuditSection(target)}`
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
  // Audit turns judge and record via run_audit — their narration stays out of
  // the user's conversation (the trace + run view carry it). Only the final
  // root resume posts to chat.
  if (reply && !auditMode) {
    await recordTurn({
      ownerId: run.ownerId,
      agentId: agent.id,
      direction: 'outbound',
      text: reply,
      channel: 'web',
      model: agent.model,
      data: { run_id: runId, run_resume: true },
    });
  }
  void bumpAgentUsage(agent.id).catch(() => {});
  console.log(
    `[runs] resumed run ${runId} (${auditMode ? `audit ${groupId}` : run.status}) — reply ${reply.length} chars`,
  );
}
