/**
 * Who may approve a pending call, and with whose rights it then runs (A5
 * step 6d fix round 1; owner decision 1a). The one place this rule lives:
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
 * Every other call keeps its rule (deciderFilter): a login other than the
 * owner decides only the calls queued for it, and the call runs as its
 * asker.
 */
import {
  elevatedCallWorkspace,
  gateCallRefusal,
  loginScopeFor,
  type PendingToolCall,
  type Tool,
  type WorkspaceScope,
} from '@mantle/db';
import { currentWorkspaceScope, scopeLeftForSystem } from '@mantle/db/viewer';
import { defineDomainError } from '@mantle/std';
import { CONNECTOR_WRITE_ERROR } from './connector-scope';
import { gateCallerFor, pendingCaller, type ToolCaller } from './gate-callers';
import { gateRefOf } from './turn-listing';

/** The refusal of an elevated call's own asker. */
export const ELEVATED_SELF_APPROVAL_ERROR =
  'You asked for this call and cannot make it yourself, so you cannot approve it: an Admin user (the owner, or someone with write rights on this connector) must approve it.';

/** The refusal of an approver whose own rights do not reach the write. */
export const ELEVATED_APPROVER_ERROR =
  'You do not have write rights on this connector in the workspace that asked: an Admin user (the owner, or a Moderator there with the connector’s Write on) must approve it.';

/** The refusal of an approval that names no one (a scope with no login). */
export const ELEVATED_NO_APPROVER_ERROR =
  'This call needs an Admin user to approve it, and this approval names no one: approve it signed in as the owner or as someone with write rights on this connector.';

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
    'the approver may not approve this call (its asker, or no write rights on its connector); the message says who may',
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
  if (row.loginId && row.loginId.toLowerCase() === decider) {
    throw new ApprovalRefusedError(ELEVATED_SELF_APPROVAL_ERROR);
  }
  const owner = isBrainOwner(ownerId, decider);
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
  const asked = tool ? gateRefOf(tool) : null;
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
