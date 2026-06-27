/**
 * Durable-step injection — the seam that lets a durable-execution engine (DBOS,
 * in apps/api) journal the work already marked by `step()` WITHOUT this package
 * depending on that engine.
 *
 * A caller (the apps/api workflow) wraps its work in `withDurableSteps(exec, …)`,
 * putting a durable executor into AsyncLocalStorage. `step()` (and any other
 * side-effecting boundary) runs its body through `runDurableStep`, which routes
 * to that executor when present so each call becomes a journaled step — on a
 * crash-resume the engine returns the recorded result instead of re-running it
 * (no re-fired tools, no duplicate rows).
 *
 * Three safety properties keep this inert and correct by default:
 *   1. No executor in context  → pure passthrough (identical behaviour). Every
 *      caller outside a workflow — the web request, apps/agent, scripts — is
 *      unaffected.
 *   2. ALS-scoped → concurrent workflows each carry their own executor; nothing
 *      is shared process-wide.
 *   3. Nesting guard → only the OUTERMOST durable step routes to the executor;
 *      nested ones pass through. Engines like DBOS forbid steps-within-steps, so
 *      e.g. an invoke_agent sub-loop journals as one step rather than throwing.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** Runs `fn` durably under `name`, returning its (journaled) result. */
export type DurableStepExecutor = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

const executorALS = new AsyncLocalStorage<DurableStepExecutor>();
const inStepALS = new AsyncLocalStorage<true>();

/** Run `body` with a durable executor active for the current async context.
 *  The apps/api workflow uses this to make the turn's steps durable. */
export function withDurableSteps<T>(exec: DurableStepExecutor, body: () => Promise<T>): Promise<T> {
  return executorALS.run(exec, body);
}

/** Route `fn` through the active durable executor (top-level only); otherwise
 *  run it directly. Result must be serializable when an executor is active (the
 *  engine journals it). */
export function runDurableStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const exec = executorALS.getStore();
  if (!exec || inStepALS.getStore()) return fn();
  return exec(name, () => inStepALS.run(true, fn));
}

/** True when a durable executor is active in the current context (a workflow is
 *  running). Lets callers skip non-replay-safe work outside the durable path. */
export function durableStepsActive(): boolean {
  return executorALS.getStore() !== undefined;
}
