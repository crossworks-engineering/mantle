/**
 * Every narrower of the one gate (@mantle/db gate.ts, step 4; arch A3c fix
 * round 2, M-A), registered from here: @mantle/tools is the package every
 * process that dispatches a tool already loads (server/web, server/api and
 * its workers, the stdio MCP server through @mantle/mcp-core), so none of
 * them fails closed for a narrower it never loaded.
 *
 * Each narrower reads the caller, the declared policy and the ref: what a
 * tool is comes from its policy (@mantle/mcp-core gate-policy.ts derives
 * the owner MCP tools' from today's lists, runtime-policy.ts the runtime
 * rows', member-app-tools.ts an app tool's from the live member-app rule),
 * and the peer rule from the owner MCP surface's own lists, which that
 * surface registers (registerPeerToolRule). No rule is copied here.
 *
 * Each process main calls ensureGateReady() at boot, so a missing narrower
 * shows there, not at the first call.
 */
import {
  READ_ONLY_CALLER_ERROR,
  assertGateReady,
  registerNarrower,
  type GateCaller,
  type Narrower,
  type NarrowerName,
  type PolicyRef,
} from '@mantle/db';

/** The refusal of a tool outside a key's areas. */
export const KEY_AREA_ERROR = 'This API key is limited to areas this tool is not in.';

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

/** Whether `ref` names a tool (an MCP tool or a runtime tool row), as
 *  the peer rule reads it. */
function toolRef(ref: PolicyRef): boolean {
  return ref.kind === 'mcp-tool' || ref.kind === 'runtime-tool';
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
 *  so a key's areas there are judged by gateAccessKey and accessKeyLogin
 *  (keyMayCall), not here. */
const keyNarrower: Narrower = (caller, policy) => {
  const areas = (caller.facts?.keyAreas ?? null) as readonly string[] | null;
  if (!narrowedCaller(caller) || areas === null) return null;
  if (policy.fields?.keySelf === true) return null;
  const area = (policy.fields?.keyArea ?? null) as string | null;
  return area !== null && areas.includes(area) ? null : KEY_AREA_ERROR;
};

/** What the owner MCP surface knows of a tool by its name, for a key or a
 *  peer: whether it is risky (ownerPeerAllows' list) and whether it only
 *  reads (isMcpToolReadOnly; a connector tool counts as a write whatever
 *  its mark, as today). */
export type PeerToolRule = Readonly<{
  risky: (slug: string) => boolean;
  readOnly: (slug: string) => boolean;
}>;

let peerToolRule: PeerToolRule | null = null;

/** Register the owner MCP surface's tool rule (@mantle/mcp-core
 *  gate-policy.ts, from its own lists: nothing is copied here). The same
 *  rule again is a no-op; another throws, on purpose: two rules would make
 *  which one decides an accident of import order. */
export function registerPeerToolRule(rule: PeerToolRule): void {
  if (peerToolRule === rule) return;
  if (peerToolRule) throw new Error('registerPeerToolRule: a rule is registered already');
  peerToolRule = rule;
}

/**
 * A key's or a peer's risky tools and Write switch, on a tool: the rule the
 * MCP listing runs today (ownerPeerAllows), by the tool's name, from the
 * rule the owner MCP surface registers. A risky tool the owner did not name
 * on the key or the peer is refused; with Write off, a tool that is not
 * read-only is. Pinned against the listing by gate-policy.test.ts.
 *
 * Fail closed: in a process that has not loaded the surface's rule (no key
 * or peer reaches one today: they come in over MCP, served where
 * @mantle/mcp-core is loaded), every tool is risky and a write, so a key or
 * a peer calls only what the owner named, and only with Write on.
 * TODO(A5): the tool policies declare their peer marks, and the MCP entry
 * asserts them at boot.
 */
const peerNarrower: Narrower = (caller, _policy, ref) => {
  if (!narrowedCaller(caller) || !toolRef(ref)) return null;
  const riskyAllowed = (caller.facts?.riskyAllowed ?? []) as readonly string[];
  const risky = peerToolRule ? peerToolRule.risky(ref.name) : true;
  if (risky && !riskyAllowed.includes(ref.name)) return RISKY_TOOL_ERROR;
  const readOnly = peerToolRule ? peerToolRule.readOnly(ref.name) : false;
  return caller.write === false && !readOnly ? READ_ONLY_CALLER_ERROR : null;
};

/**
 * The member-app rule, fail closed (fix round 2, M-B): a run at team rules
 * (`facts.appRules === 'team'`) calls only an app tool (ref kind
 * `app-tool`, member-app-tools.ts appToolGatePolicy), and only when the
 * policy carries the live rule's answer and that answer allows it
 * (`fields.memberApp` null). A refusal says the rule's own words; any other
 * ref, or a policy with no answer, is refused. Every other caller passes.
 * Pinned against memberAppToolVerdict itself (member-app-parity.test.ts).
 */
const memberAppNarrower: Narrower = (caller, policy, ref) => {
  if (caller.facts?.appRules !== 'team') return null;
  if (ref.kind !== 'app-tool') return TEAM_APP_NO_TOOL_ERROR;
  const answer = policy.fields?.memberApp;
  if (answer === null) return null;
  return typeof answer === 'string' ? answer : TEAM_APP_NO_TOOL_ERROR;
};

/** Spending on the owner's keys, on an MCP connection: only a scope that
 *  holds Admin (an unscoped caller keeps its own rules). A workspace
 *  assistant's turn keeps its own rules (the member turn ledger), as today:
 *  it is not narrowed here. */
const spendingNarrower: Narrower = (caller, policy) =>
  mcpConnection(caller) && policy.spends === 'ownerKey' && caller.admin && !caller.admin.holdsAdmin
    ? OWNER_KEYS_ERROR
    : null;

/** The member turn caps: an explicit no-op until A5. TODO(A5): the caps
 *  are the member turn ledger (claimMemberTurn, a daily count and tokens
 *  per member turn, packages/content/src/member-turn-ledger.ts), claimed
 *  once per turn by workspace-turn.ts, not per tool call; A5 decides
 *  whether a call checks the claim here. */
const turnCapsNarrower: Narrower = () => null;

/** Every narrower of NARROWERS but the gate's own read-only one. */
export const GATE_NARROWERS: Readonly<Record<Exclude<NarrowerName, 'read-only'>, Narrower>> =
  Object.freeze({
    key: keyNarrower,
    peer: peerNarrower,
    'member-app': memberAppNarrower,
    spending: spendingNarrower,
    'turn-caps': turnCapsNarrower,
  });

/** Register every narrower (the same functions again are a no-op). */
export function registerGateNarrowers(): void {
  for (const [name, narrower] of Object.entries(GATE_NARROWERS)) {
    registerNarrower(name as NarrowerName, narrower);
  }
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
