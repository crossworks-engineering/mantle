/**
 * An agent runs inside its workspace (workspaces W4b, plan 5.1), or, for an
 * agent with none, inside its level (member logins Phase 0b, plan section 2b).
 *
 * The four functions that read the brain for an agent wrap THEMSELVES here
 * (loadConversationContext, assembleResponderTurn, runResponderLoop,
 * runToolLoop), so no entry point can forget:
 *
 *  - an assistant of a workspace other than Admin (the Team assistant) runs
 *    its turn in a TURN scope of that one workspace on the workspace role:
 *    every query in its own short transaction, none held across an LLM call,
 *    and a lost scope refused (withTurnScope). Its writes stay on the system
 *    pool's own paths. modWs is the workspace when the login it answers is a
 *    Moderator there, else empty; no login (a heartbeat) reads only; a login
 *    with no user row in that workspace is refused;
 *  - the Admin assistant stays on the system pool until W6a (the Admin
 *    workspace holds every migrated item) and only carries its stamp (the
 *    workspace and login its runs and traces are written with);
 *  - an agent with no workspace (a specialist, a worker) runs at its level,
 *    as before, and INSIDE a turn scope it runs in the caller's scope: a
 *    helper never widens it (plan 5.1).
 *
 * Nested: the same workspace reuses the open scope; another workspace, or an
 * Admin assistant inside a non-Admin turn, is refused (fail closed). A
 * workspace that cannot be read (gone, archived) is refused, never read as
 * no workspace.
 *
 * Imported from `@mantle/db/viewer` where it can be, not `@mantle/db`: a test
 * that fakes the whole `@mantle/db` module keeps the real scope.
 */
import { and, eq } from 'drizzle-orm';
import { asSystem, db, withTurnScope, withViewer, workspaces, workspaceUsers } from '@mantle/db';
import {
  currentWorkspaceScope,
  isViewerLevel,
  withTurnStamp,
  type ViewerLevel,
} from '@mantle/db/viewer';

/** The agent's level. A row always carries a valid one (CHECK + default);
 *  a value-less stand-in (tests, synthetic agents) counts as admin. */
export function agentLevel(agent: { audience?: string | null }): ViewerLevel {
  return isViewerLevel(agent.audience) ? agent.audience : 'admin';
}

/** What a scope wrapper needs of an agent. */
export type ScopedAgent = {
  /** agents.id: whom a level scope acts for (R6); absent reads as an
   *  assistant on no workspace (nothing). */
  id?: string | null;
  audience?: string | null;
  /** agents.workspace_id: the workspace this assistant answers in, if any. */
  workspaceId?: string | null;
};

/** The workspace an assistant answers in could not be used. */
export class AgentWorkspaceError extends Error {
  readonly code = 'agent-workspace';
  constructor(message: string) {
    super(message);
    this.name = 'AgentWorkspaceError';
  }
}

/** The workspace row an assistant answers in, read on the system pool. */
async function agentWorkspace(id: string): Promise<{ isAdmin: boolean }> {
  const [row] = await asSystem(
    () =>
      db
        .select({ isAdmin: workspaces.isAdmin, archivedAt: workspaces.archivedAt })
        .from(workspaces)
        .where(eq(workspaces.id, id))
        .limit(1),
    'agent-workspace',
  );
  if (!row) throw new AgentWorkspaceError('This assistant’s workspace no longer exists.');
  if (row.archivedAt) throw new AgentWorkspaceError('This assistant’s workspace is archived.');
  return { isAdmin: row.isAdmin };
}

/** `loginId`'s user row in workspace `wsId` (system pool), or null when the
 *  login is not a user there. */
async function membership(wsId: string, loginId: string): Promise<{ moderator: boolean } | null> {
  const [row] = await asSystem(
    () =>
      db
        .select({ moderator: workspaceUsers.moderator })
        .from(workspaceUsers)
        .where(and(eq(workspaceUsers.workspaceId, wsId), eq(workspaceUsers.loginId, loginId)))
        .limit(1),
    'agent-workspace',
  );
  return row ?? null;
}

/**
 * Whether the agent's turns run in a turn scope (W4b fix round 1, M2): it
 * answers in a workspace other than Admin. False for the Admin assistant
 * (the system pool until W6a) and for an agent with no workspace (a helper,
 * at its level). A workspace that is gone or archived throws
 * AgentWorkspaceError (never read as no workspace).
 */
export async function agentTurnScoped(agent: ScopedAgent): Promise<boolean> {
  if (!agent.workspaceId) return false;
  return !(await agentWorkspace(agent.workspaceId)).isAdmin;
}

/**
 * Run `fn` in the agent's scope (see the module comment). `loginId` is the
 * login the turn answers (its R3 rows and its write rights), or null.
 */
export async function withAgentScope<T>(
  agent: ScopedAgent,
  fn: () => Promise<T>,
  opts: { loginId?: string | null } = {},
): Promise<T> {
  const open = currentWorkspaceScope();
  const wsId = agent.workspaceId ?? null;
  if (!wsId) {
    // A helper: inside a turn it runs in the caller's scope, never wider.
    if (open) return fn();
    return withViewer(agentLevel(agent), { agent: agent.id ?? null }, fn);
  }
  if (open) {
    if (open.ws.length === 1 && open.ws[0] === wsId) return fn();
    throw new AgentWorkspaceError(
      'An assistant of another workspace cannot run inside this turn: its scope would change.',
    );
  }
  const loginId = opts.loginId ?? null;
  const ws = await agentWorkspace(wsId);
  if (ws.isAdmin) {
    // The Admin assistant: the system pool until W6a, with its stamp.
    return withTurnStamp({ workspaceId: wsId, loginId }, () =>
      withViewer(agentLevel(agent), { agent: agent.id ?? null }, fn),
    );
  }
  // The login the turn answers must be a user of the workspace (L3): a
  // login with no row there is refused, never read as a reader without one.
  const user = loginId ? await membership(wsId, loginId) : null;
  if (loginId && !user) {
    throw new AgentWorkspaceError(
      'The login this turn answers is not a user of the assistant’s workspace.',
    );
  }
  const modWs = user?.moderator ? [wsId] : [];
  return withTurnScope({ kind: 'assistant', loginId, ws: [wsId], modWs }, fn);
}

/** Run `fn` at the agent's level or in its workspace (withAgentScope). */
export function withAgentViewer<T>(
  agent: ScopedAgent,
  fn: () => Promise<T>,
  opts: { loginId?: string | null } = {},
): Promise<T> {
  return withAgentScope(agent, fn, opts);
}

/** The login a tool surface names (a member's or a client's turn), if any. */
export function surfaceLoginId(surface: unknown): string | null {
  const s = surface as { kind?: string; loginId?: unknown } | null | undefined;
  if ((s?.kind === 'team' || s?.kind === 'client') && typeof s.loginId === 'string') {
    return s.loginId;
  }
  return null;
}

/**
 * Re-enter the scope a run was made in (plan 5.4, U5): a run carries the
 * workspace and login of the turn that planned it (runs.workspace_id and
 * login_id, stamped at write; NULL = Admin). A worker calls this before its
 * first query for the run: the Admin workspace (or none) runs as before on
 * the system pool with its stamp; any other workspace in a turn scope of
 * it, read only unless the run's login moderates there.
 */
export async function withRunScope<T>(
  run: { workspaceId?: string | null; loginId?: string | null },
  fn: () => Promise<T>,
): Promise<T> {
  if (!run.workspaceId) return fn();
  return withAgentScope({ audience: 'admin', workspaceId: run.workspaceId }, fn, {
    loginId: run.loginId ?? null,
  });
}
