/**
 * Every narrower of the one gate (@mantle/db gate.ts, step 4; arch A3c fix
 * round 2, M-A), registered from here: @mantle/tools is the package every
 * process that dispatches a tool already loads (server/web, server/api and
 * its workers, the stdio MCP server through @mantle/mcp-core), so none of
 * them fails closed for a narrower it never loaded.
 *
 * Each narrower reads the caller, the declared policy and the ref: what a
 * tool is comes from its policy (the builtins' and the MCP definitions'
 * ToolPolicy, through @mantle/mcp-core gate-policy.ts; runtime-policy.ts
 * the runtime rows'; member-app-tools.ts an app tool's from the live
 * member-app rule). No rule is copied here, and none is keyed by a name.
 *
 * Each process main calls ensureGateReady() at boot, so a missing narrower
 * shows there, not at the first call.
 */
import {
  READ_ONLY_CALLER_ERROR,
  assertGateReady,
  hasPolicySource,
  registerNarrower,
  type GateCaller,
  type Narrower,
  type NarrowerName,
  type PolicyRef,
} from '@mantle/db';
import { registerPreRunChecks } from './gate-prerun';
import { registerToolCallAudit } from './call-audit';
import { connectorScopeRefusal, type ConnectorScopeFacts } from './connector-scope';
import { OWNER_ONLY_ERROR } from './surface';
import { policySpendsOwnerKey } from './tool-policy';
// The `tool` source (a builtin called through dispatch, A5 step 3a) and the
// runtime rows' sources, registered with the narrowers in every process.
import './tool-gate-policy';
import './runtime-policy';

/** The refusal of a tool outside a key's areas. */
export const KEY_AREA_ERROR = 'This API key is limited to areas this tool is not in.';
/** A connector row judged against the facts loaded for another connector
 *  group (A5 step 6a fix round 1, LOW-5): never judged, refused. */
export const CONNECTOR_FACTS_MISMATCH_ERROR =
  "This connector call was checked against another connector's rules, so it doesn't run.";

/** The refusal of a risky tool the owner did not name on a key or a peer. */
export const RISKY_TOOL_ERROR =
  'This tool sends outside the brain, spends or hands out access: the owner did not name it on this key or linked brain.';

/** The refusal of a tool that spends on the owner's keys outside Admin. */
export const OWNER_KEYS_ERROR =
  "This tool spends on the brain owner's provider keys, which only a user of the Admin workspace may do.";

/** The refusal of a call a team-rules app run makes outside an app tool. */
export const TEAM_APP_NO_TOOL_ERROR =
  "This tool can't be used from a team app: a team app runs only the tools it declares.";

/** Whether the caller is narrowed like a peer: an API key or a peer (the
 *  login's own OAuth consent is not). */
function narrowedCaller(caller: GateCaller): boolean {
  return caller.via === 'key' || caller.via === 'peer';
}

/** Whether `ref` names a tool (an MCP tool, a builtin called through
 *  dispatch, or a runtime tool row), as the peer rule reads it. */
function toolRef(ref: PolicyRef): boolean {
  return ref.kind === 'mcp-tool' || ref.kind === 'tool' || ref.kind === 'runtime-tool';
}

/** Whether `policy` is a connector tool's (connectorToolPolicy: it carries
 *  the admin's read-only `mark`). */
function connectorPolicy(policy: { fields?: Readonly<Record<string, unknown>> }): boolean {
  return policy.fields?.mark !== undefined;
}

/** Whether the caller is an MCP connection (the login's own OAuth, a key
 *  or a peer): the surface the owner-keys rule is for. */
function mcpConnection(caller: GateCaller): boolean {
  return caller.via === 'oauth' || narrowedCaller(caller);
}

/** A key's areas (null: every area): the policy's key area must be one of
 *  them (a policy with none is open only to an all-areas key). A policy
 *  about the key itself (`keySelf`: the whoami route) is open to every
 *  key, as keyMayCall answers (server/web lib/api-v1.ts; pinned against it
 *  for every v1 row by route-policy.test.ts, with the areas set on the
 *  caller by hand). The tools' policies carry their key area; A4's route
 *  rows carry their own, but on HTTP this narrows nothing yet: the gate's
 *  HTTP caller (server/web gate.ts httpCaller) sets no `facts.keyAreas`,
 *  so a key's areas there are judged by gateAccessKey and the login
 *  lookup's findKeyLogin (both keyOnRow, keyMayCall), not here. */
const keyNarrower: Narrower = (caller, policy) => {
  const areas = (caller.facts?.keyAreas ?? null) as readonly string[] | null;
  if (!narrowedCaller(caller) || areas === null) return null;
  if (policy.fields?.keySelf === true) return null;
  const area = (policy.fields?.keyArea ?? null) as string | null;
  return area !== null && areas.includes(area) ? null : KEY_AREA_ERROR;
};

/**
 * A key's or a peer's risky tools and Write switch, on a tool, from what its
 * policy declares (A5 step 2): the rule the MCP listing ran by name
 * (ownerPeerAllows, deleted in A5 step 6a), read from the policy, never
 * from a list keyed by name. A risky tool (`fields.peerRisky`) the owner did not name on the key
 * or the peer is refused; with Write off, a tool that is not a read is.
 * Pinned against the listing by gate-policy.test.ts, and for every tool and
 * every key and peer caller by tool-policy-sweep.test.ts.
 *
 * Fail closed: a tool whose policy declares no peer mark (no boolean
 * `fields.peerRisky`: a runtime row type no key or peer reaches today) is
 * refused for a key or a peer, whatever the owner named.
 *
 * A connector's tool (its policy carries the admin's read-only `mark`) is
 * judged by its effect like any tool (A5 step 5, owner decision Q1 b): one
 * an Admin marked read-only reads, so a read-only key or peer lists and
 * calls it, as a read-only OAuth login does. A stale mark is a write
 * (connectorToolPolicy), so it stays hidden. The connector's own checks
 * (the marked inputs, loginConnectorRefused) and the key areas (a
 * connector has none: only an all-areas key reaches it) still apply.
 */
const peerNarrower: Narrower = (caller, policy, ref) => {
  if (!narrowedCaller(caller) || !toolRef(ref)) return null;
  const declared = policy.fields?.peerRisky;
  if (typeof declared !== 'boolean') return RISKY_TOOL_ERROR;
  // A connector's tool is not risky by the owner MCP surface's family rule
  // (no family holds an mcp_* name), which it declares on its row. In a
  // process without that surface (no `mcp-tool` source: server/api), the
  // answer before A5 step 2 holds: risky unless the owner named it (fail
  // closed; A5 step 2 fix round 1, LOW-4).
  const risky = declared || (connectorPolicy(policy) && !hasPolicySource('mcp-tool'));
  const riskyAllowed = (caller.facts?.riskyAllowed ?? []) as readonly string[];
  if (risky && !riskyAllowed.includes(ref.name)) return RISKY_TOOL_ERROR;
  return caller.write === false && policy.effect !== 'read' ? READ_ONLY_CALLER_ERROR : null;
};

/**
 * The member-app rule, fail closed (fix round 2, M-B): a run at team rules
 * (`facts.appRules === 'team'`) calls only an app tool (ref kind
 * `app-tool`, member-app-tools.ts appToolGatePolicy), and only when the
 * policy carries the live rule's answer and that answer allows it
 * (`fields.memberApp` null). A refusal says the rule's own words; any other
 * ref, or a policy with no answer, is refused. Pinned against
 * memberAppToolVerdict itself (member-app-parity.test.ts).
 *
 * An app tool whose verdict refused it is refused in the verdict's words at
 * every rules (A5 step 3b): the brokers' refusals (an admin's run, a
 * contact's, a member's) are the gate's narrowed 403 (appToolRefusal,
 * app-tool-level.ts). Every other caller passes.
 */
const memberAppNarrower: Narrower = (caller, policy, ref) => {
  const verdictRefused = ref.kind === 'app-tool' ? policy.fields?.memberApp : null;
  if (typeof verdictRefused === 'string') return verdictRefused;
  if (caller.facts?.appRules !== 'team') return null;
  if (ref.kind !== 'app-tool') return TEAM_APP_NO_TOOL_ERROR;
  const answer = policy.fields?.memberApp;
  if (answer === null) return null;
  return typeof answer === 'string' ? answer : TEAM_APP_NO_TOOL_ERROR;
};

/** Spending on the owner's keys, on an MCP connection: only a scope that
 *  holds Admin (an unscoped caller keeps its own rules). A workspace
 *  assistant's turn keeps its own rules (the member turn ledger), as today:
 *  it is not narrowed here; its delegated child is not given such a tool at
 *  all, by the same predicate (policySpendsOwnerKey, workspaceChildDrop). */
const spendingNarrower: Narrower = (caller, policy) =>
  mcpConnection(caller) && policySpendsOwnerKey(policy) && caller.admin && !caller.admin.holdsAdmin
    ? OWNER_KEYS_ERROR
    : null;

/**
 * An owner-only tool off the owner's surface (client logins C4; A5 step 6a,
 * carried L1): the policy says `ownerOnly` (the `tool` source, by the
 * builtin's handler ref), and the call's surface is not the owner's (a team
 * or contact surface, or none: `facts.ownerSurface` false, set by
 * gateCallerFor from the call or the loop that lists). Before step 6a
 * dispatch refused it before the gate, so a tool loop listed it and the
 * call was refused; first in the order, it answers the same calls in the
 * same words. A caller that does not say (an MCP connection, whose surface
 * is the owner's) is not narrowed. A tool whose policy also says
 * `loginTurns` (the app tools) is not narrowed on a login's workspace turn
 * either (`facts.loginTurn`, gateCallerFor: a team surface naming the login
 * its turn scope answers): the turn's scope and the database decide, as on
 * the login's own MCP connection (owner rule 2026-10-26: a user's agents may
 * write what the user may, never more).
 */
const ownerOnlyNarrower: Narrower = (caller, policy) =>
  policy.fields?.ownerOnly === true &&
  caller.facts?.ownerSurface === false &&
  !(policy.fields?.loginTurns === true && caller.facts?.loginTurn === true)
    ? OWNER_ONLY_ERROR
    : null;

/**
 * A connector tool the workspace scope may not call (W4b; A5 step 6a,
 * carried L1): connector-scope.ts connectorScopeRefusal, on what
 * gateCallerFor loaded for the row (`facts.connector`: the scope's resource
 * rows for its group, its Moderator workspaces). Last in the order: before
 * step 6a dispatch judged it after the gate. A caller with no such facts (an
 * MCP connection: its own pre-run check and dispatch judge it; outside a
 * workspace scope) is not narrowed here. Facts loaded for another group
 * than the row's are refused (fail closed, fix round 1, LOW-5): they say
 * nothing about this row's workspaces.
 */
const connectorNarrower: Narrower = (caller, policy, ref) => {
  const facts = caller.facts?.connector as ConnectorScopeFacts | undefined;
  const mark = policy.fields?.mark;
  if (!facts || ref.kind !== 'runtime-tool') return null;
  if (mark !== 'read' && mark !== 'write' && mark !== 'stale') return null;
  const row = ref.row as { handler?: { group?: unknown } } | undefined;
  if (row?.handler?.group !== facts.group) return CONNECTOR_FACTS_MISMATCH_ERROR;
  return connectorScopeRefusal(facts, mark);
};

/** The member turn caps: an explicit no-op until A5. TODO(A5): the caps
 *  are the member turn ledger (claimMemberTurn, a daily count and tokens
 *  per member turn, packages/content/src/member-turn-ledger.ts), claimed
 *  once per turn by workspace-turn.ts, not per tool call; A5 decides
 *  whether a call checks the claim here. */
const turnCapsNarrower: Narrower = () => null;

/** Every narrower of NARROWERS but the gate's own read-only one. */
export const GATE_NARROWERS: Readonly<Record<Exclude<NarrowerName, 'read-only'>, Narrower>> =
  Object.freeze({
    'owner-only': ownerOnlyNarrower,
    key: keyNarrower,
    peer: peerNarrower,
    'member-app': memberAppNarrower,
    spending: spendingNarrower,
    'turn-caps': turnCapsNarrower,
    connector: connectorNarrower,
  });

/** Register every narrower, the pre-run checks (gate-prerun.ts) and how a
 *  tool call is audited (call-audit.ts, A5 step 6d); the same functions
 *  again are a no-op. */
export function registerGateNarrowers(): void {
  for (const [name, narrower] of Object.entries(GATE_NARROWERS)) {
    registerNarrower(name as NarrowerName, narrower);
  }
  registerPreRunChecks();
  registerToolCallAudit();
}

/** Boot: register every narrower and assert the gate is ready. Each process
 *  main calls it. Throws GateNotReadyError naming what is missing: every
 *  HTTP request a route of the manifest answers runs through enterCall
 *  (A4 step 1), so a gate that is not ready stops the boot, never the first
 *  request. */
export function ensureGateReady(): void {
  registerGateNarrowers();
  assertGateReady();
}

registerGateNarrowers();
