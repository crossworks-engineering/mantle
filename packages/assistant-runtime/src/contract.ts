/**
 * Cross-process runner contract — the small set of constants + types that BOTH
 * sides of the durable assistant turn must agree on:
 *   - the apps/api runner, which registers + executes the workflow, and
 *   - any enqueuer (the Next.js route via DBOSClient).
 *
 * DBOS is deliberately NOT imported here so @mantle/assistant-runtime stays
 * engine-free; callers pass these strings to the DBOS APIs themselves.
 */

import type { ToolArtifact } from '@mantle/tools';
import type { RunAssistantTurnOptions } from './run-turn';

/** DBOS workflow name the runner registers under and enqueuers target. */
export const ASSISTANT_TURN_WORKFLOW = 'assistantTurnWorkflow';

/** The shared runner queue. Its concurrency cap (set where the queue is
 *  registered, in apps/api) bounds total in-flight runs across processes — the
 *  LLM-provider backpressure valve. */
export const RUNNER_QUEUE = 'mantle';

/** Serializable input the runner carries in its journal — mirrors
 *  runAssistantTurn's (ownerId, text, options) arguments. */
export type AssistantTurnInput = {
  ownerId: string;
  text: string;
  options?: RunAssistantTurnOptions;
};

/** Serializable result the runner returns (and journals). A plain, JSON-safe
 *  DTO — dates pre-stringified, the persisted rows reduced to what the chat UI
 *  needs — so the enqueuer (the web route) can relay it directly with the same
 *  response shape it returned when the turn ran in-process. */
export type AssistantTurnRunResult = {
  inbound: { id: string; text: string; createdAt: string };
  outbound: { id: string; text: string; model: string | null; createdAt: string };
  reply: string;
  artifacts: ToolArtifact[];
};

/**
 * Resolve the DBOS system-database URL (where workflows are enqueued + the run
 * journal lives). Defaults to the same Postgres server as DATABASE_URL with the
 * database name swapped to `mantle_dbos_sys`; override wholesale with
 * DBOS_SYSTEM_DATABASE_URL. Both the runner and the web enqueuer call this so
 * they always point at the SAME system DB.
 */
export function resolveSystemDatabaseUrl(): string {
  const explicit = process.env.DBOS_SYSTEM_DATABASE_URL;
  if (explicit) return explicit;
  const appUrl = process.env.DATABASE_URL;
  if (!appUrl) {
    throw new Error('DATABASE_URL (or DBOS_SYSTEM_DATABASE_URL) must be set to reach the runner');
  }
  const u = new URL(appUrl);
  u.pathname = '/mantle_dbos_sys';
  return u.toString();
}
