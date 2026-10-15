/**
 * An agent runs inside its workspace (workspaces W4b, plan 5.1); an agent
 * with none is a system-wide helper that runs in its caller's scope.
 *
 * The four functions that read the brain for an agent wrap THEMSELVES here
 * (loadConversationContext, assembleResponderTurn, runResponderLoop,
 * runToolLoop), so no entry point can forget:
 *
 *  - an assistant of a workspace other than Admin (the Team assistant) runs
 *    its turn in a TURN scope of that one workspace on the workspace role:
 *    every query in its own short transaction, none held across an LLM call,
 *    and a lost scope refused (withTurnScope). It writes with the rights of
 *    the login it answers, in that workspace only (plan v2 4.2, the A8
 *    finding F2): each write is a short transaction of the login write
 *    gateway with the turn's scope set on it, as the login's mutating
 *    request writes, and the database's checks decide (a Moderator of the
 *    home, or a grant with Write on). modWs is the workspace when the login
 *    it answers is a Moderator there, else empty (a Moderator seat in any
 *    other workspace never counts here); no login (a heartbeat) reads only
 *    (turnScopeWrites, shared with an approved pending call); a login with
 *    no user row in that workspace is refused;
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
 *    the helper runs in the asking login's turn scope of the
 *    Admin workspace, as the Admin assistant does (W7c fix round 2, H1):
 *    row security keeps each login's digests and archived chat summaries
 *    (nodes.login_id, 0269) to that login, in every memory tool. A login
 *    that is not a user of Admin is refused. With no login asked (system
 *    work: a heartbeat, a run, a worker) a specialist or a worker does
 *    system work; a responder or an assistant on no workspace is refused
 *    on a brain on workspaces (W8 integration); a chat turn always names
 *    its login (runAssistantTurn refuses a helper without one). On a brain not on workspaces it answers an admin login on the
 *    system pool, as that login's requests run there, and reads nothing for
 *    any other login (W8c: the agent's old level no longer decides).
 *    MANTLE_ADMIN_READS=system is the emergency rollback: the helper is back
 *    on the system pool, as before W7, and the memory tools there read
 *    every login's digests (replay_window and find_window still filter by
 *    the asking login in code);
 *
 * Nested: the same workspace reuses the open scope; another workspace, or an
 * Admin assistant inside a non-Admin turn, is refused (fail closed). A turn
 * started on the system pool from inside a scope (a tool's work under
 * asSystem, W7a fix round 2) answers the login of the scope it left, never
 * the anchor; one that names another login is refused. A
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
  authUsers,
  db,
  withGateScope,
  withTurnScope,
  withViewer,
  workspaces,
  workspaceUsers,
} from '@mantle/db';
import {
  adminReadsOnSystemPool,
  currentGateScope,
  currentRequestMode,
  currentTurnStamp,
  currentWorkspaceScope,
  scopeLeftForSystem,
  turnScopeWrites,
  withTurnStamp,
} from '@mantle/db/viewer';

/** What a scope wrapper needs of an agent. */
export type ScopedAgent = {
  /** agents.id. */
  id?: string | null;
  /** agents.owner_id: the brain the agent belongs to (read by id when
   *  absent). */
  ownerId?: string | null;
  /** agents.workspace_id: the workspace this assistant answers in, if any. */
  workspaceId?: string | null;
  /** agents.role: a responder or an assistant on no workspace answers
   *  people, a specialist or a worker does not. Every entry point that holds
   *  the agent's row passes it (the row itself), and runToolLoop passes its
   *  caller's agentRole, so a delegated child (invoke_agent) is checked too. */
  role?: string | null;
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
      db.select({ ownerId: agents.ownerId }).from(agents).where(eq(agents.id, agent.id!)).limit(1),
    'agent-workspace',
  );
  return row?.ownerId ?? null;
}

/** Whether `loginId` is an enabled admin login (system pool): on a brain not
 *  on workspaces, the role is what puts a login's requests on the system
 *  pool (the session guard's 'not-on-workspaces' outcome). */
async function enabledAdminLogin(loginId: string): Promise<boolean> {
  const [row] = await asSystem(
    () =>
      db
        .select({ role: authUsers.role })
        .from(authUsers)
        .where(and(eq(authUsers.id, loginId), isNull(authUsers.disabledAt)))
        .limit(1),
    'agent-workspace',
  );
  return row?.role === 'admin';
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
 * helper, in its caller's scope). A workspace that is gone or archived throws
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
    // it answers that login (W7c fix rounds 1 and 2, H1): the helper runs in
    // the login's turn scope of Admin, so row security keeps every other
    // login's chats, digests and archived summaries out of its memory tools.
    // No login (system work): the system pool, no stamp, and a per-login
    // tool (replay_window, find_window) refuses.
    //
    // Started on the system pool from inside a scope (a tool's work under
    // asSystem), it answers the login of the scope it left, as a workspace
    // assistant does (W7a fix round 2, N1; W7 integration fix): never as
    // system work, which would read every login's chats. A named login other
    // than that one is refused, and so is a left scope with no login.
    const left = scopeLeftForSystem();
    const named = opts.loginId ?? opts.ownerLoginId ?? null;
    if (left) {
      if (!left.loginId) {
        throw new AgentWorkspaceError(
          'A helper started from this call needs the login that called it, and this call has none.',
        );
      }
      if (named !== null && named !== left.loginId) {
        throw new AgentWorkspaceError(
          'A helper started from this call answers the login that called it, not another login.',
        );
      }
    }
    const asked = left ? left.loginId : named;
    if (!asked) {
      // System work (a heartbeat, a run, a worker) with no login: a
      // specialist or a worker runs it on the system pool. A responder or an
      // assistant answers people: on a brain on workspaces one on no
      // workspace holds none, so with no login it has nothing to run in and
      // is refused, never run as system work (W8 integration). A brain not
      // known is read as one on workspaces (fail closed).
      if (agent.role === 'responder' || agent.role === 'assistant') {
        const brain = await agentBrain(agent);
        if (!brain || (await adminWorkspaceOf(brain))) {
          throw new AgentWorkspaceError(
            'This assistant is in no workspace and this call names no login: it has nothing to answer in.',
          );
        }
      }
      return fn();
    }
    const stamped = (wsId: string | null) =>
      withTurnStamp({ workspaceId: wsId, loginId: asked }, fn);
    const admin = await adminUserOf(asked, await agentBrain(agent));
    if (admin === 'no-workspaces') {
      // A brain not on workspaces (W8c): an admin login's helper runs on
      // the system pool, as that login's requests do there; any other
      // login's reads nothing (an assistant on no workspace).
      if (await enabledAdminLogin(asked)) return stamped(null);
      return withTurnStamp({ workspaceId: null, loginId: asked }, () =>
        withViewer({ agent: null }, fn),
      );
    }
    if (!admin) {
      throw new AgentWorkspaceError(
        'The login this turn answers is not a user of the Admin workspace.',
      );
    }
    const modWs = admin.moderator ? [admin.wsId] : [];
    // The rollback switch puts the helper back on the system pool (an
    // emergency switch: see the module comment), for an Admin user only,
    // and its gates still ask that login (W7 integration fix 2, M6).
    if (adminReadsOnSystemPool()) {
      return withGateScope({ kind: 'assistant', loginId: asked, ws: [admin.wsId], modWs }, () =>
        stamped(null),
      );
    }
    const scope = { kind: 'assistant' as const, loginId: asked, ws: [admin.wsId], modWs };
    return withTurnStamp({ workspaceId: admin.wsId, loginId: asked }, () =>
      withTurnScope(scope, fn, { writes: turnScopeWrites(scope, false) }),
    );
  }
  // Under MANTLE_ADMIN_READS=system the Admin assistant's own scope is a gate
  // scope with its stamp, not a turn scope: re-entered for the same
  // workspace (a heartbeat's caller, then its tool loop; W8 final round 2) it
  // keeps the login already chosen, as the open turn scope does below. Read
  // afresh it would act for the anchor, and its gates would ask the anchor.
  // Not on an asSystem exit from a scope entered since (a narrower turn
  // scope's tool work, W8 final round 3): the outer gate scope is still
  // there, but the turn answers the login of the scope it left, or is
  // refused, as below.
  if (!open && adminReadsOnSystemPool() && scopeLeftForSystem() === null) {
    const gate = currentGateScope();
    if (
      gate?.kind === 'assistant' &&
      gate.ws.length === 1 &&
      gate.ws[0] === wsId &&
      currentTurnStamp()?.workspaceId === wsId
    ) {
      return fn();
    }
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
  // Inside a user's own scope the nested turn answers THAT login unless a
  // login is named (W7a fix round 1, M1): ask_responder over an Admin
  // login's MCP names none, and the turn then acted for the anchor, with
  // the anchor's areas and rows. Started on the system pool from inside a
  // scope (a tool call's work under asSystem, W7a fix round 2, N1), the
  // turn answers the login of the scope it left the same way: no open scope
  // there, and it acted for the anchor. A named login other than the
  // caller's is refused; a caller with no login (a public link, a turn that
  // answers nobody) starts no nested turn from the system pool.
  const left = open ? null : scopeLeftForSystem();
  const caller = open?.kind === 'user' ? open : left;
  const scopeLogin = caller?.loginId ?? null;
  const ws = await agentWorkspace(wsId);
  if (caller) {
    const named = opts.loginId ?? (ws.isAdmin ? opts.ownerLoginId : null) ?? null;
    if (named !== null && named !== caller.loginId) {
      throw new AgentWorkspaceError(
        'A nested assistant turn answers the login that called it, not another login.',
      );
    }
    if (left && !left.loginId) {
      throw new AgentWorkspaceError(
        'A nested assistant turn needs the login that called it, and this call has none.',
      );
    }
  }
  if (ws.isAdmin) {
    const asked = opts.loginId ?? opts.ownerLoginId ?? scopeLogin;
    const stamp = { workspaceId: wsId, loginId: asked };
    // A turn that answers no login and has no caller (a heartbeat's tick, a
    // run, an owner Telegram bot) acts for the owner (the anchor login).
    const actsFor = asked ?? ws.ownerId;
    const user = await membership(wsId, actsFor);
    if (!user) {
      throw new AgentWorkspaceError(
        'The login this turn answers is not a user of the Admin workspace.',
      );
    }
    const modWs = user.moderator ? [wsId] : [];
    // The rollback switch: the system pool, with its stamp, as before W7a,
    // for an Admin user only; the gates still ask the login the turn
    // answers (W7 integration fix 2, M6).
    if (adminReadsOnSystemPool()) {
      return withTurnStamp(stamp, () =>
        withGateScope({ kind: 'assistant', loginId: actsFor, ws: [wsId], modWs }, fn),
      );
    }
    // It acts for the owner when it answers no login (turnScopeWrites).
    const scope = { kind: 'assistant' as const, loginId: actsFor, ws: [wsId], modWs };
    return withTurnStamp(stamp, () =>
      withTurnScope(scope, fn, { writes: turnScopeWrites(scope, true) }),
    );
  }
  const loginId = opts.loginId ?? scopeLogin;
  // The login the turn answers must be a user of the workspace (L3): a
  // login with no row there is refused, never read as a reader without one.
  const user = loginId ? await membership(wsId, loginId) : null;
  if (loginId && !user) {
    throw new AgentWorkspaceError(
      'The login this turn answers is not a user of the assistant’s workspace.',
    );
  }
  const modWs = user?.moderator ? [wsId] : [];
  // It writes for its user with that user's rights, in its own workspace
  // only (plan v2 4.2, the A8 finding F2): the scope is this one workspace,
  // and the user's Moderator seat there, never a seat elsewhere. With no
  // user it only reads (turnScopeWrites).
  const scope = { kind: 'assistant' as const, loginId, ws: [wsId], modWs };
  return withTurnScope(scope, fn, { writes: turnScopeWrites(scope, false) });
}

/**
 * Whether the current turn is the anchor's own thread (W7 integration fix):
 * the login it answers is the brain owner. What an agent learned there (the
 * Journal's learned lanes, persona notes) rides only such a turn; another
 * user's turn never gets it (each user reads only their own chats).
 *
 * The login: `named` (the turn's login, else its owner surface login), else
 * the open workspace scope's (or the scope a system-pool turn left), else
 * the turn's stamp. A turn in no scope that answers no login (an owner
 * Telegram bot, system work on a brain not on workspaces) acts for the
 * owner: it is the anchor's thread. A workspace scope that answers no login
 * (another workspace's assistant on a heartbeat) is not.
 */
export function turnInAnchorThread(ownerId: string, named?: string | null): boolean {
  const scope = currentWorkspaceScope() ?? scopeLeftForSystem();
  const login = named ?? (scope ? scope.loginId : (currentTurnStamp()?.loginId ?? null));
  if (!login) return !scope;
  return login.toLowerCase() === ownerId.toLowerCase();
}

/** Run `fn` in the agent's workspace, or in its caller's scope for a helper
 *  (withAgentScope). */
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
  if (
    (s?.kind === 'web' || s?.kind === 'owner' || s?.kind === 'telegram') &&
    typeof s.loginId === 'string'
  ) {
    return s.loginId !== '' ? s.loginId : null;
  }
  return null;
}

/** The login a tool surface names (a member's turn, and a
 *  Telegram chat's paired login since W7d, which any workspace's assistant
 *  answers), if any. */
export function surfaceLoginId(surface: unknown): string | null {
  const s = surface as { kind?: string; loginId?: unknown } | null | undefined;
  if (
    (s?.kind === 'team' || s?.kind === 'telegram') &&
    typeof s.loginId === 'string' &&
    s.loginId !== ''
  ) {
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
  return withAgentScope({ workspaceId: wsId }, fn, {
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
