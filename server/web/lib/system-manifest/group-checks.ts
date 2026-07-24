/**
 * Pure logic for the integrity checker's "Tool group ↔ tool links" check
 * (integrity.ts check 7). Split out so the surfacing rules the audit added can be
 * unit-tested without a live DB (docs/audit-brief-tools-skills.md M1/M2).
 *
 * Two silent-loss paths the runtime resolvers hide — both now surfaced here:
 *   M1. A DISABLED manifest group. `resolveAgentToolGroups` only unions ENABLED
 *       groups, and the boot self-heal floor skips a disabled group with no
 *       error, so disabling e.g. `email`/`notes` silently under-grants every
 *       conversational agent. The old check looked up the row but never read its
 *       `enabled` flag, and the dangling-groups check only fires for a group an
 *       agent explicitly grants — so a disabled floor group that nothing grants
 *       yet was completely invisible.
 *   M2. A CUSTOM (operator-created) group whose member tool has no enabled row.
 *       The old check iterated only the manifest groups, so a disabled tool
 *       referenced by an operator's own group silently dropped at dispatch.
 */

export type GroupCheckRow = {
  slug: string;
  enabled: boolean;
  toolSlugs: string[] | null;
};

export type GroupCheckFinding = { id: string; detail: string };

/**
 * Compute the group→tool findings.
 *  - `manifestSlugs`: the canonical group slugs that MUST be seeded + enabled.
 *  - `groupRows`: every tool_group row for the owner (manifest + custom).
 *  - `enabledToolSlugs`: slugs of the owner's ENABLED tool rows.
 *
 * Findings (empty ⇒ healthy):
 *  - a manifest group not seeded;
 *  - a manifest group seeded but disabled (M1);
 *  - any ENABLED group (manifest or custom) referencing a tool with no enabled
 *    row (M2 extends this to custom groups).
 *
 * A disabled CUSTOM group is intentionally NOT flagged: parking one is operator
 * discretion, and a disabled group that's actually GRANTED is caught by the
 * separate dangling-groups check.
 */
export function computeGroupToolFindings(
  manifestSlugs: ReadonlySet<string>,
  groupRows: readonly GroupCheckRow[],
  enabledToolSlugs: ReadonlySet<string>,
): GroupCheckFinding[] {
  const findings: GroupCheckFinding[] = [];
  const bySlug = new Map(groupRows.map((g) => [g.slug, g] as const));

  for (const slug of manifestSlugs) {
    const row = bySlug.get(slug);
    if (!row) {
      findings.push({ id: slug, detail: `tool group '${slug}' is not seeded` });
      continue;
    }
    if (!row.enabled) {
      findings.push({
        id: slug,
        detail: `tool group '${slug}' is disabled — agents granting it (and the boot self-heal floor) silently lose its tools`,
      });
      continue;
    }
    for (const t of row.toolSlugs ?? []) {
      if (!enabledToolSlugs.has(t)) {
        findings.push({
          id: `${slug}:${t}`,
          detail: `tool group '${slug}' → tool '${t}' has no enabled row`,
        });
      }
    }
  }

  for (const row of groupRows) {
    if (manifestSlugs.has(row.slug) || !row.enabled) continue;
    for (const t of row.toolSlugs ?? []) {
      if (!enabledToolSlugs.has(t)) {
        findings.push({
          id: `${row.slug}:${t}`,
          detail: `custom tool group '${row.slug}' → tool '${t}' has no enabled row`,
        });
      }
    }
  }

  return findings;
}
