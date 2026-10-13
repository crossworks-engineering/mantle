/**
 * The owner MCP surface's side of the one gate (workspaces arch A3c; plan
 * sections 2, 8 and 20.3): what an MCP tool's policy is, and the surface
 * narrowers (a key's areas, a peer's or key's risky tools and Write switch,
 * spending on the owner's keys), registered at their places in the gate's
 * order (@mantle/db gate.ts).
 *
 * The policy is DERIVED from today's lists (the registry's flags, the Admin
 * gate's tables, the risky and spending lists, the key areas), and the
 * narrowers call the functions the listing calls today (ownerPeerAllows,
 * keyAreasAllowTool, spendsOwnerKeys): nothing is copied. A5 declares the
 * policy on each definition and deletes the lists; until then
 * gate-policy.test.ts pins that the gate lists exactly what preparedAllows
 * lists, for every tool and every kind of caller, and that the call runs
 * exactly when the listing shows it.
 *
 * A3c does not move the MCP surface onto the gate: registration, the
 * listing filter and the scope and create-home wrappers stay as they are
 * until A5.
 */
import {
  READ_ONLY_CALLER_ERROR,
  loginActor,
  registerNarrower,
  registerPolicySource,
  type GateCaller,
  type GatePolicy,
  type PolicyRef,
} from '@mantle/db';
import {
  CREATE_TOOL_SLUGS,
  getBuiltin,
  isAdminOnlyTool,
  isBuiltinSpending,
  toolAdminArea,
} from '@mantle/tools';
import { ADMIN_KIND_CREATE_TOOL_SLUGS } from './create-home';
import { toolKeyArea } from './key-scope';
import {
  isMcpToolReadOnly,
  isPeerRiskyTool,
  ownerPeerAllows,
  spendsOwnerKeys,
  type PreparedCallerTools,
} from './login-surface';

/**
 * The policy of one owner MCP tool (ref kind `mcp-tool`): a built-in by its
 * slug; a hand-written MCP tool only when the registration says it is one
 * (`ref.handWritten`, A5 makes them definitions). Any other name has no
 * entry.
 */
export function mcpToolPolicy(ref: PolicyRef): GatePolicy | null {
  const slug = ref.name;
  const def = getBuiltin(slug);
  if (!def && ref.handWritten !== true) return null;
  const area = toolAdminArea(slug);
  const scope = area
    ? Object.freeze({ area })
    : isAdminOnlyTool(slug, { ownerOnly: def?.ownerOnly })
      ? ('admin' as const)
      : ADMIN_KIND_CREATE_TOOL_SLUGS.has(slug)
        ? ('admin-kind' as const)
        : ('any' as const);
  return Object.freeze({
    effect: isMcpToolReadOnly(slug) ? ('read' as const) : ('write' as const),
    scope,
    spends: spendsOwnerKeys(slug)
      ? ('ownerKey' as const)
      : isBuiltinSpending(slug)
        ? ('model' as const)
        : ('none' as const),
    ...(CREATE_TOOL_SLUGS.has(slug) ? { creates: true } : {}),
    fields: Object.freeze({ keyArea: toolKeyArea(slug), peerRisky: isPeerRiskyTool(slug) }),
  });
}

/** The gate's caller for a prepared MCP connection (login-surface.ts), or
 *  null for a refused one. Its scope's Admin view is the one the listing
 *  read (null: unscoped, an Admin login on a brain not on workspaces). */
export function mcpGateCaller(prepared: PreparedCallerTools): GateCaller | null {
  if (prepared.kind === 'refused') return null;
  const { caller } = prepared;
  return Object.freeze({
    actor: loginActor(caller.loginId, caller.write ? 'rw' : 'ro'),
    via: caller.via,
    loginId: caller.loginId,
    write: caller.write,
    admin: prepared.view,
    createFallback: { privateWs: prepared.privateWs },
    facts: Object.freeze({
      keyAreas: caller.areas ?? null,
      riskyAllowed: caller.riskyAllowed ?? [],
    }),
  });
}

/** The refusal of a tool outside a key's areas. */
export const KEY_AREA_ERROR = 'This API key is limited to areas this tool is not in.';

/** The refusal of a risky tool the owner did not name on a key or a peer. */
export const RISKY_TOOL_ERROR =
  'This tool sends outside the brain, spends or hands out access: the owner did not name it on this key or linked brain.';

/** The refusal of a tool that spends on the owner's keys outside Admin. */
export const OWNER_KEYS_ERROR =
  "This tool spends on the brain owner's provider keys, which only a user of the Admin workspace may do.";

/** Whether the caller is narrowed like a peer: an API key or a peer (the
 *  login's own OAuth consent is not). */
function narrowedCaller(caller: GateCaller): boolean {
  return caller.via === 'key' || caller.via === 'peer';
}

/** Whether `ref` names a tool (an MCP tool or a runtime tool row). */
function toolRef(ref: PolicyRef): boolean {
  return ref.kind === 'mcp-tool' || ref.kind === 'runtime-tool';
}

/** A key's areas (null: every area): the policy's key area must be one of
 *  them (a policy with none is open only to an all-areas key). The tools'
 *  policies carry toolKeyArea; A4's route rows carry their own. */
registerNarrower('key', (caller, policy) => {
  const areas = (caller.facts?.keyAreas ?? null) as readonly string[] | null;
  if (!narrowedCaller(caller) || areas === null) return null;
  const area = (policy.fields?.keyArea ?? null) as string | null;
  return area !== null && areas.includes(area) ? null : KEY_AREA_ERROR;
});

/** A key's or a peer's risky tools and Write switch, on a tool:
 *  ownerPeerAllows, the rule the listing runs today (by the tool's name: it
 *  counts a connector tool as a write whatever its mark, as today; see the
 *  A3c report). */
registerNarrower('peer', (caller, _policy, ref) => {
  if (!narrowedCaller(caller) || !toolRef(ref)) return null;
  const riskyAllowed = (caller.facts?.riskyAllowed ?? []) as readonly string[];
  if (ownerPeerAllows(ref.name, { write: caller.write !== false, riskyAllowed })) return null;
  return isPeerRiskyTool(ref.name) && !riskyAllowed.includes(ref.name)
    ? RISKY_TOOL_ERROR
    : READ_ONLY_CALLER_ERROR;
});

/** Whether the caller is an MCP connection (the login's own OAuth, a key
 *  or a peer): the surface the owner-keys rule is for. */
function mcpConnection(caller: GateCaller): boolean {
  return caller.via === 'oauth' || narrowedCaller(caller);
}

/** Spending on the owner's keys, on an MCP connection: only a scope that
 *  holds Admin (an unscoped caller keeps its own rules). A workspace
 *  assistant's turn keeps its own rules (the member turn ledger), as today:
 *  it is not narrowed here. */
registerNarrower('spending', (caller, policy) =>
  mcpConnection(caller) && policy.spends === 'ownerKey' && caller.admin && !caller.admin.holdsAdmin
    ? OWNER_KEYS_ERROR
    : null,
);

registerPolicySource('mcp-tool', mcpToolPolicy);
