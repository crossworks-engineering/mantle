/**
 * Pure guard checks for the `invoke_agent` builtin. Pulled into their
 * own module so vitest can lock down the safety properties without
 * touching the DB, the bridge, or `runToolLoop`.
 *
 * Three guarantees we MUST preserve:
 *   1. Bounded depth — no infinite agent recursion.
 *   2. Explicit allowlist — an agent can't delegate to an agent the
 *      operator didn't authorise.
 *   3. No self-call — an agent never invokes itself (zero-cost cycle).
 */

/** Maximum agent-chain length, inclusive of the entry-point agent.
 *  2 means "parent + child only". Bump deliberately if you ever want
 *  3-deep chains; every level above 2 is a stronger argument for a
 *  pipeline of pg_notify reactions instead of a delegation chain. */
export const MAX_AGENT_DEPTH = 2;

/** The ONE sanctioned exception to MAX_AGENT_DEPTH: a child agent may go a
 *  single level deeper when its target is a TERMINAL specialist — an agent
 *  with no delegates of its own, so the chain provably ends there (a depth-3
 *  child could only ever reach depth 4 via a terminal target, which this cap
 *  refuses). Motivating case: chat-initiated app builds — responder →
 *  appsmith → toolsmith — which otherwise ping-pong the "needs a data tool"
 *  requirement back through the responder (observed on a client brain,
 *  2026-07-20). The edge still has to be DECLARED: `checkDelegationAllowed`
 *  runs first, so only operator-authorised pairs ever reach this exception. */
export const MAX_TERMINAL_EDGE_DEPTH = 3;

export type DepthCheckResult = { ok: true; childDepth: number } | { ok: false; reason: string };

/**
 * Returns the depth the child WOULD run at, or refuses if it'd exceed the
 * cap. Caller passes the parent's current depth (entry-point agents are
 * depth 1) and, when known, whether the TARGET is a terminal specialist
 * (empty `delegate_to`) — that unlocks the one-level MAX_TERMINAL_EDGE_DEPTH
 * exception. Omitting the flag fails closed to the plain MAX_AGENT_DEPTH cap.
 */
export function checkAgentDepth(
  parentDepth: number,
  opts?: { targetIsTerminal?: boolean },
): DepthCheckResult {
  if (!Number.isInteger(parentDepth) || parentDepth < 1) {
    return { ok: false, reason: `invalid parent depth ${parentDepth}` };
  }
  const childDepth = parentDepth + 1;
  if (childDepth <= MAX_AGENT_DEPTH) return { ok: true, childDepth };
  if (childDepth === MAX_TERMINAL_EDGE_DEPTH && opts?.targetIsTerminal === true) {
    return { ok: true, childDepth };
  }
  return {
    ok: false,
    reason:
      `agent delegation depth limit (${MAX_AGENT_DEPTH}) exceeded — ` +
      `a child agent may delegate one level deeper ONLY to a terminal specialist ` +
      `(an agent with no delegates of its own); otherwise state what you need in ` +
      `your final answer so your parent can arrange it`,
  };
}

export type AllowlistCheckResult = { ok: true } | { ok: false; reason: string };

/**
 * Verify the parent agent is permitted to delegate to `targetSlug`.
 *
 * Permission lives on the parent agent's `memory_config.delegate_to`
 * — a list of agent slugs. Missing / empty list = no delegation
 * allowed (fail closed). Self-delegation is always refused even when
 * the slug is in the list.
 */
export function checkDelegationAllowed(
  parentAgentSlug: string,
  targetSlug: string,
  allowlist: readonly string[] | null | undefined,
): AllowlistCheckResult {
  if (!targetSlug || typeof targetSlug !== 'string') {
    return { ok: false, reason: 'agent_slug is required' };
  }
  if (targetSlug === parentAgentSlug) {
    return {
      ok: false,
      reason:
        `an agent cannot invoke itself ('${parentAgentSlug}') — do this work directly ` +
        `in your own turn, or delegate to a DIFFERENT specialist from your allowlist`,
    };
  }
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return {
      ok: false,
      reason:
        `delegation not configured — add '${targetSlug}' to the parent agent's ` +
        `memory_config.delegate_to to enable`,
    };
  }
  if (!allowlist.includes(targetSlug)) {
    // Help the LLM self-correct WITHOUT dumping the whole roster (see the
    // "does not leak the full allowlist" test): suggest only the single
    // closest entry, and only when it's a confident near-match (the slug the
    // model almost typed — e.g. 'pages-specialist' → 'pages'). An unrelated
    // miss gets no suggestion, so the authorised list stays unrevealed.
    const suggestion = closestSlug(targetSlug, allowlist);
    return {
      ok: false,
      reason:
        `target agent '${targetSlug}' is not in the parent's delegation allowlist` +
        (suggestion ? `. Did you mean '${suggestion}'?` : ''),
    };
  }
  return { ok: true };
}

/**
 * Pick the allowlist entry the caller most likely intended, or null when
 * nothing is a confident match. Deliberately conservative: it returns at
 * most ONE slug, and only on a strong signal — a containment match (one is a
 * substring of the other, e.g. 'pages' ⊂ 'pages-specialist') or a small edit
 * distance (typos). This lets an LLM recover from a near-miss without turning
 * the refusal into a directory listing of every authorised agent.
 */
function closestSlug(target: string, allowlist: readonly string[]): string | null {
  const t = target.toLowerCase();

  // Strong signal: containment in either direction. Prefer the longest such
  // entry (most specific overlap).
  const contained = allowlist
    .filter((s) => {
      const x = s.toLowerCase();
      return x.includes(t) || t.includes(x);
    })
    .sort((a, b) => b.length - a.length);
  const top = contained[0];
  if (top) return top;

  // Otherwise: closest by edit distance, accepted only when it's small
  // relative to the slug length (so 'resercher' → 'researcher' suggests, but
  // 'rogue' → 'researcher' does not).
  let best: string | null = null;
  let bestDist = Infinity;
  for (const s of allowlist) {
    const d = levenshtein(t, s.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  const threshold = Math.max(2, Math.floor(t.length / 3));
  return best !== null && bestDist <= threshold ? best : null;
}

/** Iterative Levenshtein edit distance — small, dependency-free, two-row. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}
