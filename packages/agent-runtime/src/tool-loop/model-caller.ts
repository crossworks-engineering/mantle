/**
 * Tool loop: every LLM round of one turn — the normal rounds, the empty-reply
 * retry and the forced final answer — on the ACTIVE route, with the sticky
 * primary→backup failover. Lifted out of runToolLoop on 2026-09-02 (audit,
 * complexity C1); step names, inputs and the failover rule are unchanged.
 */
import { step, isTurnStreaming, emitTurnDelta, currentTurnAbortSignal } from '@mantle/tracing';
import type { ChatDispatcher, ChatOptions, ChatResult, ChatToolDefinition } from '@mantle/voice';
import { errorMessage } from '@mantle/std';
import { recordChatUsage } from '../llm-usage';
import { isChatFailover } from '../chat-failover';
import type { ChatMessage } from '../messages';
import type { ToolLoopArgs } from '../tool-loop';
import { clampThinkingBudget, resolveMaxTokens } from '../tool-loop';

/** Run one chat round, streaming live token deltas when the runner has turn
 *  streaming active (`isTurnStreaming()`) AND this route's adapter supports it.
 *  Falls back to the one-shot `chat()` otherwise — the resolved `ChatResult` is
 *  identical either way (text + toolCalls + usage), so the loop's tool-dispatch
 *  logic doesn't care which path ran. Streaming is pure decoration around the
 *  durable result. `round` tags each delta so the client can scope the live reply. */
export function dispatchChat(
  adapter: ChatDispatcher,
  opts: ChatOptions,
  round: number,
): Promise<ChatResult> {
  // Thread the current turn's cancellation signal into every LLM call so a user
  // Stop aborts generation (the streaming adapter returns its partial reply).
  const withSignal = { ...opts, signal: currentTurnAbortSignal() };
  if (isTurnStreaming() && typeof adapter.chatStream === 'function') {
    return adapter.chatStream(withSignal, (d) => emitTurnDelta(round, d.type, d.text));
  }
  return adapter.chat(withSignal);
}

type Route = {
  adapter: ChatDispatcher;
  apiKey: string;
  model: string;
  baseUrl: string | null;
  viaTailnet: boolean;
};

export interface ModelCaller {
  /** One tool-loop round (may fail over to the backup, once per turn). */
  round(iter: number): Promise<ChatResult>;
  /** The answer-only pass after the loop ended without a final text. */
  forceFinal(reason: string, iter: number): Promise<ChatResult>;
  /** One nudge when a round came back empty; returns the retried text. */
  retryEmpty(reason: string): Promise<string>;
  /** Output tokens summed across every round so far. */
  readonly tokensOut: number;
  readonly failedOver: boolean;
  readonly model: string;
}

export function createModelCaller(deps: {
  args: ToolLoopArgs;
  messages: ChatMessage[];
  toolsForModel: ChatToolDefinition[];
  turnAborted: () => boolean;
}): ModelCaller {
  const { args, messages, toolsForModel, turnAborted } = deps;
  const sendTools = toolsForModel.length > 0;
  // The active route. Starts on the primary; a mid-loop route-DOWN / 429 / 5xx
  // failure flips it to the backup for the REST of this turn (sticky), so we
  // don't switch models halfway through a reasoning chain. A fresh turn calls
  // runToolLoop again and starts on the primary.
  let active: Route = {
    adapter: args.adapter,
    apiKey: args.apiKey,
    model: args.model,
    baseUrl: args.baseUrl ?? null,
    viaTailnet: args.viaTailnet ?? false,
  };
  let failedOver = false;
  // Running output-token total for the whole turn (summed across every LLM
  // round, including failover / empty-reply / force-final passes).
  let tokensOut = 0;

  const routeOpts = () => ({
    apiKey: active.apiKey,
    model: active.model,
    ...(active.baseUrl ? { baseUrl: active.baseUrl } : {}),
    ...(active.viaTailnet ? { viaTailnet: true } : {}),
  });
  const maxRetries = () =>
    typeof args.params.max_retries === 'number' ? { maxRetries: args.params.max_retries } : {};

  return {
    get tokensOut() {
      return tokensOut;
    },
    get failedOver() {
      return failedOver;
    },
    get model() {
      return active.model;
    },

    round(iter) {
      return step(
        {
          name:
            iter === 0
              ? `${active.adapter.adapterName}_chat`
              : `${active.adapter.adapterName}_chat[${iter}]`,
          kind: 'llm_call',
          input: {
            model: active.model,
            provider: active.adapter.providerId,
            iter,
            tools: toolsForModel.length,
            ...(failedOver ? { failed_over: true } : {}),
          },
        },
        async (h) => {
          // Adaptive thinking on the tool-loop turn (gated per user — resolved by
          // the caller from profile prefs: switch ON + positive budget). When on,
          // the model reasons before answering and the reasoning streams back as
          // `reasoning` deltas + signed `reasoning_details` (echoed across rounds).
          // Reasoning-capable models reject sampling params, so we drop
          // temperature/top_p whenever thinking is requested.
          //
          // Clamp the budget against the agent's max_tokens: the reasoning
          // providers (OpenRouter→Anthropic, Gemini) require the thinking budget to
          // be < max_tokens AND need room left for the answer, else they 400. Cap
          // at half the token budget; if that floor is below the 1024 provider
          // minimum, drop thinking rather than send a doomed request. When
          // max_tokens is unset the provider uses its own large default, so the
          // budget passes through. (Anthropic-direct ignores the magnitude — it
          // treats any >0 as adaptive on/off — so the clamp is a no-op there.)
          const thinkingBudget = clampThinkingBudget(
            args.thinkingBudget ?? 0,
            args.params.max_tokens,
          );
          // Effective max_tokens for the request. When thinking is on but the agent
          // pinned NO max_tokens, send an explicit ceiling above the budget — the
          // reasoning providers require max_tokens > budget and may inject a small
          // default of their own (e.g. OpenRouter→Anthropic), which would 400. A
          // ceiling of budget*2 keeps the same half-budget headroom the clamp uses.
          const effectiveMaxTokens = resolveMaxTokens(args.params.max_tokens, thinkingBudget);
          const chatOpts = {
            messages,
            ...(sendTools ? { tools: toolsForModel } : {}),
            // Prompt-cache breakpoints: mark the system block (persona +
            // skills stay turn-to-turn) and the most recent user message
            // (re-sent context monotonically grows; pre-mark for next-turn
            // cache hit). Adapters whose providers don't support cache
            // markers ignore this — see ChatCacheControl docs.
            cacheControl: { systemPrompt: true, lastUserMessage: true },
            ...(thinkingBudget > 0 ? { thinkingBudget } : {}),
            // Gated on the CLAMPED budget, not the raw effort: when the clamp
            // drops thinking (budget below the provider floor for this agent's
            // max_tokens) the effort must drop with it, or the request would ask
            // for reasoning the token ceiling can't accommodate.
            ...(thinkingBudget > 0 && args.thinkingEffort
              ? { thinkingEffort: args.thinkingEffort }
              : {}),
            ...(thinkingBudget === 0 && typeof args.params.temperature === 'number'
              ? { temperature: args.params.temperature }
              : {}),
            ...(typeof effectiveMaxTokens === 'number' ? { maxTokens: effectiveMaxTokens } : {}),
            ...(thinkingBudget === 0 && typeof args.params.top_p === 'number'
              ? { topP: args.params.top_p }
              : {}),
            ...maxRetries(),
          };
          try {
            const r = await dispatchChat(active.adapter, { ...routeOpts(), ...chatOpts }, iter);
            recordChatUsage(h, r, active.model);
            tokensOut += r.tokensOut ?? 0;
            return r;
          } catch (err) {
            // Fail over to the backup once per turn, only on a route-DOWN /
            // 429 / 5xx error. 4xx bad-input would fail identically on the
            // backup, so rethrow those.
            // A user Stop on the one-shot chat() path surfaces as a thrown
            // AbortError — that's the Stop, not a route failure. Rethrow before
            // the failover check so we don't dispatch the backup (and burn its
            // retries) against an already-dead signal; run-turn's catch
            // recognises the aborted signal and finalizes as a stop.
            if (turnAborted()) throw err;
            if (!args.backup || failedOver || !isChatFailover(err)) throw err;
            console.warn(
              `[tool-loop] primary '${active.adapter.adapterName}:${active.model}' failed ` +
                `(${errorMessage(err)}) — failing over to backup ` +
                `'${args.backup.adapter.adapterName}:${args.backup.model}' for the rest of this turn`,
            );
            active = {
              adapter: args.backup.adapter,
              apiKey: args.backup.apiKey,
              model: args.backup.model,
              baseUrl: args.backup.baseUrl ?? null,
              viaTailnet: args.backup.viaTailnet ?? false,
            };
            failedOver = true;
            const r = await dispatchChat(active.adapter, { ...routeOpts(), ...chatOpts }, iter);
            recordChatUsage(h, r, active.model);
            tokensOut += r.tokensOut ?? 0;
            return r;
          }
        },
      );
    },

    forceFinal(reason, iter) {
      // Runs on the ACTIVE route (not args.*): if the turn failed over mid-loop,
      // going back to the primary here would re-hit the route that just died —
      // and the active route's baseUrl/viaTailnet must travel too (a local
      // adapter without its baseUrl is a dead call).
      return step(
        {
          name: `${active.adapter.adapterName}_chat[force_final]`,
          kind: 'llm_call',
          input: {
            model: active.model,
            provider: active.adapter.providerId,
            reason,
            ...(failedOver ? { failed_over: true } : {}),
          },
        },
        async (h) => {
          const r = await dispatchChat(
            active.adapter,
            {
              ...routeOpts(),
              messages,
              // toolChoice: 'none' explicitly disables tool calling for the
              // final pass — force a text answer. Adapters whose providers
              // don't honour 'none' fall back to dropping the tools field
              // (Anthropic) or no-op (xAI/HF treat it as auto).
              toolChoice: 'none',
              cacheControl: { systemPrompt: true },
              ...maxRetries(),
            },
            iter,
          );
          recordChatUsage(h, r, active.model);
          tokensOut += r.tokensOut ?? 0;
          return r;
        },
      );
    },

    retryEmpty(reason) {
      // Empty-reply backstop. Some models return literally zero output tokens on
      // a text-only call whose transcript ends in tool results — observed on
      // gemini-3.5-flash in the force-final pass (2026-06-11 web turn that 500'd
      // with 'assistant: empty reply from model'). One retry with an explicit
      // user-role nudge gives the model something concrete to respond to; runs on
      // the ACTIVE route. Still-empty after the retry is returned as-is — the
      // caller decides how to degrade (the web assistant substitutes a fallback
      // reply instead of failing the turn).
      messages.push({
        role: 'user',
        content:
          '(Your previous response was empty. Reply now with your final answer to ' +
          'the user, in plain text. Do not call tools.)',
      });
      return step(
        {
          name: `${active.adapter.adapterName}_chat[empty_retry]`,
          kind: 'llm_call',
          input: { model: active.model, provider: active.adapter.providerId, reason },
        },
        async (h) => {
          const r = await active.adapter.chat({
            ...routeOpts(),
            messages,
            toolChoice: 'none',
            cacheControl: { systemPrompt: true },
            ...maxRetries(),
          });
          recordChatUsage(h, r, active.model);
          tokensOut += r.tokensOut ?? 0;
          if (!r.text.trim()) h.setMeta({ still_empty: true });
          return r.text;
        },
      );
    },
  };
}
