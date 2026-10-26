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
import { policySpendsOwnerKey, type ToolPolicy } from './tool-policy';

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
 * Terminality = "cannot successfully delegate". Missing, non-array, or empty
 * `delegate_to` all qualify: `checkDelegationAllowed` fails closed on exactly
 * the same shapes when the agent itself tries to delegate, so an agent this
 * predicate calls terminal can never extend a chain. Shared by the dispatch
 * guard (invoke_agent builtin) and the runtime invoker's re-check — ONE
 * definition so the two gates cannot drift.
 */
export function isTerminalDelegateConfig(delegateTo: unknown): boolean {
  return !Array.isArray(delegateTo) || delegateTo.length === 0;
}

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
 * The specialists a WORKSPACE turn may delegate to (owner decision
 * 2026-10-26): Draftsman, Presenter and Appsmith. A workspace turn is a turn
 * whose scope does not hold the Admin workspace, or that is not on an owner
 * surface (a team surface, a missing one): the assistant of any workspace
 * other than Admin, the shipped Team responder, and a delegated child of
 * either. Such a turn delegates only to a slug in BOTH this list and its
 * agent's `delegate_to`, and the child runs in the parent's scope with the
 * parent's surface: the login's own rights in that one workspace, never
 * Admin's. Each one writes a workspace content kind (a page or diagram, a
 * canvas, an app) where the login may, so its agents may too, never more.
 * The system manifest re-exports and pins it (WORKSPACE_DELEGATE_SLUGS).
 */
export const WORKSPACE_DELEGATE_SLUGS: readonly string[] = Object.freeze([
  'diagrammer',
  'presenter',
  'appsmith',
]);

/** What the delegation gateway knows of the turn a delegation starts in. */
export type DelegationTurn = {
  /** A workspace turn (see WORKSPACE_DELEGATE_SLUGS). */
  workspaceTurn: boolean;
  /** The login the turn answers: its scope's. A workspace turn that answers
   *  none (a workspace assistant's heartbeat, a run planned with no login)
   *  delegates nothing. */
  loginId: string | null;
};

/** The refusal of a workspace turn's delegation to a slug off the list. */
export const WORKSPACE_DELEGATE_ERROR = (slug: string): string =>
  `'${slug}' cannot be delegated to from a workspace: a workspace's assistant (and the ` +
  `specialists it hands work to) delegates only to Draftsman (diagrammer), Presenter ` +
  `(presenter) and Appsmith (appsmith). Do the work yourself, or tell the user it needs ` +
  `the Admin assistant.`;

/** The refusal of a workspace turn that answers no login. */
export const WORKSPACE_NO_LOGIN_DELEGATE_ERROR =
  'this workspace turn answers no user, so it delegates nothing: a specialist works with ' +
  'the rights of the user who asked, and there is none here.';

/**
 * The delegates a turn may name: the agent's own allowlist, cut to
 * WORKSPACE_DELEGATE_SLUGS in a workspace turn (in the allowlist's order).
 * What the model is shown (the invoke_agent enum and roster, the decider's
 * delegation hint) is this list; checkDelegationAllowed enforces the same
 * rule at the call, whatever a caller showed.
 */
export function turnDelegates(
  allowlist: readonly string[] | null | undefined,
  turn: Pick<DelegationTurn, 'workspaceTurn'>,
): string[] {
  const list = Array.isArray(allowlist) ? allowlist.filter((s) => typeof s === 'string') : [];
  return turn.workspaceTurn ? list.filter((s) => WORKSPACE_DELEGATE_SLUGS.includes(s)) : list;
}

/**
 * The workspace half of the gateway: in a workspace turn, a target off
 * WORKSPACE_DELEGATE_SLUGS, or a turn that answers no login, is refused.
 * checkDelegationAllowed asks it; the runtime invoker asks it again before
 * the child starts (it does not know the parent's allowlist), as it
 * re-checks the depth.
 */
export function checkWorkspaceDelegate(
  targetSlug: string,
  turn: DelegationTurn,
): AllowlistCheckResult {
  if (!turn.workspaceTurn) return { ok: true };
  if (!WORKSPACE_DELEGATE_SLUGS.includes(targetSlug)) {
    return { ok: false, reason: WORKSPACE_DELEGATE_ERROR(targetSlug) };
  }
  if (!turn.loginId) return { ok: false, reason: WORKSPACE_NO_LOGIN_DELEGATE_ERROR };
  return { ok: true };
}

// ── A workspace turn's bounds ────────────────────────────────────────────────

/**
 * Why a workspace turn's delegated child is not given a tool, or null when it
 * is. The child runs with the user's own rights, so it gets nothing the
 * user's own MCP connection outside Admin would not:
 *
 *  - `owner-key`: a tool that spends on the brain owner's provider keys
 *    (policySpendsOwnerKey, the gate's spending narrower's one rule: web
 *    search, circuit verify, image generation, a further delegation);
 *  - `egress`: a tool that reaches outside the brain (`outside.egress`:
 *    web fetch, mail, Telegram, a linked brain's call);
 *  - `delete`: a tool that deletes an item (its policy's `deletesItem`: an
 *    app, a file, a canvas, a page), so a delete stays a deliberate step of
 *    the user's own, as it is for the pages and canvases the specialists'
 *    groups leave out.
 *
 * Read off the builtin's policy; a tool with none (a connector, an outside
 * tool) is the gate's to judge in the child's scope, as on the user's MCP.
 * The runtime invoker drops these from the child's tool list (a call to one
 * is then refused by the loop: not in its allowlist).
 */
export type WorkspaceChildDrop = 'owner-key' | 'egress' | 'delete';

export function workspaceChildDrop(
  policy: ToolPolicy | null | undefined,
): WorkspaceChildDrop | null {
  if (!policy) return null;
  if (policySpendsOwnerKey(policy)) return 'owner-key';
  if (policy.outside?.egress === true) return 'egress';
  if (policy.deletesItem === true) return 'delete';
  return null;
}

/** At most this many delegations succeed in one workspace turn; the next
 *  invoke_agent is refused. Two covers the common hand-offs (a diagram and
 *  a canvas, an app and its data look) and keeps one member message from
 *  fanning out into many child runs on the owner's keys. */
export const WORKSPACE_TURN_MAX_DELEGATIONS = 2;

/** A workspace turn's child runs at most this many tool-loop iterations,
 *  whatever its own memory_config.max_iterations (Admin's clamp is 30).
 *  Twenty leaves Appsmith's build loop (write, build, read the errors, fix)
 *  three or four rounds, and Draftsman's and Presenter's draw, look, fix
 *  loops room, while a stuck child stops well short of the Admin bound. */
export const WORKSPACE_CHILD_MAX_ITERATIONS = 20;

/** The Admin turn's ceiling on a child's memory_config.max_iterations. */
export const CHILD_MAX_ITERATIONS = 30;

/** A workspace turn delegates only while its user has at least this many
 *  of the daily token budget left (MANTLE_MEMBER_DAILY_TOKENS, the member
 *  turn ledger): about one specialist run. Below it the specialist would
 *  likely pass the budget mid-run, which the ledger sees only at the
 *  turn's close. */
export const WORKSPACE_DELEGATION_TOKEN_FLOOR = 200_000;

/** The child's loop ceiling: its own memory_config.max_iterations (when
 *  set and positive) clamped to CHILD_MAX_ITERATIONS, and in a workspace
 *  turn to WORKSPACE_CHILD_MAX_ITERATIONS too; undefined keeps the loop's
 *  default (which is below both). */
export function childMaxIterations(
  requested: unknown,
  turn: Pick<DelegationTurn, 'workspaceTurn'>,
): number | undefined {
  const own =
    typeof requested === 'number' && Number.isFinite(requested) && requested > 0
      ? Math.min(CHILD_MAX_ITERATIONS, Math.floor(requested))
      : undefined;
  if (own === undefined || !turn.workspaceTurn) return own;
  return Math.min(own, WORKSPACE_CHILD_MAX_ITERATIONS);
}

/** The refusal of a workspace turn's delegation past the per-turn count. */
export const WORKSPACE_DELEGATION_COUNT_ERROR =
  `this turn has already handed work to a specialist ${WORKSPACE_TURN_MAX_DELEGATIONS} times, ` +
  `the most a workspace turn may: finish with what you have, and tell the user to ask again ` +
  `in a new message for the rest.`;

/** The refusal of a workspace turn that names no turn to count on. */
export const WORKSPACE_DELEGATION_NO_TURN_ERROR =
  'this delegation names no turn to count it on, so a workspace turn refuses it: do the work ' +
  'yourself.';

/** The refusal of a workspace turn whose user is near the daily budget. */
export const WORKSPACE_DELEGATION_BUDGET_ERROR =
  `the user has less than ${WORKSPACE_DELEGATION_TOKEN_FLOOR} of today's chat tokens left, ` +
  `too few for a specialist: do the work yourself in a short form, or tell the user it can be ` +
  `done tomorrow or by an admin.`;

/** Each workspace turn's delegations in flight or done, by the turn's own
 *  object (the turn's taint, one per turn and shared with its children). */
const turnDelegations = new WeakMap<object, number>();

/**
 * Take one of a workspace turn's delegations (WORKSPACE_TURN_MAX_DELEGATIONS)
 * before the child starts; `releaseWorkspaceDelegation` gives it back when
 * the child fails, so only successful ones count. Taken before the child
 * runs, so calls made at once cannot pass the count together. `turnKey` is
 * the turn's own object; none: refused (fail closed).
 */
export function claimWorkspaceDelegation(turnKey: object | undefined): AllowlistCheckResult {
  if (!turnKey) return { ok: false, reason: WORKSPACE_DELEGATION_NO_TURN_ERROR };
  const n = turnDelegations.get(turnKey) ?? 0;
  if (n >= WORKSPACE_TURN_MAX_DELEGATIONS) {
    return { ok: false, reason: WORKSPACE_DELEGATION_COUNT_ERROR };
  }
  turnDelegations.set(turnKey, n + 1);
  return { ok: true };
}

/** Give back a delegation claimWorkspaceDelegation took (its child failed). */
export function releaseWorkspaceDelegation(turnKey: object | undefined): void {
  if (!turnKey) return;
  const n = turnDelegations.get(turnKey) ?? 0;
  if (n > 0) turnDelegations.set(turnKey, n - 1);
}

/** Whether a workspace turn's user has enough of the daily budget left for
 *  a delegation: `left` null is no budget (an Admin user, or the budget
 *  off). */
export function checkWorkspaceDelegationBudget(left: number | null): AllowlistCheckResult {
  if (left === null) return { ok: true };
  return left >= WORKSPACE_DELEGATION_TOKEN_FLOOR
    ? { ok: true }
    : { ok: false, reason: WORKSPACE_DELEGATION_BUDGET_ERROR };
}

/**
 * Verify the parent agent is permitted to delegate to `targetSlug`: the
 * delegation gateway (invoke_agent's handler and the runtime invoker both
 * ask it).
 *
 * Permission lives on the parent agent's `memory_config.delegate_to`
 * — a list of agent slugs. Missing / empty list = no delegation
 * allowed (fail closed). Self-delegation is always refused even when
 * the slug is in the list. In a workspace turn (`turn`, delegationTurnOf),
 * the target must also be in WORKSPACE_DELEGATE_SLUGS, and the turn must
 * answer a login. `turn` is required: every caller says which turn it is,
 * so no caller gets the Admin turn's rule (the allowlist alone) by leaving
 * it out.
 */
export function checkDelegationAllowed(
  parentAgentSlug: string,
  targetSlug: string,
  allowlist: readonly string[] | null | undefined,
  turn: DelegationTurn,
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
  const ws = checkWorkspaceDelegate(targetSlug, turn);
  if (!ws.ok) return ws;
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
