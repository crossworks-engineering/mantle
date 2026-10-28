/**
 * actor-binders (workspaces arch A2a): where code names who it runs as. Each
 * product file that binds an actor is listed with its number of binder
 * calls: runAsActor, runAsSystem, runReadPathWrite, runInActorSlot,
 * setSlotActor, setRequestActor, runWithoutActor, runSystemExit (viewer.ts's
 * private exit helper: each exit through it binds a system actor of its
 * own, so a new one moves the pin), actorStore.run and actorStore.enterWith.
 * A call with type arguments counts too, nested ones
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
    `setSlotActor|setRequestActor|runWithoutActor|runSystemExit)(?:${TYPE_ARGS})?\\(|` +
    '\\bactorStore\\.(?:run|enterWith)\\(',
  'g',
);

/** The binder calls in a file's text. */
export function binderSites(text) {
  return (stripComments(text).match(BINDER_CALL) ?? []).length;
}

/** @type {Record<string, number>} file -> binder calls */
export const ACTOR_BINDER_PINS = {
  // The export bookkeeping (A8 matrix F9): the dirty stamp and the
  // debounced sync's timer run as system(app-export), never the writer's
  // actor (a contact share writes its app's data only). One binder since
  // F4 fix round 2: both go through exportSyncStep (the named system step).
  'packages/content/src/app-table-exports.ts': 1,
  'packages/content/src/kind-root.ts': 1,
  'packages/content/src/pages/read.ts': 1,
  'packages/content/src/recall.ts': 1,
  'packages/content/src/shares.ts': 1,
  'packages/content/src/tree/apps-nav.ts': 2,
  'packages/db/src/actor.ts': 4,
  // A tool write's audit row (A5 step 6d): written as system(audit:tool-call)
  // whatever actor the call ran as, once per row.
  'packages/db/src/call-audit.ts': 1,
  // An MCP call's log row (Journal v3 J8): written as
  // system(audit:mcp-call) whatever actor the call ran as, once per row.
  'packages/db/src/mcp-call-log.ts': 1,
  // The one ordered gate (arch A3c): step 3 binds the actor the policy
  // implies, once per call.
  'packages/db/src/gate.ts': 1,
  // The system pool's start: its first mode read outside the caller's
  // actor (runWithoutActor), and a miss row as system(actor-check).
  'packages/db/src/gateway/pools.ts': 2,
  // loginActorNow: the login's own row read as system(entry).
  'packages/db/src/gateway/scope-answers.ts': 1,
  // 9 since arch A6b: systemWork, system work that refuses a workspace scope,
  // binds system(reason) as asSystem does. 7 to 6 with the first owner's
  // exit: asSystem, systemWork and that exit bind through one helper
  // (runSystemExit). 6 to 9 in the fresh-signup hardening round, measured:
  // no new binder, the count now sees that private helper's calls (asSystem,
  // systemWork, the first owner's exit: 3), so a fourth exit through it
  // moves this pin as a fourth runAsActor call would have.
  'packages/db/src/viewer.ts': 9,
  'packages/files/src/docs.ts': 1,
  'packages/files/src/ops/shared.ts': 1,
  // An MCP connection's private workspace, made as the connection's login
  // (createHomeFallback makes only the bound
  // login's own).
  'packages/mcp-core/src/login-surface.ts': 1,
  'packages/runtime/src/heartbeats/fire.ts': 2,
  // The app data reads' provisioning, a named read-path write (A5 step 4,
  // repair:app-db): one wrapper (provisionAppDb) that app_data_schema and
  // app_data_query hand the app broker (fix round 1, LOW-4).
  'packages/tools/src/builtins-app-data.ts': 1,
  'packages/tools/src/pending.ts': 1,
  // The approval re-check (A5 step 6c): the approved call's actor, bound
  // inside the scope it was asked in for the queue-time check again.
  'packages/tools/src/pending-approval.ts': 1,
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
  // + the messenger_changed fan-out (Messenger V1): its participant lookup.
  'server/web/lib/realtime.ts': 3,
  'server/web/lib/runs/execute-item.ts': 1,
  // A7: the snapshot copies, the manifest reconcile and the app table
  // exports run as binder calls; the workspaces step is systemWork since
  // (its assistant attach is workspace system work, 0307).
  'server/web/server/main.ts': 3,
  // The gate's own slot, and a page's (the /s page, a render page: A4 step
  // 2, moved here from server/pages/share.tsx and print.ts).
  'server/web/server/middleware/gate.ts': 2,
  'server/web/workers/_runner.ts': 1,
};
