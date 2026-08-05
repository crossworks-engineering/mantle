/**
 * Continuation guard for thinking-capable providers.
 *
 * Anthropic (direct) and Gemini sign each thinking block / carry a thought
 * signature, and a continued conversation is expected to replay it. Anthropic
 * 400s a thinking-enabled request whose prior assistant `tool_use` turn lacks
 * its signed block; Gemini 3 does the same for a `functionCall` part with no
 * `thoughtSignature`.
 *
 * Historically our tool loop rebuilt the assistant turn from text + toolCalls
 * only, dropping the signed block, so this guard disabled thinking for the
 * whole rest of any tool loop. That was safe but expensive: the model reasoned
 * on round one and then composed the ANSWER — the round the user actually
 * reads — with reasoning switched off.
 *
 * Both adapters now capture their signed reasoning onto
 * `ChatResult.reasoningDetails` and replay it from
 * `ChatAssistantMessage.reasoningDetails`, so the guard is conditional:
 * thinking stays on whenever every assistant tool-call turn in the history
 * carries something replayable, and falls back to suppression when it doesn't.
 * That preserves the old behaviour for histories recorded before this existed,
 * and for any provider that reports no reasoning at all.
 *
 * (OpenRouter does NOT use this guard — it has always captured + replayed
 * `reasoning_details`, so it thinks on every round.)
 */

import type { ChatOptions } from './types';

/** Assistant turns that requested tools. These are the ones whose signed
 *  reasoning has to be replayable for thinking to stay on. */
function assistantToolTurns(messages: ChatOptions['messages']) {
  return messages.filter(
    (m) =>
      m.role === 'assistant' &&
      'toolCalls' in m &&
      Array.isArray(m.toolCalls) &&
      m.toolCalls.length > 0,
  );
}

/** True if the message history already contains an assistant turn with tool
 *  calls — i.e. we're on iteration ≥2 of a tool loop. */
export function isToolContinuation(messages: ChatOptions['messages']): boolean {
  return assistantToolTurns(messages).length > 0;
}

/** True when EVERY assistant tool-call turn carries reasoning we can replay.
 *
 *  Deliberately all-or-nothing. A history where only some turns kept their
 *  signature is precisely the shape the provider rejects, so a partial replay
 *  is worse than none: it 400s the request rather than merely losing reasoning
 *  quality. One unreplayable turn therefore suppresses thinking for the round.
 */
export function canReplayReasoning(messages: ChatOptions['messages']): boolean {
  const turns = assistantToolTurns(messages);
  if (turns.length === 0) return true;
  return turns.every(
    (m) =>
      'reasoningDetails' in m && Array.isArray(m.reasoningDetails) && m.reasoningDetails.length > 0,
  );
}

/** Whether to request thinking on this turn: a positive budget, AND either this
 *  is the first round or the history's tool turns can be replayed intact. */
export function wantGuardedThinking(opts: ChatOptions): boolean {
  if (typeof opts.thinkingBudget !== 'number' || opts.thinkingBudget <= 0) return false;
  if (!isToolContinuation(opts.messages)) return true;
  return canReplayReasoning(opts.messages);
}
