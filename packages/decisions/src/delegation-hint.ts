/**
 * Delegation hint — use `delegation_hint`. Before a responder turn, one
 * decision call picks which of the agent's delegates (or `none`) should take
 * the message. The answer is a HINT: in `live` mode one line lands in the
 * volatile system context and the responder still chooses; the delegation
 * allowlist stays code-enforced in the tool loop. Jev never routes.
 *
 * Spike (NATREF, 2026-09-22, 83 real turns, dev-brain page 4bf1f284): with
 * "hint only at confidence ≥ 0.6 and never hint `none`", 36 hints, 31 right,
 * 4 wrong (2 arguable) — 86% precision, 296 ms, ~$0.00004 per turn. Jev says
 * `none` on half the turns the responder answered itself; the chat baseline
 * delegated 29 of 30 of those. Weak spots and their fixes are in the criteria
 * below (`remy` = conversation replay only; `none` covers short instructions
 * about what the user has open).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { agents, db } from '@mantle/db';
import type { DecisionQuestion } from '@mantle/voice';
import { decide, type DecideOutcome } from './decide';

/** Below this many words the message is a follow-up that only makes sense
 *  inside the conversation ("yes, but shorter") — no call. */
export const MIN_WORDS_FOR_HINT = 8;

/** Cap on the message text sent as state. The head carries the ask. */
const MAX_MESSAGE_CHARS = 3_000;
const MAX_PREVIOUS_CHARS = 600;

export type Delegate = { slug: string; description: string | null };

export type DelegationHint = {
  /** A delegate slug, or 'none'. */
  pick: string;
  confidence: number;
  probabilities: Record<string, number>;
  mode: 'shadow' | 'live';
  /** The worker's floor: below it the hint is recorded, not shown. */
  deferBelow: number;
  cached: boolean;
  ms: number;
};

/** Contrastive wording for the two options the spike showed Jev over- or
 *  under-picks. A delegate's own description is used for everything else. */
const NONE_CRITERION =
  'No specialist. The assistant answers itself: a general question, an explanation, a summary of what it already holds, a short reply in an ongoing conversation, or a small edit to what the user has open that its own tools can do.';
const REMY_CRITERION =
  'Replay of PAST CONVERSATIONS only ("what did we discuss on…", "what did X say last week"). Not for looking something up in a document or page — the assistant does that itself.';

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** The roster the hint chooses from: the agent's `delegate_to` slugs with
 *  their descriptions, enabled rows only, in allowlist order. */
export async function loadDelegates(
  ownerId: string,
  slugs: readonly string[],
): Promise<Delegate[]> {
  if (slugs.length === 0) return [];
  const rows = await db
    .select({ slug: agents.slug, description: agents.description })
    .from(agents)
    .where(
      and(eq(agents.ownerId, ownerId), eq(agents.enabled, true), inArray(agents.slug, [...slugs])),
    );
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  return slugs.map((s) => bySlug.get(s)).filter((r): r is Delegate => !!r);
}

/** Pure: the criteria map for the choice question. */
export function delegationCriteria(delegates: readonly Delegate[]): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const d of delegates) {
    criteria[d.slug] =
      d.slug === 'remy' ? REMY_CRITERION : d.description?.trim() || `The '${d.slug}' specialist.`;
  }
  criteria.none = NONE_CRITERION;
  return criteria;
}

/**
 * Ask the decider which delegate should take `message`. Null when the use is
 * off, the message is too short, there are no delegates, or the call failed.
 */
export async function suggestDelegate(args: {
  ownerId: string;
  message: string;
  previousUserMessage?: string | null;
  delegates: readonly Delegate[];
}): Promise<DelegationHint | null> {
  const { ownerId, delegates } = args;
  const message = args.message.trim();
  if (delegates.length === 0 || wordCount(message) < MIN_WORDS_FOR_HINT) return null;

  const state: Record<string, unknown> = { message: message.slice(0, MAX_MESSAGE_CHARS) };
  const prev = args.previousUserMessage?.trim();
  if (prev) state.previous_user_message = prev.slice(0, MAX_PREVIOUS_CHARS);

  const questions: Record<string, DecisionQuestion> = {
    agent: {
      type: 'choice',
      instructions:
        'A personal-assistant AI received `message` (with `previous_user_message` as context when present). Which specialist should handle it, or `none` if the assistant should answer it itself?',
      criteria: delegationCriteria(delegates),
    },
  };
  const outcome: DecideOutcome | null = await decide({
    ownerId,
    use: 'delegation_hint',
    state,
    questions,
  });
  if (!outcome) return null;
  const a = outcome.answers.agent;
  if (!a || a.type !== 'choice') return null;
  return {
    pick: a.choice,
    confidence: a.confidence,
    probabilities: a.probabilities,
    mode: outcome.mode,
    deferBelow: outcome.use.deferBelow,
    cached: outcome.cached,
    ms: outcome.ms,
  };
}

/**
 * Pure: the one line for the volatile system context, or null when nothing
 * should be shown — shadow mode, `none`, or under the floor. The wording
 * keeps the responder in charge.
 */
export function delegationHintLine(hint: DelegationHint | null): string | null {
  if (!hint || hint.mode !== 'live') return null;
  if (hint.pick === 'none' || hint.confidence < hint.deferBelow) return null;
  const pct = Math.round(hint.confidence * 100);
  return `Delegation hint: this message looks like work for \`${hint.pick}\` (confidence ${pct}%). Use your own judgment; delegate with invoke_agent only if you agree.`;
}
