/**
 * The scope a pending call was asked in, and the scope its approval judges
 * and runs it in (workspaces arch A5 step 6c, the approval re-check; 0288).
 *
 * At queue time (pendingOriginNow) the server stamps the row with the
 * asking turn's scope whole: its login, its workspaces and Moderator
 * workspaces, how the turn held it (a turn scope, or the rollback switch's
 * gate scope), whether it wrote as an Admin turn, the Admin view it had
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
 */
import {
  asSystem,
  currentGateScope,
  currentRequestMode,
  liveWorkspaceIds,
  loginHasArea,
  loginScopeFor,
  scopeHasArea,
  scopeHoldsAdmin,
  SCOPE_AREAS,
  withGateScope,
  withoutLeftScope,
  withTurnScope,
  withTurnStamp,
  type PendingOrigin,
  type WorkspaceScope,
} from '@mantle/db';
import { currentWorkspaceScope } from '@mantle/db/viewer';
import type { ToolHandlerContext } from './types';

/** What the approval reads off the stamp: the scope to judge and run the
 *  call in, how to enter it, the Admin view it may not exceed, the surface
 *  it was asked on, and what the asker lost since (the audit row names it). */
export type OriginRun = Readonly<{
  scope: WorkspaceScope | null;
  enter: 'turn' | 'gate' | null;
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

/** The stamp's surface: its kind, an owner path's via, the login it names;
 *  never a chat or account id. */
function stampSurface(surface: ToolHandlerContext['surface']): PendingOrigin['surface'] {
  if (!surface) return null;
  const s = surface as { kind: string; via?: unknown; loginId?: unknown };
  return {
    kind: s.kind,
    ...(typeof s.via === 'string' ? { via: s.via } : {}),
    ...(typeof s.loginId === 'string' && s.loginId !== '' ? { loginId: s.loginId } : {}),
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
  const gate = ws ? null : currentGateScope();
  const held = ws ?? gate;
  const base = { v: 1 as const, surface: stampSurface(surface) };
  if (!held || held.kind === 'link') {
    return { ...base, scope: null, enter: null, writes: false, admin: null };
  }
  let admin: PendingOrigin['admin'];
  if (ws) {
    const holds = await scopeHoldsAdmin();
    admin = { holds, areas: holds ? await scopeAreas() : [] };
  } else {
    // The rollback switch's gate scope: the scope answers Admin, the login
    // its own areas (gate-callers.ts readAdminView).
    const holds = await withTurnScope(held, () => scopeHoldsAdmin());
    const areas: string[] = [];
    if (holds && held.loginId) {
      for (const area of SCOPE_AREAS) if (await loginHasArea(held.loginId, area)) areas.push(area);
    }
    admin = { holds, areas };
  }
  return {
    ...base,
    scope: {
      kind: held.kind,
      loginId: held.loginId,
      ws: [...held.ws],
      modWs: [...held.modWs],
    },
    enter: ws ? 'turn' : 'gate',
    writes: ws ? currentRequestMode()?.writes === true : false,
    admin,
  };
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
  refuse: (message: string) => Error,
): Promise<OriginRun> {
  const surface = (origin.surface ?? undefined) as ToolHandlerContext['surface'];
  const stamped = origin.scope;
  if (!stamped) {
    return { scope: null, enter: null, writes: false, adminCap: null, surface, narrowed: [] };
  }
  const now = stamped.loginId
    ? await loginScopeFor(stamped.loginId)
    : { ws: await liveWorkspaceIds(ownerId, stamped.ws), modWs: [] as string[] };
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
    enter: origin.enter,
    writes: origin.writes,
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
 * turn scope, an Admin turn's with its writes; the rollback switch's gate
 * scope with its stamp). A call asked in no scope runs in none, as it was
 * asked, and no scope the approving path left is kept for it (a turn the
 * call starts never answers the approver). `fn` binds its own actor: the
 * exit's is the system's.
 */
export function withOriginScope<T>(run: OriginRun, fn: () => Promise<T>): Promise<T> {
  const scope = run.scope;
  const inner = (): Promise<T> => {
    if (!scope) return fn();
    if (run.enter === 'gate') {
      return withTurnStamp(
        { workspaceId: scope.ws.length === 1 ? scope.ws[0]! : null, loginId: scope.loginId },
        () => withGateScope(scope, fn),
      );
    }
    return withTurnScope(scope, fn, run.writes ? { writes: true } : {});
  };
  return asSystem(() => withoutLeftScope(inner), 'pending-approval');
}
