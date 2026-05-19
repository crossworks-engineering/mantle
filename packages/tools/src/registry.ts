/**
 * In-memory registry of built-in tool handlers. Apps that want to add
 * more builtins (or override) call `registerBuiltin()` at module load
 * time. The agent runtime resolves handlers by slug at tool-call time.
 */

import type { BuiltinToolDef, BuiltinToolHandler } from './types';
import { BUILTIN_TOOLS } from './builtins';

const REGISTRY = new Map<string, BuiltinToolDef>();

for (const def of BUILTIN_TOOLS) {
  REGISTRY.set(def.slug, def);
}

export function registerBuiltin(def: BuiltinToolDef): void {
  REGISTRY.set(def.slug, def);
}

export function getBuiltin(slug: string): BuiltinToolDef | null {
  return REGISTRY.get(slug) ?? null;
}

export function getBuiltinHandler(slug: string): BuiltinToolHandler | null {
  return REGISTRY.get(slug)?.handler ?? null;
}

export function listBuiltins(): BuiltinToolDef[] {
  return Array.from(REGISTRY.values()).sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Fields the named builtin marks sensitive. Empty array for everything
 *  else (or unknown slugs). Cheap O(1) lookup used by the tool-loop
 *  before recording call args to `trace_steps.input`. */
export function getBuiltinRedactFields(slug: string): readonly string[] {
  return REGISTRY.get(slug)?.redactInputFields ?? [];
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
