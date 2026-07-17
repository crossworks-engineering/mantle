/**
 * Shared responder-turn ASSEMBLY — the prompt/tool/budget preparation every
 * conversational surface (web /assistant, Telegram, Team Chat) runs before its
 * tool loop. Extracted from the three parallel copies (audit #5c) so a fix to
 * the drift-prone middle lands once:
 *
 *   - identity block (Journal-derived, memory_config.inject_journal-gated)
 *   - skills → system prompt (+ an optional surface suffix, e.g. Telegram's
 *     audio-tag instructions)
 *   - volatile context: time line + surface extras + open-heartbeat awareness
 *   - tool allowlist from granted tool GROUPS (P6) + the per-turn heartbeat
 *     continuity-tool affordance
 *   - per-user adaptive thinking budget
 *   - per-agent tool-loop overrides (max_iterations clamp + tool-volume caps)
 *   - delegation allowlist + result-handling config
 *
 * Surfaces keep their own I/O (persistence, delivery, tracing shape) — this is
 * deliberately assembly only. See run-team-turn.ts's header for why the
 * surfaces stay siblings.
 *
 * Also home to the shared image-routing pair (`decideImageRouting` +
 * `runWithImageFallback`): transcript-default vision gating and the
 * retry-without-the-image fallback the web path grew after Bedrock's opaque
 * "Could not process image" failures (the Telegram copy had missed both — the
 * b1/b2 parity drift this extraction resolves).
 */

import type { Agent } from '@mantle/db';
import {
  composeSystemPromptWithSkills,
  effectiveToolSlugs,
  resolveAgentSkills,
  resolveAgentToolGroups,
  resolveAgentTools,
  type SkillForRuntime,
} from '@mantle/agent-runtime';
import {
  buildIdentityContext,
  buildTimeContextLine,
  resolveThinkingBudget,
  type ProfilePreferences,
} from '@mantle/content';
import {
  buildOpenHeartbeatContext,
  HEARTBEAT_RESPONDER_TOOLS,
  hasActiveHeartbeatsOnSurface,
  openHeartbeatsForSurface,
} from '@mantle/heartbeats';
import { maxImageBytesFor, modelSupportsVision, refreshModelCatalog } from '@mantle/tracing';

/** Where a turn's open-heartbeat awareness is scoped. Mirrors the surface
 *  union `openHeartbeatsForSurface` takes (Team Chat has no heartbeats, so
 *  team turns simply omit it). */
export type HeartbeatSurface = { kind: 'telegram'; chatId: string } | { kind: 'web' };

/** Per-agent tool-loop overrides from memory_config, pre-clamped where the
 *  runtime owns the clamp. Spread straight into `runToolLoop(...)`. */
export type ResponderLoopOverrides = {
  maxIterations?: number;
  maxToolCallsPerTurn?: number;
  maxCallsPerToolPerTurn?: number;
};

export type AssembleResponderTurnOptions = {
  ownerId: string;
  agent: Agent;
  /** Pre-loaded profile preferences. Loaded by the caller because the web
   *  path may have just auto-switched the timezone (applyAutoTimezone) and
   *  the time line below must reflect the updated prefs. */
  prefs: ProfilePreferences;
  /** Log prefix for the best-effort skip warnings ('[assistant]', '[agent]',
   *  '[team-turn]') so operator logs keep their per-surface identity. */
  logPrefix: string;
  /** Inject the Journal-derived identity block (still gated per-agent by
   *  memory_config.inject_journal). Team turns pass false — owner-personal
   *  context must never reach an external member (hard isolation). */
  includeIdentity?: boolean;
  /** Appended verbatim after the skills prompt inside the CACHED prefix —
   *  stable-per-turn surface decoration (Telegram's audio-tag instructions).
   *  Anything that churns per turn belongs in `volatileExtras` instead. */
  systemPromptSuffix?: string;
  /** Extra volatile lines between the time line and the heartbeat block
   *  (web: device location + timezone-switch note; team: the member-identity
   *  line). Falsy entries are dropped. */
  volatileExtras?: Array<string | null | undefined>;
  /** Where open heartbeats are checked for the awareness block + the
   *  continuity-tool affordance. Omit to skip heartbeats entirely (team). */
  heartbeatSurface?: HeartbeatSurface;
  /** Resolve the per-user adaptive thinking budget (web + Telegram). Team
   *  turns pass false — no owner thinking budget for an external member. */
  withThinking?: boolean;
  /** Honour memory_config.delegate_to. Team turns pass false — the team
   *  responder never delegates (fail closed). */
  allowDelegation?: boolean;
  /** Slugs removed AFTER group resolution — the team private-reads gate.
   *  Enforced here at tool resolution so a manifest change that re-adds the
   *  slugs to a group can't bypass the switch. */
  excludeToolSlugs?: readonly string[];
};

export type AssembledResponderTurn = {
  attachedSkills: SkillForRuntime[];
  /** Cached prefix (breakpoint 1): identity + persona + skills + suffix —
   *  stable across turns. */
  effectiveSystemPrompt: string;
  /** Uncached volatile slot: time line + surface extras + heartbeat block. */
  volatileContext: string;
  /** Slugs of open (expecting-reply) heartbeats that influenced this turn —
   *  callers thread this into their trace so /traces can pivot on "influenced
   *  by heartbeat X" (audit P-trace-5). Empty when none / no surface. */
  relatedHeartbeatSlugs: string[];
  allowedTools: Awaited<ReturnType<typeof resolveAgentTools>>;
  thinkingBudget: number | undefined;
  delegateTo: string[];
  resultHandling: NonNullable<Agent['memoryConfig']>['result_handling'] | null;
  loopOverrides: ResponderLoopOverrides;
};

/**
 * Assemble the shared middle of one responder turn. Pure preparation — no
 * trace, no persistence, no delivery; the caller owns those. Best-effort
 * context (identity, heartbeats) soft-fails with a warning, never sinks the
 * turn.
 */
export async function assembleResponderTurn(
  opts: AssembleResponderTurnOptions,
): Promise<AssembledResponderTurn> {
  const { ownerId, agent, prefs, logPrefix } = opts;
  const memoryConfig = (agent.memoryConfig ?? {}) as {
    inject_journal?: boolean;
    delegate_to?: string[];
    max_iterations?: number;
    max_tool_calls?: number;
    max_calls_per_tool?: number;
  };

  const attachedSkills = await resolveAgentSkills(ownerId, agent.skillSlugs ?? []);
  // One-line "current time + timezone + locale" so the agent can resolve
  // relative references like "tomorrow at 3pm" into a UTC ISO when calling
  // event_create. It carries a per-turn millisecond timestamp, so it MUST
  // ride in the uncached volatile block — prepending it to the system prompt
  // put it inside cache breakpoint 1 and made the persona prefix miss on
  // every turn (2026-06 chat-cost audit).
  const timeContextLine = buildTimeContextLine(prefs);
  const promptWithSkills = composeSystemPromptWithSkills(agent.systemPrompt, attachedSkills);

  // Open-heartbeat awareness: if the user has heartbeats on this surface that
  // are currently waiting on a reply (state.expecting_reply truthy), append a
  // small awareness block so the agent knows it's mid-conversation with one of
  // its own proactive tasks and should call heartbeat_update_state after
  // acting on the user's reply. Best-effort; a DB blip here shouldn't kill the
  // turn. (P0-3 in the v1 heartbeats audit.)
  let openHeartbeatBlock = '';
  let relatedHeartbeatSlugs: string[] = [];
  if (opts.heartbeatSurface) {
    try {
      const open = await openHeartbeatsForSurface(ownerId, opts.heartbeatSurface);
      relatedHeartbeatSlugs = open.map((o) => o.slug);
      const block = buildOpenHeartbeatContext(open);
      if (block) openHeartbeatBlock = `\n\n${block}`;
    } catch (err) {
      console.error(
        `${logPrefix} open-heartbeat context skipped:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Always-on identity context — the "who you are" block distilled from the
  // user's Journal (deterministic, no LLM; empty when there are none). Opt
  // out per-agent with memory_config.inject_journal=false. Prepended so it
  // reads as durable user-truth at the top of the (cached) system block.
  let identityBlock = '';
  if ((opts.includeIdentity ?? true) && memoryConfig.inject_journal !== false) {
    try {
      const block = await buildIdentityContext(ownerId);
      if (block) identityBlock = `${block}\n\n`;
    } catch (err) {
      console.error(
        `${logPrefix} identity context skipped:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Cached prefix (breakpoint 1): identity + persona + skills + suffix — all
  // stable across turns. The time line, per-turn surface extras, and the
  // heartbeat block ("asked Nmin ago" churns) go to the uncached volatile
  // slot instead.
  const effectiveSystemPrompt = identityBlock + promptWithSkills + (opts.systemPromptSuffix ?? '');
  const volatileContext = [
    timeContextLine,
    ...(opts.volatileExtras ?? []),
    openHeartbeatBlock.trim(),
  ]
    .filter(Boolean)
    .join('\n\n');

  // Resolve the agent's tool allowlist from its granted tool groups (P6:
  // groups are the sole grant). Empty result → tool-loop sends no `tools`.
  //
  // Heartbeat continuity tools (update_state / complete / snooze) are a
  // per-turn AFFORDANCE (P6), not a stored grant: inject them only when
  // there's an active heartbeat on this surface for the model to act on.
  // No runtime magic the rest of the time. See docs/heartbeats.md §4
  // "Permission model & runtime hygiene".
  const groupTools = await resolveAgentToolGroups(ownerId, agent.toolGroupSlugs ?? []);
  let allowedToolSlugs = effectiveToolSlugs(groupTools);
  if (opts.excludeToolSlugs?.length) {
    const gated = new Set(opts.excludeToolSlugs);
    allowedToolSlugs = allowedToolSlugs.filter((s) => !gated.has(s));
  }
  if (opts.heartbeatSurface) {
    const hasHeartbeats = await hasActiveHeartbeatsOnSurface(ownerId, opts.heartbeatSurface).catch(
      () => false,
    );
    if (hasHeartbeats) {
      allowedToolSlugs = [
        ...allowedToolSlugs,
        ...HEARTBEAT_RESPONDER_TOOLS.filter((s) => !allowedToolSlugs.includes(s)),
      ];
    }
  }
  const allowedTools = await resolveAgentTools(ownerId, allowedToolSlugs);

  // Honor the agent's per-turn iteration override for the TOP-LEVEL responder
  // turn (not just delegated children). A heavy gather-then-author task needs
  // more than the runtime default of 6 rounds or the loop force_finals
  // mid-read and never authors. Clamp matches invoke-agent: positive ints
  // only, hard-capped at 30. The tool-volume overrides (max_tool_calls /
  // max_calls_per_tool) travel raw — runToolLoop validates + clamps them.
  const requested = memoryConfig.max_iterations;
  const loopOverrides: ResponderLoopOverrides = {
    ...(typeof requested === 'number' && requested > 0
      ? { maxIterations: Math.min(30, Math.floor(requested)) }
      : {}),
    ...(typeof memoryConfig.max_tool_calls === 'number'
      ? { maxToolCallsPerTurn: memoryConfig.max_tool_calls }
      : {}),
    ...(typeof memoryConfig.max_calls_per_tool === 'number'
      ? { maxCallsPerToolPerTurn: memoryConfig.max_calls_per_tool }
      : {}),
  };

  return {
    attachedSkills,
    effectiveSystemPrompt,
    volatileContext,
    relatedHeartbeatSlugs,
    allowedTools,
    // Per-user adaptive thinking: gated by the live-thinking switch AND a
    // positive budget. 0 ⇒ no thinking (runToolLoop treats 0/unset the same).
    thinkingBudget: (opts.withThinking ?? true) ? resolveThinkingBudget(prefs) : undefined,
    delegateTo: (opts.allowDelegation ?? true) ? (memoryConfig.delegate_to ?? []) : [],
    resultHandling: agent.memoryConfig?.result_handling ?? null,
    loopOverrides,
  };
}

/** Decoded byte size of a base64 string (tolerates a leading data-URL
 *  prefix). Used to size-check an inline image before sending it to a
 *  vision responder, without allocating a Buffer. */
export function base64Bytes(b64: string): number {
  const clean = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64;
  const len = clean.length;
  if (len === 0) return 0;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

/**
 * Transcript-default image routing — should the responder see the RAW pixels?
 *
 * The vision worker already described (and, when the user asked a question,
 * answered) the image at ingest, so prefer its cheap, cacheable transcript as
 * text. Only show the responder the raw image when there's NO usable
 * transcript (worker failed or unconfigured) — and only if the model is
 * vision-capable and the file is within that provider's per-image limit.
 * (Anthropic via OpenRouter → Bedrock rejects oversized images with an opaque
 * "Could not process image" the SDK masks as a validation error; the size
 * guard avoids it.)
 *
 * Also warms the live model catalog so the vision check reads authoritative
 * capability (architecture.input_modalities) rather than the heuristic.
 * Fire-and-forget + TTL-gated; the static fallback covers the cold path.
 */
export function decideImageRouting(opts: {
  model: string;
  /** An image attachment is present on this turn. */
  hasImage: boolean;
  /** Decoded image size in bytes (0 = none/unknown). */
  imageBytes: number;
  hasTranscript: boolean;
  logPrefix: string;
}): boolean {
  if (!opts.hasImage) return false;
  void refreshModelCatalog();
  if (opts.hasTranscript) return false;
  if (!modelSupportsVision(opts.model)) return false;
  const limit = maxImageBytesFor(opts.model);
  if (opts.imageBytes > 0 && opts.imageBytes <= limit) return true;
  console.warn(
    `${opts.logPrefix} no transcript and image ${opts.imageBytes}B exceeds ${opts.model} limit ` +
      `(${limit}B) — answering from the saved file node only`,
  );
  return false;
}

/**
 * Run the turn's loop, retrying once WITHOUT the image on failure. When a
 * raw image is attached and the responder errors — e.g. Bedrock's "Could not
 * process image" surfacing as the SDK's ResponseValidationError — retry
 * text-only, grounded in the vision-worker transcript instead, so a turn
 * never hard-fails on a picture. How the two attempts relate to traces is the
 * caller's choice: the web path wraps each thunk in its own trace (failed
 * attempt + fresh `image_retry_after_error` trace); Telegram runs both inside
 * its single whole-turn trace.
 */
export async function runWithImageFallback<T>(opts: {
  canSeeImage: boolean;
  logPrefix: string;
  withImage: () => Promise<T>;
  /** `retryAfterImageError` is true only on the post-failure fallback run. */
  textOnly: (retryAfterImageError: boolean) => Promise<T>;
}): Promise<T> {
  if (!opts.canSeeImage) return opts.textOnly(false);
  try {
    return await opts.withImage();
  } catch (err) {
    console.warn(
      `${opts.logPrefix} responder failed with image attached; retrying text-only:`,
      err instanceof Error ? err.message : err,
    );
    return opts.textOnly(true);
  }
}
