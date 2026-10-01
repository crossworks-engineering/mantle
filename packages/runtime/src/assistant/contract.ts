/**
 * Cross-process runner contract — the small set of constants + types that BOTH
 * sides of the durable assistant turn must agree on:
 *   - the server/api runner, which registers + executes the workflow, and
 *   - any enqueuer (the Next.js route via DBOSClient).
 *
 * DBOS is deliberately NOT imported here so @mantle/assistant-runtime stays
 * engine-free; callers pass these strings to the DBOS APIs themselves.
 */

import type { ToolArtifact } from '@mantle/tools';
import type { RunAssistantTurnOptions } from './run-turn';
import { env } from '@mantle/config';

/** DBOS workflow name the runner registers under and enqueuers target. */
export const ASSISTANT_TURN_WORKFLOW = 'assistantTurnWorkflow';

/** Team Chat turn workflow (external team-member surface). */
export const TEAM_TURN_WORKFLOW = 'teamTurnWorkflow';

/** A CLIENT login's chat turn (client logins C4). Its own workflow, so the
 *  role comes from which workflow runs, never from the queued input. */
export const CLIENT_TURN_WORKFLOW = 'clientTurnWorkflow';

/** The retired Team Forum turn workflow's name (member logins Phase 6). No
 *  one enqueues it any more; server/api keeps a no-op stub registered under
 *  it so a forum turn still queued, or in flight, on a box when it upgrades
 *  finishes cleanly instead of failing on every boot. */
export const RETIRED_FORUM_TURN_WORKFLOW = 'forumTurnWorkflow';

/** The shared runner queue. Its concurrency cap (set where the queue is
 *  registered, in server/api) bounds total in-flight runs across processes — the
 *  LLM-provider backpressure valve. */
export const RUNNER_QUEUE = 'mantle';

/** The member chat's own queue (audit F31): member turns used to share
 *  RUNNER_QUEUE with the owner's interactive turns, so a few busy members could
 *  queue ahead of the owner. Registered in server/api with a low concurrency
 *  (MANTLE_MEMBER_TURN_CONCURRENCY, default 2), as background runs got
 *  RUNS_TURN_QUEUE. A turn enqueued here before server/api registers it waits
 *  until the api process rolls (compose restarts web and api together). */
export const MEMBER_TURN_QUEUE = 'mantle.member';

/** The client chat's own queue (client logins C4, plan section 8): client
 *  turns never wait behind member or owner turns, and the queue is
 *  PARTITIONED by login (enqueue with `queuePartitionKey` = the login id) with
 *  one turn in flight per partition, so one busy client cannot hold both
 *  slots. Registered in server/api (MANTLE_CLIENT_TURN_CONCURRENCY, default 2). */
export const CLIENT_TURN_QUEUE = 'mantle.client';

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

/** Serializable input for the team turn runner — mirrors runTeamTurn's
 *  (ownerId, text, options) arguments. */
export type TeamTurnInput = {
  ownerId: string;
  text: string;
  options: import('./run-team-turn').RunTeamTurnOptions;
};

/** Serializable input for the client turn runner (runClientTurn). */
export type ClientTurnInput = {
  ownerId: string;
  text: string;
  options: import('./run-team-turn').RunClientTurnOptions;
};

/** Serializable team-turn result DTO (dates pre-stringified). */
export type TeamTurnRunResult = {
  inbound: { id: string; text: string; createdAt: string };
  outbound: {
    id: string;
    text: string;
    model: string | null;
    traceId: string | null;
    createdAt: string;
  };
  reply: string;
};

/**
 * Resolve the DBOS system-database URL (where workflows are enqueued + the run
 * journal lives). Defaults to the same Postgres server as DATABASE_URL with the
 * database name swapped to `mantle_dbos_sys`; override wholesale with
 * DBOS_SYSTEM_DATABASE_URL. Both the runner and the web enqueuer call this so
 * they always point at the SAME system DB.
 */
export function resolveSystemDatabaseUrl(): string {
  const explicit = env('DBOS_SYSTEM_DATABASE_URL');
  if (explicit) return explicit;
  const appUrl = env('DATABASE_URL');
  if (!appUrl) {
    throw new Error('DATABASE_URL (or DBOS_SYSTEM_DATABASE_URL) must be set to reach the runner');
  }
  const u = new URL(appUrl);
  u.pathname = '/mantle_dbos_sys';
  return u.toString();
}
