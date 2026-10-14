/**
 * The gate's policy of a built-in tool called through dispatch (ref kind
 * `tool`, by its handler ref; workspaces arch A5 step 3a). It is the
 * builtin's declared policy (toGatePolicy), with the Admin step that
 * adminToolGate asked before step 3a, so gate step 5 refuses exactly what
 * dispatch refused, in the same words:
 *
 *  - an Admin area (TOOL_ADMIN_AREAS, by the row's slug or its ref): the
 *    area;
 *  - else adminOnly (isAdminOnlyTool: the policy, a responder write the MCP
 *    surface defines, an ownerOnly tool not in OWNER_ONLY_IN_SCOPE): Admin;
 *  - else none. A create of a kind of the Admin workspace only (`admin-kind`,
 *    the `mcp-tool` source's) is not refused here: on the turn path the
 *    database refuses that row, as before A5 (turn-gate-parity.test.ts).
 *
 * `fields.systemWhole`: an AREA_SYSTEM_TOOLS tool, which dispatch runs whole
 * on the system pool after the area check (runGated, by slug or ref).
 */
import { registerPolicySource, type GatePolicy, type PolicyRef } from '@mantle/db';
import { AREA_SYSTEM_TOOLS, isAdminOnlyTool, toolAdminArea } from './admin-gate';
import { tableBuiltin, toGatePolicy } from './tool-policy';

/** A builtin row's ref: its handler ref, and the row's own slug (a row may
 *  rename a builtin; the Admin lists match either). */
export function builtinToolRef(ref: string, slug: string): PolicyRef {
  return Object.freeze({ kind: 'tool', name: ref, slug });
}

/** The policy of `ref` (kind `tool`), or null: no builtin of that ref. */
export function builtinToolGatePolicy(ref: PolicyRef): GatePolicy | null {
  const def = tableBuiltin(ref.name);
  if (!def) return null;
  const slug = typeof ref.slug === 'string' ? ref.slug : ref.name;
  const opts = { ref: ref.name, ownerOnly: def.ownerOnly };
  const area = toolAdminArea(slug, ref.name);
  const base = toGatePolicy(def.policy);
  const systemWhole = AREA_SYSTEM_TOOLS.has(slug) || AREA_SYSTEM_TOOLS.has(ref.name);
  return Object.freeze({
    ...base,
    scope: area ? Object.freeze({ area }) : isAdminOnlyTool(slug, opts) ? 'admin' : 'any',
    fields: Object.freeze({
      ...base.fields,
      ...(systemWhole ? { systemWhole: true } : {}),
    }),
  });
}

registerPolicySource('tool', builtinToolGatePolicy);
