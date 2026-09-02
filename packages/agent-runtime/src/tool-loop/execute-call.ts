/**
 * Tool loop: running ONE admitted tool call — the traced step that parses,
 * validates, confirm-gates and dispatches it — and turning its outcome into
 * the tool message the model reads (fenced, spilled when oversized). Lifted
 * out of runToolLoop on 2026-09-02 (audit, complexity C1) with the step
 * names, meta and payload shapes unchanged.
 */
import { currentTrace, step } from '@mantle/tracing';
import {
  dispatchTool,
  getBuiltinRedactFields,
  redactArgsForLogging,
  processToolResultForModel,
  notifyPendingCreated,
  sanitizeToolError,
  UNTRUSTED_CONTENT_TOOL_SLUGS,
  type ValidateArgsResult,
  type ToolHandlerResult,
} from '@mantle/tools';
import { db, pendingToolCalls, type Tool } from '@mantle/db';
import { fenceRetrieved } from '../messages';
import type { ToolLoopArgs, ToolValidationMode } from '../tool-loop';
import { REPEATED_FAILURE_LIMIT, type TurnGuards } from './guards';

export async function executeToolCall(p: {
  args: ToolLoopArgs;
  slug: string;
  call: { id: string; function: { name: string; arguments: string } };
  tool: Tool | undefined;
  input: Record<string, unknown>;
  argParseError: string | null;
  argValidation: ValidateArgsResult | null;
  argValidationMode: ToolValidationMode;
  lastUserMessage: string | undefined;
  /** Pending-call ids the loop is collecting; a confirm-gated call appends. */
  pendingIds: string[];
}): Promise<ToolHandlerResult> {
  const { args, slug, call, tool, input, argParseError, argValidation, argValidationMode } = p;
  // Redact sensitive input fields BEFORE they're written to
  // `trace_steps.input`. The `redactedInput` is what we log; the
  // handler still receives the original `input` with the plaintext
  // value. This is the only mitigation for tools like
  // `secret_create` whose whole point is sealing a value — if we
  // logged the raw args, the plaintext PIN would live in Postgres
  // forever next to the sealed copy. Belt and braces.
  const redactedInput = redactArgsForLogging(input, getBuiltinRedactFields(slug));
  return step(
    {
      name: `tool: ${slug}`,
      kind: 'compute',
      input: { slug, args: redactedInput },
    },
    async (handle) => {
      if (argParseError) {
        handle.setMeta({ argsRaw: call.function.arguments });
        handle.setError(argParseError);
        return {
          ok: false as const,
          error:
            `${argParseError}. Re-issue the tool call with a valid JSON object ` +
            `whose keys match the tool's inputSchema. Do not retry with the same arguments.`,
        };
      }
      if (!tool) {
        handle.setError(`tool '${slug}' is not in this agent's allowlist`);
        return {
          ok: false as const,
          error: `tool '${slug}' is not in this agent's allowlist`,
        };
      }
      // Arg-validation telemetry + (enforce-mode) rejection. The meta is
      // written in EVERY mode so /debug can chart repair + violation
      // rates per tool before anyone flips enforcement on.
      if (
        argValidation &&
        (argValidation.repairs.length > 0 ||
          argValidation.unknownKeys.length > 0 ||
          argValidation.violations.length > 0)
      ) {
        handle.setMeta({
          arg_validation: {
            mode: argValidationMode,
            ...(argValidation.repairs.length > 0 ? { repairs: argValidation.repairs } : {}),
            ...(argValidation.unknownKeys.length > 0
              ? { unknown_keys: argValidation.unknownKeys }
              : {}),
            ...(argValidation.violations.length > 0
              ? { violations: argValidation.violations.map((v) => v.message) }
              : {}),
          },
        });
      }
      if (argValidationMode === 'enforce' && argValidation?.error) {
        handle.setError(argValidation.error);
        return { ok: false as const, error: argValidation.error };
      }
      // Confirmation gate: a tool flagged requires_confirm doesn't
      // execute here. Instead we persist a pending_tool_calls row;
      // the operator approves/rejects via /pending. The synthetic
      // tool_result tells the model the action is queued so it can
      // wrap up its turn coherently.
      if (tool.requiresConfirm) {
        const traceId = currentTrace()?.id ?? null;
        // Note: pendingToolCalls.args stores the UN-REDACTED input —
        // post-repair (the central validator's safe coercions applied),
        // never the redacted logging copy — because the approve path
        // needs real args to execute the tool later. Sensitive tools
        // that route through requires_confirm therefore expose their
        // args to /pending until they're approved or rejected. That's
        // an acceptable single-user tradeoff; if multi-tenant ever
        // happens, pendingToolCalls.args needs to be sealed too.
        const [pending] = await db
          .insert(pendingToolCalls)
          .values({
            ownerId: args.ownerId,
            agentId: args.agentId ?? null,
            toolSlug: slug,
            args: input,
            traceId,
          })
          .returning({ id: pendingToolCalls.id });
        const pendingId = pending?.id ?? null;
        if (pendingId) {
          p.pendingIds.push(pendingId);
          // Surface the approval wherever the operator is: live badge
          // + a one-tap Telegram card. Fire-and-forget — the row is
          // already persisted and /pending owns the truth.
          void notifyPendingCreated({
            ownerId: args.ownerId,
            pendingId,
            toolSlug: slug,
            args: input,
            via: args.agentSlug ? `agent ${args.agentSlug}` : undefined,
          });
        }
        handle.setSkipped('requires_confirm');
        handle.setMeta({ pendingId, requiresConfirm: true });
        return {
          ok: true as const,
          output: {
            status: 'queued_for_approval',
            pending_id: pendingId,
            message:
              `The tool '${slug}' requires operator approval. ` +
              `A pending entry was queued at /pending. Tell the user what's queued ` +
              `and that it'll run once approved. Do not call the same tool again ` +
              `in this turn.`,
          },
        };
      }
      const result = await dispatchTool(tool, input, {
        ownerId: args.ownerId,
        step: {
          setMeta: (m) => handle.setMeta(m),
          setOutput: (o) => handle.setOutput(o),
          // Let a tool that calls an LLM (e.g. web_search → Sonar)
          // attribute its spend to this step → the active trace.
          addTokens: (d) => handle.addTokens(d),
          addCost: (mu) => handle.addCost(mu),
        },
        // Populated only when the caller passed agent context.
        // The `invoke_agent` builtin requires it; regular tools
        // ignore it.
        ...(args.agentSlug
          ? {
              agent: {
                slug: args.agentSlug,
                depth: args.agentDepth ?? 1,
                delegateTo: args.delegateTo ?? [],
                parentTraceId: args.parentTraceId ?? null,
                // Forward the parent's resolved (pre-clamp) budget so a
                // delegated specialist inherits the per-user thinking pref.
                ...(args.thinkingBudget ? { thinkingBudget: args.thinkingBudget } : {}),
                ...(p.lastUserMessage ? { lastUserMessage: p.lastUserMessage } : {}),
              },
            }
          : {}),
        // Per-turn surface (Telegram chat id, /assistant, …) so
        // worker-delegation tools know where to send results.
        // Absent for background callers (reflector/extractor) —
        // synthesize_speech & friends refuse cleanly when missing.
        ...(args.surface ? { surface: args.surface } : {}),
      });
      // Surface a tool's structured failure onto the step so /traces shows
      // it as an error, not a 'success' with empty output. (A mis-calling
      // model — e.g. Grok page_share with a bogus id — otherwise looks like
      // it succeeded N times.)
      if (!result.ok) handle.setError(result.error);
      return result;
    },
  );
}

/**
 * The tool message content for one outcome. Errors are sent as JSON too — the
 * model usually adapts (retries with different args, falls back to a plain
 * answer) rather than blowing up. Oversized OK results are not truncated
 * (which silently dropped content): they spill to the tool-result store and
 * the model receives a handle envelope it can page/grep/query via
 * `read_result`. Also does the guards' outcome accounting (identical failures
 * escalate; identical results count toward no-progress).
 */
export async function toolResultPayload(p: {
  outcome: ToolHandlerResult;
  slug: string;
  guardSig: string;
  guards: TurnGuards;
  ownerId: string;
  handling: { inlineMaxBytes: number } & Parameters<
    typeof processToolResultForModel
  >[0]['handling'];
}): Promise<string> {
  const { outcome, slug, guardSig, guards, ownerId, handling } = p;
  if (!outcome.ok) {
    // Failure-aware guard accounting: identical failing calls escalate —
    // the payload teaches from the 2nd failure, the guard blocks
    // at the limit. Keyed by the same canonical signature the guard
    // checks, so encoding drift can't reset the count.
    const failures = guards.recordFailure(guardSig);
    // Error strings can embed EXTERNAL content (an HTTP body excerpt, a
    // recipe step's inner error) and bypass the success-path fence below
    // — sanitize centrally so no handler has to remember to.
    return JSON.stringify({
      error: sanitizeToolError(outcome.error),
      ...(failures >= 2
        ? {
            loop_guard:
              `This exact call has now failed ${failures} times this turn with the same ` +
              `arguments. Change the arguments or the approach — after ` +
              `${REPEATED_FAILURE_LIMIT} identical failures further attempts are blocked.`,
          }
        : {}),
    });
  }
  let serialized = JSON.stringify(outcome.output);
  guards.recordResult(guardSig, serialized);
  // Fence untrusted external content BEFORE the inline/spill decision so
  // the boundary travels both paths: inline results carry it directly,
  // and spilled results are stored fenced — so read_result page/grep/
  // query return fenced content too, never a clean instruction.
  if (UNTRUSTED_CONTENT_TOOL_SLUGS.has(slug) || outcome.untrusted === true) {
    serialized = fenceRetrieved(serialized);
  }
  if (Buffer.byteLength(serialized, 'utf8') <= handling.inlineMaxBytes) return serialized;
  return step(
    {
      name: `spill_result: ${slug}`,
      kind: 'compute',
      input: { bytes: Buffer.byteLength(serialized, 'utf8') },
    },
    async (h) => {
      const processed = await processToolResultForModel({
        serialized,
        ownerId,
        traceId: currentTrace()?.id ?? null,
        toolSlug: slug,
        handling,
      });
      h.setMeta({
        spilled: processed.spilled,
        handle: processed.handle,
        bytes: processed.bytes,
      });
      return processed.payload;
    },
  );
}
