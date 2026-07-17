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

/** Team Chat turn workflow (external team-member surface). */
export const TEAM_TURN_WORKFLOW = 'teamTurnWorkflow';

/** Team Forum turn workflow (shared-topic surface — the agent answering a
 *  member's post in a topic every member can read). */
export const FORUM_TURN_WORKFLOW = 'forumTurnWorkflow';

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

/** Serializable input for the team turn runner — mirrors runTeamTurn's
 *  (ownerId, text, options) arguments. */
export type TeamTurnInput = {
  ownerId: string;
  text: string;
  options: import('./run-team-turn').RunTeamTurnOptions;
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

/** Serializable input for the forum turn runner — mirrors runForumTurn's
 *  (ownerId, options) arguments. The triggering member post is already
 *  persisted by the route, so there is no `text` half. */
export type ForumTurnInput = {
  ownerId: string;
  options: import('./run-forum-turn').RunForumTurnOptions;
};

/** Serializable forum-turn result DTO (dates pre-stringified). */
export type ForumTurnRunResult = {
  outbound: {
    id: string;
    body: string;
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
