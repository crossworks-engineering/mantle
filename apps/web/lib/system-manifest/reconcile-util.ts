/**
 * Pure helper for the boot reconcile. Dependency-free so it's unit-testable
 * (the vitest setup loads pure-logic modules only, not @/-aliased / DB code).
 */

/**
 * The manifest-persona groups an agent is MISSING. Reconcile uses this to UNION
 * new default groups onto an existing responder — it only ADDS, never removes,
 * so an operator's own grants (and removals of OTHER groups) are preserved. A
 * default group the operator deliberately removed will reappear after an update;
 * that's the manifest-as-capability-contract trade-off, and it's reversible.
 */
export function missingPersonaGroups(
  current: readonly string[] | null | undefined,
  manifestPersonaGroups: readonly string[],
): string[] {
  const have = new Set(current ?? []);
  return manifestPersonaGroups.filter((g) => !have.has(g));
}
