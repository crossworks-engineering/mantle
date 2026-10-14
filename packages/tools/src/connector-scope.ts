/**
 * A connector tool in a workspace scope (workspaces W4b, plan section 6):
 * the connector must be a resource of the scope's workspace, and a tool
 * not marked read-only needs that resource's Write tick AND the asking login
 * a Moderator there; a stale mark is refused; a link scope holds no
 * workspace, so it reaches no connector.
 *
 * Since A5 step 6a (carried L1) this is a gate narrower (`connector`,
 * gate-narrowers.ts), so a tool loop's listing (turnListedTools) and its
 * call read the same rule: what the scope may not call is not offered. The
 * caller carries what the rule reads (`facts.connector`, loaded by
 * gateCallerFor for a connector row in a workspace scope:
 * connectorScopeFacts); connectorScopeRefusal is the rule. A connector whose
 * group is missing, unbound or disabled carries no answer here: dispatch
 * answers it in its own words first, as before.
 *
 * What stays at dispatch: the marked inputs (a read-only mark holds only
 * for the inputs it was marked with), which only a call's arguments show,
 * and, for an owner MCP connection, the whole rule after its own pre-run
 * check (loginConnectorRefused), in the order that surface always had.
 */
import type { Tool, WorkspaceScope } from '@mantle/db';
import { connectorGroupOf, connectorResources, LINK_NO_CONNECTORS } from './external-access';

/** The refusal of a connector that is no resource of the scope's
 *  workspaces. */
export const CONNECTOR_NOT_HELD_ERROR =
  "This connector is not one of this workspace's resources, so its tools do not run here.";

/** The refusal of a connector tool that can change data without its Write
 *  tick and a Moderator. */
export const CONNECTOR_WRITE_ERROR =
  'This connector tool can change data: it needs the connector’s Write switched on in this workspace, and the person asking to be a Moderator here.';

/** The refusal of a connector tool whose read-only mark went stale. */
export const CONNECTOR_STALE_MARK_ERROR =
  'This connector tool changed after an admin marked it read-only; it runs again once an admin marks it again.';

/** What the connector rule reads of a scope (a caller's `facts.connector`). */
export type ConnectorScopeFacts = Readonly<{
  /** The connector group's slug. */
  group: string;
  /** The group exists, is bound to its server and enabled: only then does
   *  the rule answer (dispatch answers a missing or disabled one). */
  usable: boolean;
  /** The scope is a link's: it holds no workspace. */
  link: boolean;
  /** The resource rows of the scope's workspaces that hold the connector. */
  held: readonly Readonly<{ workspaceId: string; write: boolean }>[];
  /** The workspaces of the scope where its login is a Moderator. */
  modWs: readonly string[];
}>;

/** What the rule reads for `row` (a connector's) in `scope`. */
export async function connectorScopeFacts(
  ownerId: string,
  row: Pick<Tool, 'handler'>,
  scope: WorkspaceScope,
): Promise<ConnectorScopeFacts | null> {
  const group = await connectorGroupOf(ownerId, row);
  if (!group) {
    const slug = (row.handler as { group?: unknown }).group;
    if (typeof slug !== 'string') return null;
    return Object.freeze({ group: slug, usable: false, link: false, held: [], modWs: [] });
  }
  const link = scope.kind === 'link';
  const held = group.usable && !link ? await connectorResources(ownerId, group.slug, scope.ws) : [];
  return Object.freeze({
    group: group.slug,
    usable: group.usable,
    link,
    held: Object.freeze(held.map((r) => Object.freeze({ ...r }))),
    modWs: Object.freeze([...scope.modWs]),
  });
}

/** Why the scope may not call a connector tool with this `mark`, or null:
 *  a link, a connector no workspace of the scope holds, a stale mark, a
 *  write without the Write tick and a Moderator. Input-free (the marked
 *  inputs are dispatch's). Null for a group the rule does not answer. */
export function connectorScopeRefusal(
  facts: ConnectorScopeFacts,
  mark: 'read' | 'write' | 'stale',
): string | null {
  if (!facts.usable) return null;
  if (facts.link) return LINK_NO_CONNECTORS;
  if (facts.held.length === 0) return CONNECTOR_NOT_HELD_ERROR;
  if (mark === 'stale') return CONNECTOR_STALE_MARK_ERROR;
  if (mark === 'read') return null;
  const mod = new Set(facts.modWs);
  return facts.held.some((r) => r.write && mod.has(r.workspaceId)) ? null : CONNECTOR_WRITE_ERROR;
}

/** What an approval of a connector write the asking scope may not make
 *  itself says (owner decision 1a, A5 step 6d): it runs with the rights of
 *  whoever approves it, an Admin user's. */
export const CONNECTOR_ELEVATED_REASON =
  'The person asking cannot make this connector write themselves (the connector’s Write is off in their workspace, or they are not a Moderator there): approved, it runs with Admin rights.';

/** What a call queued for approval carries when it would run with more
 *  rights than its scope has (pending_tool_calls.elevated, 0287). */
export type ElevatedApproval = Readonly<{ elevated: true; reason: string }>;

/**
 * The facts of `facts` with the connector write's own rule lifted (owner
 * decision 1a, A5 step 6d): every workspace of the scope that holds the
 * connector holds it with its Write tick, the login a Moderator there. The
 * rest of the rule stands: a link, a connector the scope does not hold, a
 * stale mark. Read only for a call that waits for an approver (a
 * requires_confirm tool, or a turn whose writes wait: client-sourced), whose
 * approval runs it with the approver's rights; a call that would run
 * directly never reads it.
 */
export function elevatedConnectorFacts(facts: ConnectorScopeFacts): ConnectorScopeFacts {
  return Object.freeze({
    ...facts,
    held: Object.freeze(facts.held.map((r) => Object.freeze({ ...r, write: true }))),
    modWs: Object.freeze([...new Set([...facts.modWs, ...facts.held.map((r) => r.workspaceId)])]),
  });
}
