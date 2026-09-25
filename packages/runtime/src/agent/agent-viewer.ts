/**
 * An agent runs inside its level (member logins Phase 0b, plan section 2b).
 *
 * `agents.audience` is the one switch: an admin agent runs on the admin pool
 * as today; a team (or lower) agent runs every query of its turn on that
 * level's limited role, so row level security decides what it reads.
 *
 * The four functions that read the brain for an agent wrap THEMSELVES at the
 * agent's level (loadConversationContext, assembleResponderTurn,
 * runResponderLoop, runToolLoop), so no entry point can forget. The level only
 * goes down: a team agent that invokes an admin agent still runs it at team.
 *
 * Imported from `@mantle/db/viewer`, not `@mantle/db`: a test that fakes the
 * whole `@mantle/db` module keeps the real scope (it is the same module).
 */
import { isViewerLevel, withViewer, type ViewerLevel } from '@mantle/db/viewer';

/** The agent's level. A row always carries a valid one (CHECK + default);
 *  a value-less stand-in (tests, synthetic agents) counts as admin. */
export function agentLevel(agent: { audience?: string | null }): ViewerLevel {
  return isViewerLevel(agent.audience) ? agent.audience : 'admin';
}

/** Run `fn` at the agent's level (never higher than the caller's). */
export function withAgentViewer<T>(
  agent: { audience?: string | null },
  fn: () => Promise<T>,
): Promise<T> {
  return withViewer(agentLevel(agent), fn);
}
