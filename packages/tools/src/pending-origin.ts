/**
 * The scope a pending call was asked in, and the scope its approval judges
 * and runs it in (workspaces arch A5 step 6c, the approval re-check; 0288).
 *
 * At queue time (pendingOriginNow) the server stamps the row with the
 * asking turn's scope whole: its login, its workspaces and Moderator
 * workspaces, how the turn held it (a turn scope), whether it wrote as an
 * Admin turn, the Admin view it had
 * (Admin held, its Admin areas) and the surface it ran on. Never from model
 * arguments.
 *
 * At approval (originRunFor) the scope is rebuilt as the stamp met with the
 * asker's rights now: its workspaces and Moderator workspaces are those of
 * the stamp the asker still has (a turn that answered no login: those still
 * live), and its Admin view is capped by the stamp's (gateCallerFor reads
 * the cap off the approval). So the call never gains a right the asker lost
 * since it asked, and never runs wider than where it asked: a right gained
 * since is not the call's. A scope left with no workspace refuses the
 * approval (PENDING_SCOPE_LOST_ERROR). withOriginScope enters it for the
 * re-check and for the run, whatever scope the approving path runs in (a
 * web request's, an MCP connection's, a Telegram tap's none).
 *
 * Fix round 1: the call is judged and dispatched on the surface it was
 * asked on (the stamp's kind and login; a Telegram chat's as an owner path
 * naming its login, the chat id not being stamped), so a handler that reads
 * its author or an owner-only rule off the surface sees the asker, never
 * the approver (the audit row names the approver on its own field). Lows
 * round (6c L1 to L3): the surface's login is the row's asker (login_id),
 * never the stamp's alone, and a stamp naming another login refuses the
 * approval; a Telegram chat that named no login is an owner path that names
 * none and is no fallback to the owner (a delegated child's, so no link is
 * opened as the owner); a login's own MCP connection is stamped (how it came
 * in, and whether it spends on the owner's provider keys) and restored, so an
 * approved call of a member's MCP turn still spends nothing on the owner's
 * keys (ownerKeysOff) and is never read as the owner's own stdio path. A turn
 * that answered no login keeps the workspaces its assistant still runs in,
 * and the Moderator seats the stamp named there; it runs as the actor the
 * turn ran as (the stamp's), never the approving path's. A turn in a public
 * link's scope is stamped with no scope and marked (`link`): rebuilding a
 * link's scope needs its share and its served list as they are now, which
 * the approval does not hold, so only the owner may approve such a call,
 * and it runs in no scope, as before the stamp.
 *
 * Second lows round (lows-approvals-2): a peer's connection that named no
 * login names none at approval either, whatever asker its row got from its
 * session (L1: no link is opened as that login); a stamp of an MCP
 * connection by a way in this code does not know refuses the approval (L4);
 * the connection's key, peer and OAuth client id are stamped and restored
 * for the app data log, and the restored connection says it is an
 * approval's (`approval`), so app_data_write says why it does not run (L7).
 */
import {
  asSystem,
  assistantWorkspaceIds,
  currentActor,
  currentRequestMode,
  liveWorkspaceIds,
  loginScopeFor,
  scopeHasArea,
  scopeHoldsAdmin,
  SCOPE_AREAS,
  withoutLeftScope,
  withTurnScope,
  type PendingOrigin,
  type PendingToolCall,
  type WorkspaceScope,
} from '@mantle/db';
import { currentWorkspaceScope, turnScopeWrites } from '@mantle/db/viewer';
import type { ToolHandlerContext } from './types';

/** What the approval reads off the stamp: the scope to judge and run the
 *  call in, how to enter it, the Admin view it may not exceed, the surface
 *  it was asked on, and what the asker lost since (the audit row names it). */
export type OriginRun = Readonly<{
  scope: WorkspaceScope | null;
  enter: 'turn' | null;
  /** The scope is entered in write mode (a login's: see originRunFor). */
  writes: boolean;
  /** The Admin view the call may not exceed (the stamp's). */
  adminCap: Readonly<{ holds: boolean; areas: readonly string[] }> | null;
  surface: ToolHandlerContext['surface'];
  /** What the asker had when it asked and has no more: `workspaces`,
   *  `moderator` (filled here); `admin`, `areas` (filled by the re-check,
   *  inside the scope). Empty: nothing. */
  narrowed: string[];
}>;

/** The refusal of an approval whose asker holds none of the workspaces the
 *  call was asked in any more (or a turn that answered no login whose
 *  workspace is gone). */
export const PENDING_SCOPE_LOST_ERROR =
  'The person who asked for this call no longer has the workspace it was asked in, so it does not run: reject it, or ask them to ask again.';

/** The start of the refusal of an approval the re-check refuses: the call
 *  no longer passes where it was asked; the gate's own words follow. */
export const PENDING_RECHECK_ERROR =
  'This call no longer passes the checks of the workspace it was asked in, so it does not run: ';

/** The refusal of an approval of a stamped call whose surface names a login
 *  other than its asker (lows round, 6c L2): the call would run as someone
 *  it was not asked by. */
export const PENDING_SURFACE_LOGIN_ERROR =
  'This call’s record names a different person than the one who asked for it, so it does not run: reject it.';

/** The refusal of an approval of a call stamped on a login's own MCP
 *  connection that came in by a way this code does not know (lows round 2,
 *  L4): its Write switch and its keys rule cannot be restored, so it does
 *  not run rather than run without them. */
export const PENDING_SURFACE_MCP_ERROR =
  'This call was asked on a connection this server cannot restore, so it does not run: reject it, or ask them to ask again.';

/** The ids of a login's own MCP connection the app data log names it by
 *  (lows round 2, L7). */
const MCP_IDS = ['keyId', 'peerId', 'oauthClientId'] as const;

/** The connection ids of `mcp` that are non-empty strings, by name. */
function mcpIds(mcp: Record<string, unknown>): { [K in (typeof MCP_IDS)[number]]?: string } {
  const out: { [K in (typeof MCP_IDS)[number]]?: string } = {};
  for (const k of MCP_IDS) {
    const v = mcp[k];
    if (typeof v === 'string' && v !== '') out[k] = v;
  }
  return out;
}

/** The stamp's surface: its kind, an owner path's via, the login it names,
 *  and a login's own MCP connection by how it came in, whether it spends
 *  on the owner's keys (6c L3) and the key, peer or OAuth client id its app
 *  data log names (lows round 2, L7); never a chat or account id, a role or
 *  its Write switch. */
function stampSurface(surface: ToolHandlerContext['surface']): PendingOrigin['surface'] {
  if (!surface) return null;
  const s = surface as { kind: string; via?: unknown; loginId?: unknown; mcp?: unknown };
  const mcp = s.mcp as
    ({ via?: unknown; ownerKeysOff?: unknown } & Record<string, unknown>) | undefined;
  return {
    kind: s.kind,
    ...(typeof s.via === 'string' ? { via: s.via } : {}),
    ...(typeof s.loginId === 'string' && s.loginId !== '' ? { loginId: s.loginId } : {}),
    ...(mcp && typeof mcp.via === 'string'
      ? {
          mcp: {
            via: mcp.via,
            ...mcpIds(mcp),
            ...(mcp.ownerKeysOff === true ? { ownerKeysOff: true } : {}),
          },
        }
      : {}),
  };
}

/** The Admin areas the current scope may do (scopeHasArea), in order. */
async function scopeAreas(): Promise<string[]> {
  const out: string[] = [];
  for (const area of SCOPE_AREAS) if (await scopeHasArea(area)) out.push(area);
  return out;
}

/**
 * The stamp of a call queued now, from the scope the queuing turn runs in
 * (A5 step 6c, 0288). Asked by every path that queues a turn's call: the
 * tool loop's (execute-call.ts) and the agent queue helpers (pending-queue.ts,
 * the Toolsmith's group tools).
 */
export async function pendingOriginNow(
  surface: ToolHandlerContext['surface'],
): Promise<PendingOrigin> {
  const ws = currentWorkspaceScope();
  const base = { v: 1 as const, surface: stampSurface(surface) };
  const empty = { ...base, scope: null, enter: null, writes: false, admin: null } as const;
  if (ws?.kind === 'link') return { ...empty, link: true, actor: stampActor() };
  if (!ws) return { ...empty, actor: stampActor() };
  const holds = await scopeHoldsAdmin();
  return {
    ...base,
    scope: {
      kind: ws.kind,
      loginId: ws.loginId,
      ws: [...ws.ws],
      modWs: [...ws.modWs],
    },
    enter: 'turn',
    writes: currentRequestMode()?.writes === true,
    admin: { holds, areas: holds ? await scopeAreas() : [] },
    actor: stampActor(),
  };
}

/** The actor the queuing turn runs as, as the stamp keeps it: an
 *  assistant's, a login's, the system's; any other (a link, a contact, a
 *  peer) or none: null. */
function stampActor(): PendingOrigin['actor'] {
  const a = currentActor();
  if (!a) return null;
  if (a.kind === 'assistant') return { kind: 'assistant', agentId: a.agentId };
  if (a.kind === 'login') return { kind: 'login', mode: a.mode, loginId: a.loginId };
  if (a.kind === 'system') {
    return { kind: 'system', reason: a.reason, ...(a.mode ? { mode: a.mode } : {}) };
  }
  return null;
}

/** How a stamped MCP connection came in, as a channel names it. */
const MCP_VIAS: ReadonlySet<string> = new Set(['oauth', 'peer', 'key']);

/**
 * The surface a stamped call is judged and run on: the stamp's, its login
 * the row's asker (6c L2: a stamp naming another login refuses; a row with
 * no asker keeps a stamp's login only when it is the brain owner's). A
 * Telegram chat's is an owner path naming its login (the chat id is not
 * stamped, so no tool may send into it at approval); one that named no
 * login is a delegated child's path, never the owner's own (6c L1: no link
 * is opened as the owner). A login's own MCP connection comes back with
 * its Write off, marked an approval's, with its ownerKeysOff and its ids
 * as stamped (6c L3, lows round 2 L7); one by a way in this code does not
 * know refuses (L4). A peer's connection that named no login (a peer an
 * Admin login did not register for the anchor) names none here either,
 * whatever asker its row got from its session (L1): as on the connection,
 * no link is opened as that login. None: none.
 */
function runSurface(
  ownerId: string,
  stamp: PendingOrigin['surface'],
  asker: string | null,
  refuse: (message: string) => Error,
): ToolHandlerContext['surface'] {
  if (!stamp) return undefined;
  if (stamp.mcp && !MCP_VIAS.has(stamp.mcp.via)) throw refuse(PENDING_SURFACE_MCP_ERROR);
  const stamped = stamp.loginId ? stamp.loginId.toLowerCase() : null;
  // A peer's connection that named no login keeps naming none (L1).
  const peerNamedNone = !stamped && stamp.mcp?.via === 'peer';
  let loginId: string | null;
  if (asker) {
    if (stamped && stamped !== asker.toLowerCase()) throw refuse(PENDING_SURFACE_LOGIN_ERROR);
    loginId = stamped ? stamp.loginId! : peerNamedNone ? null : asker;
  } else {
    if (stamped && stamped !== ownerId.toLowerCase()) throw refuse(PENDING_SURFACE_LOGIN_ERROR);
    loginId = stamp.loginId ?? null;
  }
  const named = loginId ? { loginId } : {};
  if (stamp.kind === 'telegram') {
    return { kind: 'owner', via: loginId ? 'pending' : 'delegate', ...named };
  }
  const mcp = stamp.mcp
    ? {
        mcp: {
          via: stamp.mcp.via as 'oauth' | 'peer' | 'key',
          write: false,
          ...mcpIds(stamp.mcp as Record<string, unknown>),
          ...(stamp.mcp.ownerKeysOff ? { ownerKeysOff: true } : {}),
          approval: true,
        },
      }
    : {};
  const { loginId: _stampLogin, mcp: _stampMcp, ...rest } = stamp;
  return { ...rest, ...named, ...mcp } as ToolHandlerContext['surface'];
}

/** `a` met with `b`, in `a`'s order, lower case. */
function meet(a: readonly string[], b: readonly string[]): string[] {
  const keep = new Set(b.map((v) => v.toLowerCase()));
  return a.map((v) => v.toLowerCase()).filter((v) => keep.has(v));
}

/**
 * The scope an approval judges and runs a stamped call in: the stamp met
 * with its asker's rights now (see the module comment). Throws
 * PENDING_SCOPE_LOST_ERROR's refusal (`refuse`) when no workspace is left.
 */
export async function originRunFor(
  ownerId: string,
  origin: PendingOrigin,
  row: Pick<PendingToolCall, 'agentId' | 'loginId'>,
  refuse: (message: string) => Error,
): Promise<OriginRun> {
  const surface = runSurface(ownerId, origin.surface, row.loginId, refuse);
  const stamped = origin.scope;
  if (!stamped) {
    return { scope: null, enter: null, writes: false, adminCap: null, surface, narrowed: [] };
  }
  // A turn that answered no login holds what its assistant still runs in:
  // the stamp's workspace while the assistant is still of it and it is
  // live, and the Moderator seats the stamp named there (no login of its
  // own to lose them). Without an asking agent: the stamp's live ones.
  let now: { ws: readonly string[]; modWs: readonly string[] };
  if (stamped.loginId) {
    now = await loginScopeFor(stamped.loginId);
  } else {
    const live = row.agentId
      ? await assistantWorkspaceIds(ownerId, row.agentId, stamped.ws)
      : await liveWorkspaceIds(ownerId, stamped.ws);
    now = { ws: live, modWs: live };
  }
  const ws = meet(stamped.ws, now.ws);
  const modWs = meet(meet(stamped.modWs, now.modWs), ws);
  if (ws.length === 0) throw refuse(PENDING_SCOPE_LOST_ERROR);
  const narrowed: string[] = [];
  if (ws.length < stamped.ws.length) narrowed.push('workspaces');
  if (modWs.length < stamped.modWs.length) narrowed.push('moderator');
  return {
    scope: Object.freeze({
      kind: stamped.kind,
      loginId: stamped.loginId ? stamped.loginId.toLowerCase() : null,
      ws,
      modWs,
    }),
    // A stamp from before arch A7 may say `gate` (the rollback switch's
    // gate scope, gone): it runs in a turn scope of the met scope, as every
    // stamp does now, never on the system pool.
    enter: 'turn',
    // An approved call of a login is that login's write request in the
    // asked scope: it writes as a login's mutating request does there (the
    // login write gateway, the scope on its transactions, the database's
    // checks against it), as the asking turn's own writes do (the one rule,
    // turnScopeWrites). A turn that answered no login keeps its own mode:
    // it wrote only when it acted for the owner (the Admin assistant).
    writes: turnScopeWrites({ loginId: stamped.loginId }, origin.writes),
    adminCap: origin.admin
      ? Object.freeze({ holds: origin.admin.holds, areas: Object.freeze([...origin.admin.areas]) })
      : null,
    surface,
    narrowed,
  };
}

/**
 * Run `fn` in the scope `run` names, whatever scope the approving path runs
 * in: it leaves that one for the system pool (`pending-approval`, a named
 * exit) and enters the asked scope at once, as the asking turn held it (a
 * turn scope, an Admin turn's with its writes). A call asked in no scope runs in none, as it was
 * asked, and no scope the approving path left is kept for it (a turn the
 * call starts never answers the approver). `fn` binds its own actor: the
 * exit's is the system's.
 */
export function withOriginScope<T>(run: OriginRun, fn: () => Promise<T>): Promise<T> {
  const scope = run.scope;
  const inner = (): Promise<T> => {
    if (!scope) return fn();
    // `writes` is turnScopeWrites's answer (originRunFor): the asking
    // turn's own rule.
    return withTurnScope(scope, fn, run.writes ? { writes: true } : {});
  };
  return asSystem(() => withoutLeftScope(inner), 'pending-approval');
}
