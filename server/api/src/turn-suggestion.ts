/**
 * Follow-up suggester. After a turn finalizes, proposes ONE short question the
 * user would plausibly ask next; the web composer renders it as an
 * accept-with-Enter chip. Same execution shape as ./turn-narration.ts:
 *
 * It is a CHEAP, configurable AI worker. It runs on the owner's dedicated
 * `suggester` worker (a fast remote model, e.g. gemini-flash-lite) whose
 * `system_prompt` is the tuning knob. Brains without one fall back to the
 * `narrator`, then the `summarizer`, with the built-in prompt, so the feature
 * works everywhere and a dedicated worker only exists to tune it.
 *
 * Strictly off the critical path: the runtime fires the installed hook (see
 * installTurnSuggestionHook) fire-and-forget AFTER the `done` emit, so it can
 * never delay a reply. Delivery is pull, not push: the result is persisted onto
 * the outbound row's `data` jsonb and the client fetches it after `done` (a
 * post-done SSE event would race the client's stream teardown and the trace's
 * freed seq counter).
 *
 * Guards, ALL cheaper than an LLM call and checked before it:
 *   - per-agent opt-in: agents.params.suggest_follow_up === true (off by default)
 *   - the turn completed on its own (not user-stopped; failures never get here)
 *   - the reply is substantive (length floor) and the user text non-trivial
 *   - env kill switch: MANTLE_TURN_SUGGESTIONS=0 silences it fleet-wide
 */

import { and, eq, sql } from 'drizzle-orm';
import {
  db,
  assistantMessages,
  getDefaultWorker,
  type AgentParams,
  type SuggesterParams,
} from '@mantle/db';
import { resolveChatKey, resolveChatRoutes, chatWithFailover } from '@mantle/agent-runtime';
import { setTurnSuggestionHook, type TurnSuggestionContext } from '@mantle/assistant-runtime';
import { env } from '@mantle/config';

const SUGGESTION_PROMPT = `You propose the user's next message in a conversation with an AI assistant. Given the user's last message and the assistant's reply, propose ONE short follow-up question the user would plausibly ask next, in the user's FIRST PERSON voice, under 15 words, specific to the reply's content (dig deeper, apply it, or ask the natural next step). No preamble, no quotes, no list. Reply with ONLY the question.`;

/** Replies shorter than this are one-liners not worth decorating (same
 *  instinct as rich_writing's "do NOT decorate trivial replies"). */
const MIN_REPLY_CHARS = 200;
/** User text shorter than this ("ok", "thanks") signals a closing beat, not a
 *  thread the user wants to keep pulling. */
const MIN_USER_CHARS = 8;

export function isTurnSuggestionsEnabled(): boolean {
  // On unless explicitly disabled (0/false/off/no). Unset → on. The real
  // default-off lives per agent (params.suggest_follow_up); this is the
  // operator's fleet-wide kill switch.
  const v = env('MANTLE_TURN_SUGGESTIONS')?.trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}

/** Strip wrapping quotes/bullets, collapse whitespace, cap length. `max_tokens`
 *  is the real length control; this is a runaway guard. */
function tidy(raw: string): string {
  let s = raw.trim().replace(/\s+/g, ' ');
  s = s
    .replace(/^[-*•]\s*/, '')
    .replace(/^["“”'']+/, '')
    .replace(/["“”'']+$/, '')
    .trim();
  if (s.length > 200) return ''; // a runaway "question" is worse than none
  return s;
}

/**
 * Generate + persist the follow-up suggestion for one finalized turn. Returns
 * the suggestion for tests, or null when any guard declined or the LLM/DB path
 * failed. Never throws.
 */
export async function suggestFollowUp(ctx: TurnSuggestionContext): Promise<string | null> {
  try {
    if (!isTurnSuggestionsEnabled()) return null;
    const params = (ctx.agent.params ?? {}) as AgentParams;
    if (params.suggest_follow_up !== true) return null;
    if (ctx.stopped) return null;
    if (ctx.replyText.trim().length < MIN_REPLY_CHARS) return null;
    if (ctx.userText.trim().length < MIN_USER_CHARS) return null;

    // Dedicated suggester worker when provisioned; otherwise the narrator
    // (same cheap chat shape), then the summarizer: the narrator's own
    // fallback, so any brain that can narrate can also suggest.
    const worker =
      (await getDefaultWorker(ctx.ownerId, 'suggester')) ??
      (await getDefaultWorker(ctx.ownerId, 'narrator')) ??
      (await getDefaultWorker(ctx.ownerId, 'summarizer'));
    if (!worker) return null;
    const keyCheck = await resolveChatKey(ctx.ownerId, worker);
    if (!keyCheck.ok) return null;

    // Honour the suggester worker's own prompt + knobs. The fallbacks keep the
    // built-in prompt; their prompts/params tune narration/digesting, not this.
    const isSuggester = worker.kind === 'suggester';
    const workerParams = (isSuggester ? worker.params : null) as SuggesterParams | null;
    const systemPrompt =
      isSuggester && worker.systemPrompt?.trim() ? worker.systemPrompt : SUGGESTION_PROMPT;
    const temperature = workerParams?.temperature ?? 0.7;
    const maxTokens = workerParams?.max_tokens ?? 48;

    const routes = resolveChatRoutes(worker);
    const { result } = await chatWithFailover(ctx.ownerId, routes, {
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `User's message:\n${ctx.userText}\n\nAssistant's reply:\n${ctx.replyText}`,
        },
      ],
      temperature,
      maxTokens,
    });
    const suggestion = tidy(result.text ?? '');
    if (!suggestion) return null;

    // Persist onto the finalized outbound row's data (merged, owner-scoped).
    // The client's fetch-after-done reads it from here; if the client already
    // gave up polling, the row simply carries it and nothing shows. Fine.
    await db
      .update(assistantMessages)
      .set({
        data: sql`${assistantMessages.data} || ${JSON.stringify({
          suggestion,
          suggestedAt: new Date().toISOString(),
        })}::jsonb`,
      })
      .where(
        and(eq(assistantMessages.id, ctx.outboundId), eq(assistantMessages.ownerId, ctx.ownerId)),
      );
    return suggestion;
  } catch (err) {
    console.warn(
      '[suggester] failed (no suggestion for this turn):',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** Install the runtime's post-finalize hook. Called once at api boot, next to
 *  installTurnStreamObserver. The hook is synchronous by contract: it kicks
 *  off suggestFollowUp WITHOUT awaiting so the turn's caller never waits. */
export function installTurnSuggestionHook(): void {
  setTurnSuggestionHook((ctx) => {
    void suggestFollowUp(ctx);
  });
}
