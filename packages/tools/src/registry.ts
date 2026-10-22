/**
 * In-memory registry of built-in tool handlers. Apps that want to add
 * more builtins (or override) call `registerBuiltin()` at module load
 * time. The agent runtime resolves handlers by slug at tool-call time.
 */

import type { BuiltinToolDef, BuiltinToolHandler } from './types';
import { BUILTIN_TOOLS } from './builtins';
import { loadPolicyTable, putPolicyTable, tableBuiltin, tableBuiltins } from './tool-policy';

// The registry IS the tool policy table (tool-policy.ts): each builtin's
// definition, its policy with it. The table lives there so a module a
// builtin imports can hold a view of it without importing every builtin.
loadPolicyTable(BUILTIN_TOOLS);

export function registerBuiltin(def: BuiltinToolDef): void {
  putPolicyTable(def);
}

export function getBuiltin(slug: string): BuiltinToolDef | null {
  return tableBuiltin(slug);
}

export function getBuiltinHandler(slug: string): BuiltinToolHandler | null {
  return tableBuiltin(slug)?.handler ?? null;
}

export function listBuiltins(): BuiltinToolDef[] {
  return Array.from(tableBuiltins()).sort((a, b) => a.slug.localeCompare(b.slug));
}

/** The refusal of a builtin row (a `tools` row whose handler is a builtin)
 *  named with ANOTHER builtin's slug, or null. A tool's policy is its
 *  builtin's (by the handler ref), while some checks still match the row's
 *  slug as well as the ref (admin-gate.ts): a row that took another
 *  builtin's name would be read as both tools. Seeding names each row by
 *  its ref and the tool routes refuse to make or rename a builtin row, so
 *  no such row is made; dispatch refuses one that exists anyway. */
export function builtinRowSlugError(slug: string, ref: string): string | null {
  if (slug === ref || !tableBuiltin(slug)) return null;
  return `This tool row is named '${slug}', another built-in tool's name, but runs '${ref}', so it does not run. Ask an admin to remove the row.`;
}

/** The builtins that become rows in the owner's `tools` table — everything
 *  except the `mcpOnly` operator surface, which is reachable over MCP only and
 *  must never end up in a catalog an agent can be granted from. Seeding is the
 *  ONLY place this distinction is applied, so it lives here where a test can
 *  see it rather than inline in seed.ts. */
export function listSeedableBuiltins(): BuiltinToolDef[] {
  return listBuiltins().filter((d) => !d.mcpOnly);
}

/** Fields the named builtin marks sensitive. Empty array for everything
 *  else (or unknown slugs). Cheap O(1) lookup used by the tool-loop
 *  before recording call args to `trace_steps.input`. */
export function getBuiltinRedactFields(slug: string): readonly string[] {
  return tableBuiltin(slug)?.redactInputFields ?? [];
}

/** Return a shallow copy of `input` with the named top-level fields
 *  replaced by the sentinel `'[REDACTED]'`. Non-string values are
 *  redacted to the same sentinel so downstream JSON-stringification
 *  doesn't leak a partial dump. If `fields` is empty, returns the
 *  original object unchanged (no unnecessary allocation). */
export function redactArgsForLogging(
  input: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  if (fields.length === 0) return input;
  const out: Record<string, unknown> = { ...input };
  for (const f of fields) {
    if (f in out) out[f] = '[REDACTED]';
  }
  return out;
}

/** Is this slug a builtin explicitly marked safe for a read-only turn?
 *
 *  DEFAULT-DENY, and that is load-bearing: an unknown slug, a user-defined
 *  API/recipe tool, or a brand-new builtin whose author never considered the
 *  question all answer `false`. The read-only preset therefore never has to be
 *  told about a new write tool — it already excludes everything it has not
 *  been told is safe. Mirrors `getBuiltinRedactFields`: an O(1) registry
 *  lookup for one piece of per-tool metadata. */
export function isBuiltinReadOnly(slug: string): boolean {
  return tableBuiltin(slug)?.policy.effect === 'read';
}

/** Is this builtin a row write a team app may make (`policy.memberApp`
 *  'table-rows', runtime-policy.ts memberAppRefusal)? Unknown slugs answer
 *  false. */
export function isBuiltinTeamTableRowWrite(slug: string): boolean {
  return tableBuiltin(slug)?.policy.memberApp === 'table-rows';
}

/** Does this builtin start paid model work on a call (`policy.startsModelWork`)? Unknown
 *  slugs answer false; the callers that refuse spenders (the member app
 *  broker) also refuse anything that is not a known read-only builtin. */
export function isBuiltinSpending(slug: string): boolean {
  return tableBuiltin(slug)?.policy.startsModelWork === true;
}

/** Is this builtin owner only (`ownerOnly`)? Unknown slugs answer false;
 *  the client app broker also refuses anything that is not a known
 *  read-only builtin. */
export function isBuiltinOwnerOnly(slug: string): boolean {
  return tableBuiltin(slug)?.ownerOnly === true;
}

/** Every registered builtin currently marked read-only, sorted. Used by the
 *  drift test and by `tool_catalog`-style introspection — NOT by the turn
 *  path, which filters the agent's own resolved allowlist through
 *  {@link isBuiltinReadOnly} instead of intersecting with this set. */
export function listReadOnlyBuiltinSlugs(): string[] {
  return Array.from(tableBuiltins())
    .filter((d) => d.policy.effect === 'read')
    .map((d) => d.slug)
    .sort();
}
