/**
 * One-way bridge that lets the `invoke_agent` builtin (defined here in
 * `@mantle/tools`) call back into `@mantle/agent-runtime` without
 * creating an import cycle.
 *
 * The runtime already depends on tools (for dispatch); tools must not
 * depend on the runtime in return. So we declare the surface here and
 * let the runtime register an implementation at boot:
 *
 *   // apps/agent/src/main.ts
 *   import { registerAgentInvoker } from '@mantle/tools';
 *   import { invokeAgent } from '@mantle/agent-runtime';
 *   registerAgentInvoker(invokeAgent);
 *
 * Until that registration happens, `invoke_agent` returns a clear error
 * rather than crashing — useful for dev sessions where you haven't
 * wired the bridge in yet.
 */

/** Pure-data inputs to a child agent invocation. */
export type InvokeAgentInput = {
  /** Owner whose tree the child agent runs against. Always matches the parent. */
  ownerId: string;
  /** Slug of the target agent. The runtime resolves this from the `agents` table. */
  agentSlug: string;
  /** User-role text the child agent processes. The parent's full
   *  conversation history is NOT forwarded — by design, delegation is
   *  a fresh one-shot request, not a continuation. */
  prompt: string;
  /** Depth this child will run at (parent's depth + 1). The dispatcher
   *  has already enforced the depth caps (MAX_AGENT_DEPTH, and the
   *  terminal-edge exception up to MAX_TERMINAL_EDGE_DEPTH); the runtime
   *  re-checks them as defence in depth. */
  depth: number;
  /** Parent trace id, so the child trace can store it in `data` for
   *  navigation. Null when the parent isn't traced (manual scripts). */
  parentTraceId: string | null;
  /** Parent turn's resolved (pre-clamp) thinking budget, so the specialist
   *  inherits the operator's per-user thinking preference. The child runtime
   *  re-clamps it against its OWN max_tokens. Omitted/0 ⇒ no thinking. */
  thinkingBudget?: number;
};

export type InvokeAgentResult =
  | {
      ok: true;
      /** Final assistant text from the child. */
      text: string;
      /** Child's full cost in micro-USD, for the parent step's meta.
       *  The CHILD trace already records this; we surface it here so
       *  the parent's `invoke_agent` step shows it too — without
       *  rolling into the parent's own `traces.cost_micro_usd`
       *  (which would double-count in aggregates). */
      costMicroUsd: number;
      tokensIn: number;
      tokensOut: number;
      /** Id of the child trace, for /traces UI navigation. */
      childTraceId: string | null;
    }
  | { ok: false; error: string };

export type AgentInvoker = (input: InvokeAgentInput) => Promise<InvokeAgentResult>;

let registered: AgentInvoker | null = null;

/**
 * Register the runtime-side implementation. Called once at process
 * boot from the apps that own a runToolLoop. Idempotent — last write
 * wins, which is fine for the single-process model.
 */
export function registerAgentInvoker(fn: AgentInvoker): void {
  registered = fn;
}

/**
 * Read the registered implementation. Throws if the process hasn't
 * registered one — the `invoke_agent` builtin catches this and turns
 * it into a structured tool error rather than a 500.
 */
export function getAgentInvoker(): AgentInvoker | null {
  return registered;
}
