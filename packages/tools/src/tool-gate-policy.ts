/**
 * The gate's policy of a built-in tool called through dispatch (ref kind
 * `tool`, by its handler ref; workspaces arch A5 step 3a). It is the
 * builtin's declared policy (toGatePolicy), with the Admin step that
 * adminToolGate asked before step 3a (A5 step 6a deleted that function and
 * its lists: the step reads the policies of the tools the row names, its
 * slug and its handler ref), so gate step 5 refuses exactly what dispatch
 * refused, in the same words:
 *
 *  - an Admin area (the policy's area, the row's slug's first, then its
 *    ref's): the area;
 *  - else adminOnly (policyAdminOnly of the ref's builtin, or of the tool the
 *    row's slug names when it is not ownerOnly: a builtin, or a responder
 *    write the MCP surface defines): Admin;
 *  - else a create of a kind of the Admin workspace only (`admin-kind`:
 *    contact_create, journal_create, location_save), as the `mcp-tool`
 *    source declares it: a turn outside Admin is refused at the gate, in
 *    ADMIN_KIND_CREATE_ERROR's words, before the handler runs (A5 step 5),
 *    where before the database refused the row the handler wrote;
 *  - else none.
 *
 * `fields.systemWhole`: a tool whose policy says `systemWhole` (by the
 * row's slug or its ref), which dispatch runs whole on the system pool
 * after the area check (runGated).
 *
 * A row's slug is matched as well as its ref because a row may rename a
 * builtin; one named with ANOTHER builtin's slug never runs
 * (builtinRowSlugError, before the gate), and the slug's policy keeps it
 * from being listed where that builtin would not be.
 */
import { registerPolicySource, type GatePolicy, type PolicyRef } from '@mantle/db';
import {
  namedToolPolicy,
  policyAdminOnly,
  policyArea,
  policySystemWhole,
  tableBuiltin,
  toGatePolicy,
} from './tool-policy';

/** Whether the tool `name` names is adminOnly by its own policy: a builtin
 *  or an MCP surface definition that is not ownerOnly (an ownerOnly tool is
 *  adminOnly only by its own handler ref's policy). */
function namedAdminOnly(name: string): boolean {
  const t = namedToolPolicy(name);
  return !!t && !t.ownerOnly && policyAdminOnly(t.policy);
}

/** A builtin row's ref: its handler ref, and the row's own slug (a row may
 *  rename a builtin; the Admin lists match either). */
export function builtinToolRef(ref: string, slug: string): PolicyRef {
  return Object.freeze({ kind: 'tool', name: ref, slug });
}

/** A builtin called on the owner MCP surface (A5 step 4): the `mcp-tool`
 *  ref it is listed under (@mantle/mcp-core gate-policy.ts), by its name
 *  there, with the builtin it runs (`builtin`, its handler ref), which the
 *  item pre-check reads. */
export function mcpBuiltinToolRef(name: string, ref: string): PolicyRef {
  return Object.freeze({ kind: 'mcp-tool', name, builtin: ref });
}

/** The policy of `ref` (kind `tool`), or null: no builtin of that ref. */
export function builtinToolGatePolicy(ref: PolicyRef): GatePolicy | null {
  const def = tableBuiltin(ref.name);
  if (!def) return null;
  const slug = typeof ref.slug === 'string' ? ref.slug : ref.name;
  const named = slug === ref.name ? null : tableBuiltin(slug);
  const area = (named ? policyArea(named.policy) : null) ?? policyArea(def.policy);
  const adminOnly = policyAdminOnly(def.policy) || (slug !== ref.name && namedAdminOnly(slug));
  const base = toGatePolicy(def.policy);
  const systemWhole =
    policySystemWhole(def.policy) || (named !== null && policySystemWhole(named.policy));
  return Object.freeze({
    ...base,
    scope: area
      ? Object.freeze({ area })
      : adminOnly
        ? 'admin'
        : base.scope === 'admin-kind'
          ? 'admin-kind'
          : 'any',
    fields: Object.freeze({
      ...base.fields,
      ...(systemWhole ? { systemWhole: true } : {}),
    }),
  });
}

registerPolicySource('tool', builtinToolGatePolicy);
