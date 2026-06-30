/**
 * Continuation guard for providers WITHOUT thinking-block echo-back.
 *
 * Anthropic (direct) and Gemini sign each thinking block / carry a thought
 * signature, and a continued conversation is expected to replay it. Our tool
 * loop reconstructs the assistant turn from text + toolCalls only — it drops the
 * signed block — so on a continuation (a request whose history already contains
 * an assistant tool_use turn) we MUST NOT enable thinking: Anthropic 400s a
 * thinking-enabled request whose prior assistant tool_use turn lacks its block.
 *
 * Disabling thinking on continuations sidesteps that entirely: the first round
 * still thinks (no prior tool_use yet), and once the loop is in a tool
 * continuation the request runs without thinking — the thinking-less history is
 * valid because the block requirement only applies when thinking is on.
 *
 * (OpenRouter does NOT use this guard — it captures + replays `reasoning_details`
 * properly, so it thinks on every round.)
 */

import type { ChatOptions } from './types';

/** True if the message history already contains an assistant turn with tool
 *  calls — i.e. we're on iteration ≥2 of a tool loop and would have to replay a
 *  thinking-less tool_use turn. */
export function isToolContinuation(messages: ChatOptions['messages']): boolean {
  return messages.some(
    (m) =>
      m.role === 'assistant' &&
      'toolCalls' in m &&
      Array.isArray(m.toolCalls) &&
      m.toolCalls.length > 0,
  );
}

/** Whether to request thinking on this turn: a positive budget AND not a tool
 *  continuation (for echo-back-less providers). */
export function wantGuardedThinking(opts: ChatOptions): boolean {
  return (
    typeof opts.thinkingBudget === 'number' &&
    opts.thinkingBudget > 0 &&
    !isToolContinuation(opts.messages)
  );
}
