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
