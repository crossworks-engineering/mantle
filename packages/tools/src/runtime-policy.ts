/**
 * The policies of the runtime tool rows (workspaces arch plan v2, section 8;
 * A3c). A built-in tool declares its policy where it is defined (A5:
 * ToolPolicy on BuiltinToolDef). A tool that only exists at run time (a
 * connector's tool, an API tool, a recipe, a shell tool, a tool an app
 * calls, a sandbox's toolbelt tool, a peer's tool) gets its policy from ONE
 * function per row type, here. No runtime tool runs without one: dispatch
 * refuses a row with no policy, and the sandbox and peer calls ask theirs
 * before they reach the remote tool.
 *
 * Each function only reads the row: what it is (read or write, which Admin
 * step, what it spends) and what it needs outside the database. Who may
 * call it stays where the rule is written once (loginConnectorRule for a
 * connector's workspaces, External access for an http tool below the
 * owner, the member-app rule below, the Admin areas of the sandbox and peer
 * tools). The gate (@mantle/db gate.ts) reads them through the policy
 * sources registered at the end of this file.
 *
 * Every policy starts at today's behaviour: none changes who may call what.
 */
import {
  registerPolicySource,
  type GatePolicy,
  type PolicyRef,
  type Tool,
  type ToolHandler,
} from '@mantle/db';
import { connectorToolPolicy, externalAccessActive } from './external-access';
import { handlerCarriesSecretRefs } from './secret-ref-gate';

export { connectorToolPolicy, type ConnectorToolPolicy } from './external-access';

/** The runtime tool row types (plan section 8). */
export type RuntimeRowType =
  'connector' | 'api' | 'recipe' | 'shell' | 'app' | 'sandbox-mcp' | 'peer';

/** A runtime tool row's policy: a gate policy that names its row type. */
export type RuntimeToolPolicy = GatePolicy & { readonly rowType: RuntimeRowType };

type Row = Pick<
  Tool,
  'slug' | 'handler' | 'requiresConfirm' | 'externalAccess' | 'description' | 'inputSchema'
> &
  Partial<Pick<Tool, 'createdBy'>>;

/**
 * An API tool (an http row, OpenAPI connectors' rows too): a write, unless
 * an admin switched External access on and confirmed it only reads (the
 * switch counts only on the handler they looked at). It reaches outside
 * the brain, and its vault refs resolve only while its maker holds the
 * keys area (secretRefsRunRefusal).
 */
export function apiToolPolicy(row: Row): RuntimeToolPolicy {
  const h = row.handler as ToolHandler;
  const read = externalAccessActive(row);
  return Object.freeze({
    rowType: 'api' as const,
    effect: read ? ('read' as const) : ('write' as const),
    scope: 'any' as const,
    spends: 'none' as const,
    fields: Object.freeze({
      outside: 'http',
      externalAccess: read,
      secretRefs: handlerCarriesSecretRefs(h),
      maker: row.createdBy ?? null,
      requiresConfirm: row.requiresConfirm === true,
    }),
  });
}

/**
 * A recipe: a write (its steps may write, and a step tool can change after
 * the recipe was made). Each step runs through dispatch with the step
 * tool's own policy; the safety envelope (no shell, confirm or privilege
 * step, recipe.ts) is checked at every step.
 */
export function recipeToolPolicy(row: Row): RuntimeToolPolicy {
  const h = row.handler as ToolHandler;
  return Object.freeze({
    rowType: 'recipe' as const,
    effect: 'write' as const,
    scope: 'any' as const,
    spends: 'none' as const,
    fields: Object.freeze({
      recipe: true,
      steps: h.kind === 'recipe' ? h.steps.length : 0,
      requiresConfirm: row.requiresConfirm === true,
    }),
  });
}

/**
 * A shell tool: an operator-authored command on the brain's own host, a
 * write. Agents cannot author or edit one (recipe.ts AGENT_GRANTABLE_KINDS);
 * today any agent a group grants it to runs it, behind its confirm.
 */
export function shellToolPolicy(row: Row): RuntimeToolPolicy {
  return Object.freeze({
    rowType: 'shell' as const,
    effect: 'write' as const,
    scope: 'any' as const,
    spends: 'none' as const,
    fields: Object.freeze({ outside: 'shell', requiresConfirm: row.requiresConfirm === true }),
  });
}

/** Why a member's app run may not call a built-in tool, or null (rules 2
 *  to 4 of member-app-tools.ts, on the resolved row; `refused`: the slugs
 *  no team app calls). The one reading of them: memberAppToolVerdict and
 *  appToolPolicy both ask it. */
export function memberAppRefusal(
  slug: string,
  ref: string,
  builtin: { readOnly: boolean; spends: boolean },
  requiresConfirm: boolean,
  refused: readonly string[],
): string | null {
  if (refused.includes(ref)) return `The tool '${slug}' is not available in team apps.`;
  if (builtin.spends) {
    return `The tool '${slug}' starts paid model work on every call, so a team app can't use it.`;
  }
  if (!builtin.readOnly) {
    return `The tool '${slug}' changes data or reaches outside the brain, so a team app can't use it (only read-only built-in tools are).`;
  }
  if (requiresConfirm) {
    return `The tool '${slug}' needs an admin's confirmation, so a team app can't use it.`;
  }
  return null;
}

/**
 * A tool an app calls (the app tool brokers): a built-in by what it is,
 * with the member-app rule's answer for a run at team rules
 * (`fields.memberApp`: null, or why it is refused); an outside tool by its
 * own row type (a connector, an API tool; the brokers refuse a recipe and
 * a shell tool by External access, external-access.ts).
 */
export function appToolPolicy(
  row: Row,
  builtin: { readOnly: boolean; spends: boolean } | null,
  refused: readonly string[],
): RuntimeToolPolicy | null {
  const h = row.handler as ToolHandler;
  if (h.kind !== 'builtin') return runtimeToolPolicy(row);
  if (!builtin) return null;
  return Object.freeze({
    rowType: 'app' as const,
    effect: builtin.readOnly ? ('read' as const) : ('write' as const),
    scope: 'any' as const,
    spends: builtin.spends ? ('model' as const) : ('none' as const),
    fields: Object.freeze({
      memberApp: memberAppRefusal(row.slug, h.ref, builtin, row.requiresConfirm === true, refused),
    }),
  });
}

/**
 * A tool of a sandbox's toolbelt (sandbox_mcp_call): a remote tool the
 * sandbox serves, a write (it can run anything in the sandbox). The
 * settings area, as sandbox_mcp_call itself. Null: no tool named.
 */
export function sandboxMcpToolPolicy(toolName: string): RuntimeToolPolicy | null {
  if (!toolName) return null;
  return Object.freeze({
    rowType: 'sandbox-mcp' as const,
    effect: 'write' as const,
    scope: Object.freeze({ area: 'settings' }),
    spends: 'none' as const,
    fields: Object.freeze({ remote: toolName, outside: 'sandbox' }),
  });
}

/**
 * A tool of a linked brain (peer_call): what it may do is decided on the
 * peer's side (the login the peer's owner bound us to, its Write switch),
 * so here it is a write, risky for a peer acting as a login, in the
 * connectors area as peer_call itself. Null: no tool named.
 */
export function peerToolPolicy(toolName: string): RuntimeToolPolicy | null {
  if (!toolName) return null;
  return Object.freeze({
    rowType: 'peer' as const,
    effect: 'write' as const,
    scope: Object.freeze({ area: 'connectors' }),
    spends: 'none' as const,
    fields: Object.freeze({ remote: toolName, outside: 'peer', peerRisky: true }),
  });
}

/**
 * The policy of a tool row that only exists at run time, by its handler
 * kind: a connector's (mcp), an API tool (http), a recipe, a shell tool.
 * Null for a built-in (it declares its own) and for a kind no function
 * knows: dispatch refuses such a row (NO_RUNTIME_POLICY_ERROR).
 */
export function runtimeToolPolicy(row: Row): RuntimeToolPolicy | null {
  switch ((row.handler as ToolHandler | null)?.kind) {
    case 'mcp':
      return connectorToolPolicy(row);
    case 'http':
      return apiToolPolicy(row);
    case 'recipe':
      return recipeToolPolicy(row);
    case 'shell':
      return shellToolPolicy(row);
    default:
      return null;
  }
}

/** The refusal of a runtime tool row with no policy. */
export const NO_RUNTIME_POLICY_ERROR =
  'This tool has no access policy (its handler kind is not one this brain knows), so it does not run. Ask an admin to recreate it.';

// ── The gate's sources (@mantle/db gate.ts, step 3) ─────────────────────────

/** A runtime row's ref carries the row it names. */
function refRow(ref: PolicyRef): Row | null {
  const row = ref.row as Row | undefined;
  return row && typeof row === 'object' && row.handler ? row : null;
}

registerPolicySource('runtime-tool', (ref) => {
  const row = refRow(ref);
  return row ? runtimeToolPolicy(row) : null;
});
registerPolicySource('sandbox-mcp-tool', (ref) => sandboxMcpToolPolicy(ref.name));
registerPolicySource('peer-tool', (ref) => peerToolPolicy(ref.name));
