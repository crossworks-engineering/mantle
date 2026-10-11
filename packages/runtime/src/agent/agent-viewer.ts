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
 *  - the Admin assistant (W7a) runs its turn in a turn scope of the Admin
 *    workspace too, like every other assistant: it reads what Admin holds,
 *    never another user's private workspace. It writes as an Admin user's
 *    mutating request does (the system pool, with the turn's scope set on
 *    its transactions for the database's checks). modWs is Admin when the
 *    login it answers moderates Admin. A turn that answers no login (a
 *    heartbeat, a run, an owner Telegram bot) acts for the owner: the
 *    anchor login's write path, and nothing more. Its rows keep their
 *    stamp (the workspace, and the login only when one asked).
 *    MANTLE_ADMIN_READS=system puts it back on the system pool with its
 *    stamp, as before W7a;
 *  - an agent with no workspace (a specialist, a worker) runs INSIDE a turn
 *    scope in the caller's scope: a helper never widens it (plan 5.1).
 *    Run straight from a chat (an Admin user talking to the replay agent),
 *    an admin-level helper runs in the asking login's turn scope of the
 *    Admin workspace, as the Admin assistant does (W7c fix round 2, H1):
 *    row security keeps each login's digests and archived chat summaries
 *    (nodes.login_id, 0269) to that login, in every memory tool. A login
 *    that is not a user of Admin is refused. With no login asked (system
 *    work: a heartbeat, a run, a worker) it runs at its level, as before; a
 *    chat turn always names its login (runAssistantTurn refuses a helper
 *    without one). A brain not on workspaces runs at the level, as before.
 *    MANTLE_ADMIN_READS=system is the emergency rollback: the helper is back
 *    on the system pool, as before W7, and the memory tools there read
 *    every login's digests (replay_window and find_window still filter by
 *    the asking login in code);
 *
 * Nested: the same workspace reuses the open scope; another workspace, or an
 * Admin assistant inside a non-Admin turn, is refused (fail closed). A
 * workspace that cannot be read (gone, archived) is refused, never read as
 * no workspace.
 *
 * Imported from `@mantle/db/viewer` where it can be, not `@mantle/db`: a test
 * that fakes the whole `@mantle/db` module keeps the real scope.
 */
import { and, eq, isNull } from 'drizzle-orm';
import {
  agents,
  asSystem,
  db,
  withTurnScope,
  withViewer,
  workspaces,
  workspaceUsers,
} from '@mantle/db';
import {
  adminReadsOnSystemPool,
  currentRequestMode,
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
  /** agents.owner_id: the brain the agent belongs to (read by id when
   *  absent). */
  ownerId?: string | null;
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

/** The workspace row an assistant answers in, read on the system pool:
 *  whether it is Admin, and the brain (the anchor login) that owns it. */
async function agentWorkspace(id: string): Promise<{ isAdmin: boolean; ownerId: string }> {
  const [row] = await asSystem(
    () =>
      db
        .select({
          isAdmin: workspaces.isAdmin,
          ownerId: workspaces.ownerId,
          archivedAt: workspaces.archivedAt,
        })
        .from(workspaces)
        .where(eq(workspaces.id, id))
        .limit(1),
    'agent-workspace',
  );
  if (!row) throw new AgentWorkspaceError('This assistant’s workspace no longer exists.');
  if (row.archivedAt) throw new AgentWorkspaceError('This assistant’s workspace is archived.');
  return { isAdmin: row.isAdmin, ownerId: row.ownerId };
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

/** The brain an agent belongs to: agents.owner_id, read by id when the
 *  caller passed none; null for a synthetic agent with neither. */
async function agentBrain(agent: ScopedAgent): Promise<string | null> {
  if (agent.ownerId) return agent.ownerId;
  if (!agent.id) return null;
  const [row] = await asSystem(
    () =>
      db
        .select({ ownerId: agents.ownerId })
        .from(agents)
        .where(eq(agents.id, agent.id!))
        .limit(1),
    'agent-workspace',
  );
  return row?.ownerId ?? null;
}

/**
 * `loginId`'s user row in the live Admin workspace of brain `ownerId`
 * (system pool): its workspace and whether it moderates there. Null when
 * the login is not a user of Admin; 'no-workspaces' when the brain has no
 * Admin workspace at all (a brain not on workspaces). With no brain known,
 * the login's own Admin workspace, else null (fail closed).
 */
async function adminUserOf(
  loginId: string,
  ownerId: string | null,
): Promise<{ wsId: string; moderator: boolean } | 'no-workspaces' | null> {
  const rows = await asSystem(
    () =>
      db
        .select({ wsId: workspaces.id, moderator: workspaceUsers.moderator })
        .from(workspaceUsers)
        .innerJoin(workspaces, eq(workspaces.id, workspaceUsers.workspaceId))
        .where(
          and(
            eq(workspaceUsers.loginId, loginId),
            eq(workspaces.isAdmin, true),
            isNull(workspaces.archivedAt),
            ...(ownerId ? [eq(workspaces.ownerId, ownerId)] : []),
          ),
        )
        .limit(2),
    'agent-workspace',
  );
  if (rows.length === 1) return rows[0]!;
  if (rows.length > 1) return null;
  if (ownerId && !(await adminWorkspaceOf(ownerId))) return 'no-workspaces';
  return null;
}

/**
 * Where the agent's turns run (W4b fix round 1, M2; W7a): 'admin' for the
 * Admin assistant (a turn scope of Admin, or the system pool under
 * MANTLE_ADMIN_READS=system), 'workspace' for an assistant of any other
 * workspace (a turn scope of it), 'none' for an agent with no workspace (a
 * helper, at its level). A workspace that is gone or archived throws
 * AgentWorkspaceError (never read as no workspace).
 */
export async function agentWorkspaceKind(
  agent: ScopedAgent,
): Promise<'admin' | 'workspace' | 'none'> {
  if (!agent.workspaceId) return 'none';
  return (await agentWorkspace(agent.workspaceId)).isAdmin ? 'admin' : 'workspace';
}

/**
 * Whether the agent's turns run in a turn scope: an assistant of any
 * workspace, the Admin one included since W7a (not under
 * MANTLE_ADMIN_READS=system). False for an agent with no workspace.
 */
export async function agentTurnScoped(agent: ScopedAgent): Promise<boolean> {
  const kind = await agentWorkspaceKind(agent);
  if (kind === 'admin') return !adminReadsOnSystemPool();
  return kind === 'workspace';
}

/**
 * Run `fn` in the agent's scope (see the module comment). `loginId` is the
 * login the turn answers (its R3 rows and its write rights), or null.
 */
export async function withAgentScope<T>(
  agent: ScopedAgent,
  fn: () => Promise<T>,
  opts: {
    loginId?: string | null;
    /** The login an owner surface names (the web chat's signed-in login,
     *  an MCP connection's): whom the Admin assistant answers when no
     *  member or client login is given. Ignored for other assistants. */
    ownerLoginId?: string | null;
  } = {},
): Promise<T> {
  const open = currentWorkspaceScope();
  const wsId = agent.workspaceId ?? null;
  if (!wsId) {
    // A helper: inside a turn it runs in the caller's scope, never wider.
    if (open) return fn();
    // Run straight from a chat (an Admin user talking to the replay agent),
    // it answers that login (W7c fix rounds 1 and 2, H1): an admin-level
    // helper runs in the login's turn scope of Admin, so row security keeps
    // every other login's chats, digests and archived summaries out of its
    // memory tools. No login (system work): at its level, no stamp, and a
    // per-login tool (replay_window, find_window) refuses.
    const asked = opts.loginId ?? opts.ownerLoginId ?? null;
    const run = () => withViewer(agentLevel(agent), { agent: agent.id ?? null }, fn);
    if (!asked) return run();
    const stamped = (wsId: string | null) =>
      withTurnStamp({ workspaceId: wsId, loginId: asked }, run);
    // A helper below admin already reads only its own (empty) scope; the
    // rollback switch puts the helper back on the system pool (an emergency
    // switch: see the module comment).
    if (agentLevel(agent) !== 'admin' || adminReadsOnSystemPool()) return stamped(null);
    const admin = await adminUserOf(asked, await agentBrain(agent));
    if (admin === 'no-workspaces') return stamped(null);
    if (!admin) {
      throw new AgentWorkspaceError(
        'The login this turn answers is not a user of the Admin workspace.',
      );
    }
    const modWs = admin.moderator ? [admin.wsId] : [];
    return withTurnStamp({ workspaceId: admin.wsId, loginId: asked }, () =>
      withTurnScope({ kind: 'assistant', loginId: asked, ws: [admin.wsId], modWs }, fn, {
        writes: true,
      }),
    );
  }
  if (open) {
    if (open.ws.length === 1 && open.ws[0] === wsId) return fn();
    // Inside a user's own scope (an Admin login's MCP call, W7a; a request
    // scope): an assistant of one of its workspaces narrows it, never widens
    // it (runInTurnScope checks the narrowing again).
    if (!(currentRequestMode() && open.kind === 'user' && open.ws.includes(wsId))) {
      throw new AgentWorkspaceError(
        'An assistant of another workspace cannot run inside this turn: its scope would change.',
      );
    }
  }
  const ws = await agentWorkspace(wsId);
  if (ws.isAdmin) {
    const asked = opts.loginId ?? opts.ownerLoginId ?? null;
    const stamp = { workspaceId: wsId, loginId: asked };
    // The rollback switch: the system pool, with its stamp, as before W7a.
    if (adminReadsOnSystemPool()) {
      return withTurnStamp(stamp, () =>
        withViewer(agentLevel(agent), { agent: agent.id ?? null }, fn),
      );
    }
    // A turn that answers no login acts for the owner (the anchor login).
    const actsFor = asked ?? ws.ownerId;
    const user = await membership(wsId, actsFor);
    if (!user) {
      throw new AgentWorkspaceError(
        'The login this turn answers is not a user of the Admin workspace.',
      );
    }
    const modWs = user.moderator ? [wsId] : [];
    return withTurnStamp(stamp, () =>
      withTurnScope({ kind: 'assistant', loginId: actsFor, ws: [wsId], modWs }, fn, {
        writes: true,
      }),
    );
  }
  const loginId = opts.loginId ?? null;
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
  opts: { loginId?: string | null; ownerLoginId?: string | null } = {},
): Promise<T> {
  return withAgentScope(agent, fn, opts);
}

/** The login an owner surface names (the web chat's signed-in login, an MCP
 *  connection's or an API key's), if any: whom the Admin assistant answers
 *  (W7a). Never read from model arguments. */
export function ownerSurfaceLogin(surface: unknown): string | null {
  const s = surface as { kind?: string; loginId?: unknown } | null | undefined;
  if ((s?.kind === 'web' || s?.kind === 'owner') && typeof s.loginId === 'string') {
    return s.loginId !== '' ? s.loginId : null;
  }
  return null;
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
 * first query for the run: the Admin workspace in a turn scope of Admin
 * (W7a; the run's login, else the owner), any other workspace in a turn
 * scope of it, read only unless the run's login moderates there. A run with
 * no workspace is the Admin assistant's (NULL = Admin): the brain's Admin
 * workspace. MANTLE_ADMIN_READS=system, or a brain not on workspaces: the
 * system pool, as before.
 */
export async function withRunScope<T>(
  run: { workspaceId?: string | null; loginId?: string | null; ownerId?: string | null },
  fn: () => Promise<T>,
): Promise<T> {
  let wsId = run.workspaceId ?? null;
  if (!wsId) {
    if (adminReadsOnSystemPool() || !run.ownerId) return fn();
    wsId = await adminWorkspaceOf(run.ownerId);
    if (!wsId) return fn();
  }
  return withAgentScope({ audience: 'admin', workspaceId: wsId }, fn, {
    loginId: run.loginId ?? null,
  });
}

/** The brain's live Admin workspace (system pool), or null on a brain not
 *  on workspaces. */
async function adminWorkspaceOf(ownerId: string): Promise<string | null> {
  const [row] = await asSystem(
    () =>
      db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(
          and(
            eq(workspaces.ownerId, ownerId),
            eq(workspaces.isAdmin, true),
            isNull(workspaces.archivedAt),
          ),
        )
        .limit(1),
    'agent-workspace',
  );
  return row?.id ?? null;
}
