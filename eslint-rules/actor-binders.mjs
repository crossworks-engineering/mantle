/**
 * actor-binders (workspaces arch A2a): where code names who it runs as. Each
 * product file that binds an actor is listed with its number of binder
 * calls: runAsActor, runAsSystem, runReadPathWrite, runInActorSlot,
 * setSlotActor, setRequestActor, runWithoutActor, actorStore.run and
 * actorStore.enterWith. A call with type arguments counts too, nested ones
 * included (`runAsSystem<Array<Row>>(`). Comments and the helpers' own
 * definitions do not count. eslint-rules/process-entries.test.ts fails on
 * any other count, so a binder only appears, moves or goes with a reviewed
 * pin change here (docs/actors.md says who each entry runs as).
 */
import { stripComments } from './arch-counts.mjs';

/** Type arguments, up to three levels deep: `<T>`, `<Array<T>>`, `<Map<K, Array<T>>>`. */
const TYPE_ARGS = '<(?:[^<>()]|<(?:[^<>()]|<[^<>()]*>)*>)*>';

const BINDER_CALL = new RegExp(
  '(?<!function\\s+)\\b(?:runAsActor|runAsSystem|runReadPathWrite|runInActorSlot|' +
    `setSlotActor|setRequestActor|runWithoutActor)(?:${TYPE_ARGS})?\\(|` +
    '\\bactorStore\\.(?:run|enterWith)\\(',
  'g',
);

/** The binder calls in a file's text. */
export function binderSites(text) {
  return (stripComments(text).match(BINDER_CALL) ?? []).length;
}

/** @type {Record<string, number>} file -> binder calls */
export const ACTOR_BINDER_PINS = {
  'packages/content/src/kind-root.ts': 1,
  'packages/content/src/pages/read.ts': 1,
  'packages/content/src/recall.ts': 1,
  'packages/content/src/shares.ts': 1,
  'packages/content/src/tree/apps-nav.ts': 2,
  'packages/db/src/actor.ts': 4,
  'packages/db/src/client.ts': 3,
  // The one ordered gate (arch A3c): step 3 binds the actor the policy
  // implies, once per call.
  'packages/db/src/gate.ts': 1,
  'packages/db/src/viewer.ts': 8,
  'packages/files/src/docs.ts': 1,
  'packages/files/src/ops/shared.ts': 1,
  'packages/runtime/src/heartbeats/fire.ts': 2,
  'packages/tools/src/pending.ts': 1,
  'server/api/src/agent/extract-queue.ts': 2,
  'server/api/src/agent/runtime.ts': 4,
  'server/api/src/agent/ticker.ts': 1,
  'server/api/src/workflows/actor-workflow.ts': 1,
  'server/api/src/workflows/runs-resume-turn.ts': 2,
  'server/api/src/workflows/runs-worker-turn.ts': 1,
  'server/mcp/src/server.ts': 2,
  'server/mcp/src/stdio-actor.ts': 2,
  'server/web/lib/auth/session.ts': 2,
  'server/web/lib/contact-share-gate.ts': 2,
  'server/web/lib/journey.ts': 1,
  'server/web/lib/realtime.ts': 2,
  'server/web/lib/runs/execute-item.ts': 1,
  'server/web/server/main.ts': 3,
  'server/web/server/middleware/gate.ts': 1,
  'server/web/server/pages/print.ts': 1,
  'server/web/server/pages/share.tsx': 1,
  'server/web/workers/_runner.ts': 1,
};
