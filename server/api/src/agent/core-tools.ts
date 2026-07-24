/**
 * The core capability FLOOR for conversational agents + the pure decision logic
 * the boot self-heal uses to grant it. Split out of main.ts so it's unit-testable
 * without importing main.ts (which self-invokes `main()` on load).
 *
 * P6 — tool GROUPS are the sole grant (docs/tools-and-skills.md). The floor is a
 * set of GROUP slugs the self-heal idempotently grants to every enabled
 * responder/assistant so "be more professional" / "add a task" / "what did I tell
 * you yesterday?" all work without manual /settings/tool-groups setup. This is
 * what keeps OPERATOR-owned personas (telegram-default, apostle-paul — not
 * manifest slugs, so never seeded from the manifest) able to act from message one.
 */

/**
 * Groups every conversational agent gets without manual setup.
 *
 * `memory-core` and `delegation` are NOT cosmetic — they are the two groups that
 * make a floored persona *correct* rather than merely present:
 *  - `memory-core` (search_nodes / node_read / entity_* / …) lets the agent
 *    GROUND its answers in the brain. Without it the agent cannot search at all,
 *    directly contradicting the `tool_grounding` skill it's taught.
 *  - `delegation` (invoke_agent) lets it hand off to the Pages/Ledger/Remy/…
 *    specialists. Without it the integrity persona check fails outright
 *    ("missing invoke_agent — cannot delegate", see system-manifest/integrity.ts),
 *    and the tool is inert anyway unless the agent's memory_config.delegate_to is
 *    populated, so granting it universally is fail-closed and safe.
 *
 * The richer generalist groups (events / files / recall / media-workers / secrets
 * / ingest / tool-results) are deliberately NOT in the floor: they're opt-in via
 * the editor, and the canonical persona gets the full set from the manifest at
 * onboarding (PERSONA_TOOL_GROUP_SLUGS). The floor is the functional MINIMUM, not
 * the full generalist — so it never over-grants email/secrets/media to a
 * deliberately locked-down custom responder.
 *
 * `email`/`page-share` ship their tools ungated (requiresConfirm:false) — flip
 * per-row at /settings/tools to gate them.
 */
export const CORE_AUTO_GRANT_GROUP_SLUGS: readonly string[] = [
  'persona',
  'tasks',
  'contacts',
  'journal',
  'notes',
  'email',
  'page-share',
  'memory-core',
  'delegation',
];

/**
 * Pure: given the groups an agent already holds (`have`), a map of every ENABLED
 * group's tool slugs (`groupTools`), and the floor group slugs, return the floor
 * groups to ADD.
 *
 * A floor group is added unless the agent already holds it, OR another group it
 * already holds confers all of that floor group's tools. A floor group that is
 * missing/disabled (absent from `groupTools`, so `tools.length === 0`) is skipped
 * — it cannot be granted, and the live integrity checker surfaces a disabled
 * group an agent grants (checks 7/7c). Idempotent: re-running with the additions
 * already applied returns [].
 */
export function computeFloorGroupAdditions(
  have: ReadonlySet<string>,
  groupTools: ReadonlyMap<string, readonly string[]>,
  floor: readonly string[] = CORE_AUTO_GRANT_GROUP_SLUGS,
): string[] {
  const covered = new Set<string>();
  for (const g of have) for (const t of groupTools.get(g) ?? []) covered.add(t);
  return floor.filter((g) => {
    if (have.has(g)) return false;
    const tools = groupTools.get(g) ?? [];
    return tools.length > 0 && !tools.every((t) => covered.has(t));
  });
}
