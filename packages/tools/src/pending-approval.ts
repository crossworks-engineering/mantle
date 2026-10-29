/**
 * Who may approve a pending call, and with whose rights it then runs. The
 * one place this rule lives:
 * approvePendingCall (pending.ts) asks it on every path that approves (the
 * web's /api/pending, MCP pending_approve, a Telegram card's tap), so no
 * surface judges an approval itself.
 *
 * A call queued with more rights than its asker's scope
 * (pending_tool_calls.elevated: a connector write the asking scope may not
 * make itself, its Write tick off or the asker no Moderator there):
 *  - its asker (login_id) never approves it, on any path;
 *  - the brain owner (the anchor login) approves it, and it runs with the
 *    owner's rights: the connector's write rule passes, the rest of the
 *    connector rule stands (a link, a connector the call's workspace does
 *    not hold, a stale mark);
 *  - any other login approves it only when its OWN scope passes the
 *    connector rule in the workspace the call was asked in (a Moderator
 *    there, the connector's Write on), and it runs with that login's rights.
 * Judged before the row is claimed, by the gate's own steps
 * (gateCallRefusal) with the caller dispatch then runs the call as, so a
 * refused approver leaves the call pending for one who may.
 *
 * In this order: the owner first, so the owner may always approve (even a
 * call it asked itself); then a row that names no asker is the owner's
 * alone, and so is a call whose tool is gone or has no policy, which no
 * gate step can judge.
 *
 * Whoever may approve an elevated call may also reject it
 * (elevatedRejection); its asker may withdraw it (deciderFilter).
 *
 * Every other call keeps its rule of who decides (deciderFilter): a login
 * other than the owner decides only the calls queued for it, and the call
 * runs as its asker. A call stamped with the scope it was asked in
 * (pending_tool_calls.origin, 0288) is judged again before it is claimed
 * (originApproval): the queue-time check, in that scope met with its
 * asker's rights now, and it runs there. A row with no stamp (queued
 * before the stamp existed, or by no turn) is judged by its asker's
 * current rights in the scope of the path that approves.
 */
import {
  elevatedCallWorkspace,
  gateCallRefusal,
  loginActor,
  loginActorNow,
  loginScopeFor,
  runAsActor,
  systemActor,
  type Actor,
  type PendingOrigin,
  type PendingToolCall,
  type ScopeArea,
  type Tool,
  type WorkspaceScope,
} from '@mantle/db';
import { currentWorkspaceScope, scopeLeftForSystem } from '@mantle/db/viewer';
import { defineDomainError } from '@mantle/std';
import { scopeAdminView } from './admin-gate';
import { CONNECTOR_WRITE_ERROR } from './connector-scope';
import { gateCallerFor, pendingCaller, type ToolCaller } from './gate-callers';
import {
  originRunFor,
  PENDING_RECHECK_ERROR,
  withOriginScope,
  type OriginRun,
} from './pending-origin';
import { approvalCallRefusal, gateRefOf } from './turn-listing';

/** The refusal of an elevated call's own asker. */
export const ELEVATED_SELF_APPROVAL_ERROR =
  'You asked for this call and cannot make it yourself, so you cannot approve it: an Admin user (the owner, or someone with write rights on this connector) must approve it.';

/** The refusal of an approver whose own rights do not reach the write. */
export const ELEVATED_APPROVER_ERROR =
  'You do not have write rights on this connector in the workspace that asked: an Admin user (the owner, or a Moderator there with the connector’s Write on) must approve it.';

/** The refusal of an approval that names no one (a scope with no login). */
export const ELEVATED_NO_APPROVER_ERROR =
  'This call needs an Admin user to approve it, and this approval names no one: approve it signed in as the owner or as someone with write rights on this connector.';

/** The refusal of a non-owner's approval of an elevated call that names no
 *  asker: no rule can tell the approver is not the one who asked. */
export const ELEVATED_NO_ASKER_ERROR =
  'This call names no one who asked for it, so only the owner may approve it.';

/** The refusal of an approval of a call asked in a public link's scope by
 *  anyone but the owner: the link's scope is not
 *  rebuilt at approval, so no one else's rights can be told to reach it. */
export const PENDING_LINK_OWNER_ERROR =
  'This call was asked through a public link, so only the owner may approve it.';

/** The refusal of an approval of a stamped call whose tool is gone or
 *  disabled now: no re-check can judge it, and it
 *  never runs by the rule of a call with no stamp. */
export const PENDING_NO_TOOL_ERROR =
  'This call’s tool is gone or disabled, so it cannot be checked again where it was asked and does not run: reject it, or enable the tool and approve it again.';

/** The refusal of an approval that claimed a stamped call it had not
 *  judged: the call is put back, pending. */
export const PENDING_NOT_RECHECKED_ERROR =
  'This call could not be checked again in the workspace it was asked in, so it does not run and is pending again: approve it again, or reject it.';

/** The refusal of a non-owner's approval of an elevated call whose tool is
 *  gone, disabled or has no policy: no gate step can judge it. */
export const ELEVATED_NO_TOOL_ERROR =
  'This call’s tool is gone, disabled or has no policy, so only the owner may decide it.';

/** An approval the rule refuses: the call stays pending. A domain error
 *  (the one table, @mantle/std DOMAIN_ERRORS): the web answers 403 with its
 *  text through app.onError, MCP and Telegram say the message. */
export class ApprovalRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalRefusedError';
  }
}

defineDomainError(ApprovalRefusedError, {
  reason:
    'the approver may not approve this call (its asker, or no write rights on its connector), or the call no longer passes where it was asked (A5 step 6c); the message says why',
  status: 403,
});

/**
 * Who decides on this path: the login of the scope the decision runs in,
 * else the login the path names (a session's, a paired chat's, an MCP
 * connection's), else, with neither (the owner's stdio connection, system
 * work), the brain owner. Null: a scope that names no login.
 */
export function deciderOf(ownerId: string, named?: string | null): string | null {
  const scope = currentWorkspaceScope() ?? scopeLeftForSystem();
  if (scope) return scope.loginId ? scope.loginId.toLowerCase() : null;
  return (named ?? ownerId).toLowerCase();
}

/** Whether `login` is the brain owner (the anchor login: its id is the
 *  brain's). */
export function isBrainOwner(ownerId: string, login: string | null): boolean {
  return login !== null && login.toLowerCase() === ownerId.toLowerCase();
}

/** What an approved elevated call runs with: the caller dispatch runs it
 *  as, and the login whose rights it runs with. */
export type ElevatedRun = Readonly<{
  caller: ToolCaller;
  /** The approving login: the owner, or a login whose scope passed. */
  runAs: string;
  owner: boolean;
}>;

/**
 * Judge the approval of an elevated pending call by `decider` (deciderOf)
 * and give the caller it runs as, or throw ApprovalRefusedError. `input`:
 * the call's arguments and context, as dispatch passes them to the gate.
 */
export async function elevatedApproval(
  ownerId: string,
  row: Pick<PendingToolCall, 'loginId' | 'workspaceId'>,
  /** The call's tool (null: gone or disabled; the approval then records
   *  that, running nothing). */
  tool: Tool | null,
  decider: string | null,
  context: Readonly<Record<string, unknown>>,
): Promise<ElevatedRun> {
  if (decider === null) throw new ApprovalRefusedError(ELEVATED_NO_APPROVER_ERROR);
  // The owner first: the owner may always approve, even a call it
  // asked itself (an owner's own turn is no Moderator of a workspace whose
  // connector Write is off). Anyone else: never its asker, and never a row
  // that names none (no rule can tell it is not the one who asked).
  const owner = isBrainOwner(ownerId, decider);
  if (!owner) {
    if (!row.loginId) throw new ApprovalRefusedError(ELEVATED_NO_ASKER_ERROR);
    if (row.loginId.toLowerCase() === decider) {
      throw new ApprovalRefusedError(ELEVATED_SELF_APPROVAL_ERROR);
    }
  }
  const asked = tool ? gateRefOf(tool) : null;
  // A tool gone, disabled or with no policy: no gate step judges
  // it, so only the owner decides it (the approval then records that the
  // tool is gone, running nothing).
  if (!owner && !asked) throw new ApprovalRefusedError(ELEVATED_NO_TOOL_ERROR);
  const target = (await elevatedCallWorkspace(ownerId, row))?.toLowerCase() ?? null;
  // The workspace the call was asked in, as the approver holds it: the
  // owner's write rule is lifted; anyone else is a Moderator there or not.
  let modWs: string[] = [];
  if (!owner && target) {
    const own = await loginScopeFor(decider);
    if (own.modWs.some((w) => w.toLowerCase() === target)) modWs = [target];
  }
  const connectorScope: WorkspaceScope = {
    kind: 'user',
    loginId: decider,
    ws: target ? [target] : [],
    modWs,
  };
  const caller = pendingCaller({ approver: decider, connectorScope, lifted: owner });
  if (tool && asked) {
    const gate = await gateCallerFor(caller, asked.policy, false, {
      ownerSurface: true,
      ownerId,
      row: tool,
    });
    const refusal = await gateCallRefusal(gate, asked.ref, { context });
    if (refusal) {
      throw new ApprovalRefusedError(
        refusal.toolText === CONNECTOR_WRITE_ERROR ? ELEVATED_APPROVER_ERROR : refusal.toolText,
      );
    }
  }
  return { caller, runAs: decider, owner };
}

/**
 * Whether `decider` may reject the elevated call `row`: whoever may
 * approve it may reject it. The owner always may (a call it could not run
 * still goes); anyone else when elevatedApproval lets it approve. Its asker
 * withdraws its own call by the ordinary rule (deciderFilter), before this
 * is asked.
 */
export async function elevatedRejection(
  ownerId: string,
  row: Pick<PendingToolCall, 'loginId' | 'workspaceId'>,
  tool: Tool | null,
  decider: string | null,
  context: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  if (isBrainOwner(ownerId, decider)) return true;
  try {
    await elevatedApproval(ownerId, row, tool, decider, context);
    return true;
  } catch (err) {
    if (err instanceof ApprovalRefusedError) return false;
    throw err;
  }
}

/** What an approved call stamped with its asked scope runs with: the scope
 *  (OriginRun), the caller dispatch runs it as, and the
 *  actor it is bound to there. */
export type OriginApproval = Readonly<{
  run: OriginRun;
  caller: ToolCaller;
  actor: Actor | null;
}>;

/** What the asker had of Admin when it asked and has no more, read in the
 *  re-checked scope: `admin`, `areas`. */
async function adminNarrowed(run: OriginRun): Promise<string[]> {
  const cap = run.adminCap;
  if (!run.scope || !cap?.holds) return [];
  const now = await scopeAdminView(cap.areas as ScopeArea[]);
  if (!now.holdsAdmin) return ['admin'];
  return cap.areas.every((a) => now.areas.has(a as ScopeArea)) ? [] : ['areas'];
}

/**
 * The approval re-check of a call stamped with the scope it was asked in
 * (pending_tool_calls.origin, 0288), on every path that
 * approves, before the row is claimed: the scope the stamp names met with
 * its asker's rights now (originRunFor: a workspace the asker left, a
 * Moderator seat it lost, are gone; a right it gained since is not the
 * call's), and in it the queue-time check again (approvalCallRefusal: the
 * gate's steps 3 to 5, the narrowers, the item pre-check), with the caller
 * dispatch then runs the call as. A refusal throws ApprovalRefusedError and
 * leaves the call pending, untouched: the asker's rights may come back, and
 * an approver may reject it. Who decides is unchanged (deciderFilter): the
 * re-check judges the call, not the approver.
 *
 * The actor is the asker as it is now; a row with no asker runs as the
 * actor its turn ran as (the stamp's: an assistant's, the owner's for an
 * Admin assistant that answered no one, the system's), never the approving
 * path's. A call asked through a public link is the owner's
 * alone to approve (PENDING_LINK_OWNER_ERROR).
 */
export async function originApproval(
  ownerId: string,
  row: Pick<PendingToolCall, 'loginId' | 'origin' | 'args' | 'agentId'>,
  tool: Tool,
  approver: string | null,
): Promise<OriginApproval | null> {
  const origin = row.origin;
  if (!origin) return null;
  if (origin.link && !isBrainOwner(ownerId, approver)) {
    throw new ApprovalRefusedError(PENDING_LINK_OWNER_ERROR);
  }
  const run = await originRunFor(ownerId, origin, row, (m) => new ApprovalRefusedError(m));
  const actor = row.loginId
    ? await loginActorNow(row.loginId, 'pending:approve')
    : await stampedActor(ownerId, origin.actor, row.agentId);
  const asActor = <T>(fn: () => Promise<T>) => (actor ? runAsActor(actor, fn) : fn());
  const judged = await withOriginScope(run, () =>
    asActor(async () => {
      const narrowed = [...run.narrowed, ...(await adminNarrowed(run))];
      const caller = pendingCaller({ approver, adminCap: run.adminCap, narrowed });
      const refused = await approvalCallRefusal(
        caller,
        tool,
        (row.args ?? {}) as Record<string, unknown>,
        { ownerId, surface: run.surface },
      );
      return { caller, refused };
    }),
  );
  if (judged.refused !== null) {
    throw new ApprovalRefusedError(`${PENDING_RECHECK_ERROR}${judged.refused}`);
  }
  return { run, caller: judged.caller, actor };
}

/** The actor a row with no asker runs as: the one
 *  its turn ran as, as the stamp keeps it. A login is that login now (owner
 *  mode only for the brain owner); with none stamped, the asking assistant. */
async function stampedActor(
  ownerId: string,
  stamped: PendingOrigin['actor'],
  agentId: string | null,
): Promise<Actor> {
  if (stamped?.kind === 'login') {
    // A read-only login stays read only.
    if (stamped.mode === 'ro') return loginActor(stamped.loginId, 'ro');
    const owner = stamped.mode === 'owner' && isBrainOwner(ownerId, stamped.loginId);
    return loginActorNow(stamped.loginId, 'pending:approve', owner ? 'owner' : 'rw');
  }
  if (stamped?.kind === 'system') {
    // A read-only caller's system work stays read only.
    if (stamped.mode === 'ro') return { kind: 'system', reason: stamped.reason, mode: 'ro' };
    return systemActor(stamped.reason);
  }
  if (stamped?.kind === 'assistant') return { kind: 'assistant', agentId: stamped.agentId };
  return { kind: 'assistant', agentId };
}
