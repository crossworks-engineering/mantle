/**
 * The one way a DBOS workflow registers (workspaces arch A2a). The API boot
 * binds no actor, so the DBOS dispatch loop carries none: each workflow names
 * its own here, at its entry, and runs inside it. A workflow registered
 * without this has no actor, and its statements show as misses
 * (docs/process-inventory.md; eslint-rules/process-entries.test.ts pins that
 * every workflow file uses it).
 */
import { DBOS } from '@dbos-inc/dbos-sdk';
import { runAsActor, systemActor, type Actor } from '@mantle/db';

/**
 * Register `impl` as the DBOS workflow `name`. Each run first asks
 * `actorOf` (with the run's own arguments) who it runs as, then runs `impl`
 * as that actor. `actorOf` runs with no actor bound: a lookup it makes binds
 * its own (loginActorNow does). The name, the arguments and the result are
 * the workflow's own, so a journaled run recovers as before.
 */
export function registerActorWorkflow<Args extends unknown[], R>(
  name: string,
  actorOf: (...args: NoInfer<Args>) => Actor | Promise<Actor>,
  impl: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  async function asActor(...args: Args): Promise<R> {
    const actor = await actorOf(...args);
    return runAsActor(actor, () => impl(...args));
  }
  return DBOS.registerWorkflow(asActor, { name });
}

/** An `actorOf` for a workflow that is the runner's own work: system(reason). */
export function systemEntry(reason: string): () => Actor {
  const actor = systemActor(reason);
  return () => actor;
}
