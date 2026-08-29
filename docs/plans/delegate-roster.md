# Delegate roster: live capability lines inside `invoke_agent`

> Handover plan (2026-08-29) for an implementing session in a fresh worktree
> (`scripts/new-worktree.sh delegate-roster`). Decision settled with Jason:
> the responder should KNOW what each of its delegates currently carries,
> derived live from grants — at GROUP level, never tool level. Acceptance
> demo (Jason runs it): grant `mcp-firecrawl` to the researcher, ask the
> persona to scrape a page; by the next turn `invoke_agent`'s description
> names Firecrawl under the researcher, and she delegates without a prompt
> edit.

## The problem

Routing knowledge is hand-written prose (`specialist_routing` skill). It
cannot know a delegate just gained a capability (e.g. an MCP connector
group), so the parent routes on stale generalities. The delegate list the
model sees (`invoke_agent`'s dynamic enum) is slugs only.

## Decisions (settled — do not relitigate)

1. **Group level, never tool level.** Tool descriptions can be remote-
   authored (MCP connectors cap them at 2k but they are third-party text);
   pasting them into the persona's prompt would re-open the injection door
   the connectors audit closed (see `docs/mcp-connectors.md`, reserved-
   namespace + firewall sections). Group names + descriptions are BRAIN-
   authored — safe, few, and already carry the "when to use" prose (the
   connector design put it there on purpose).
2. **Generated at toolset-assembly time**, not stored: extend the existing
   `invoke_agent` dynamic-schema hook. Zero drift, zero storage; a grant
   change reaches the parent on its next turn. Hook contract already fits:
   runs once per turn, async allowed, failure falls back to the static
   schema (`packages/tools/src/dynamic-schema.ts` header).
3. **Stoplist + caps.** Ubiquitous groups are noise (`memory-core`,
   `tool-results`, `delegation`, `persona`); skip them. Per-group text =
   group NAME + the first sentence of its description, clipped (~90 chars);
   per-delegate line capped (~220 chars, `… +N more` marker); whole roster
   capped (~1,200 chars). Single-line: strip newlines from descriptions.
4. **Placement: the tool DESCRIPTION** of `invoke_agent` (appended section),
   while the existing enum patch on `agent_slug` stays as is — one hook
   returns both `description` and `parameters`.
5. **Manifest is the default carrier.** The feature itself needs no manifest
   entry (it is runtime), but the `specialist_routing` skill body
   (`SKILL_INSTRUCTIONS` in `server/web/lib/system-manifest/prompts.ts`) is
   updated to say the live roster inside `invoke_agent` is authoritative for
   WHAT each delegate currently carries, while the skill stays the POLICY
   (do-yourself vs delegate, hand-off packing). Skill bodies force-sync to
   existing brains on upgrade and seed fresh brains at onboarding — that is
   the "default where needed" requirement satisfied.

## Implementation steps

1. **`packages/tools/src/delegate-roster.ts` (new).** Split pure/impure:
   - `renderDelegateRoster(input: Array<{ slug; name; groups: Array<{slug; name; description}> }>): string`
     — pure renderer: stoplist filter, first-sentence clip, caps, the
     `slug — Group (sentence); Group (sentence)` line shape. Export the
     stoplist + cap constants.
   - `buildDelegateRoster(ownerId, delegateTo): Promise<string>` — one query
     for the named agents (enabled only) + one for the owner's enabled
     groups; feed the renderer. Missing/disabled delegates are skipped
     silently (the enum already constrains slugs).
2. **Hook.** In `dynamic-schema.ts`, the registered `invoke_agent` hook
   becomes async: keep `withDelegateEnum` for `parameters`, add
   `description: `${current.description}\n\nYour delegates and what each
   currently carries (live, from their granted tool groups):\n<roster>``
   when the roster is non-empty. Wrap the db work so a failure degrades to
   the enum-only patch (the loop already treats hook failure as fallback,
   but keep the roster's own try/catch so the ENUM never regresses).
3. **Manifest prose.** One short paragraph added to
   `SKILL_INSTRUCTIONS.specialist_routing` ("the live roster in
   `invoke_agent` lists what each delegate carries right now; trust it over
   this skill when they disagree"). Read
   `server/web/lib/system-manifest/CLAUDE.md` first; run its checklist
   (vitest on the manifest dir + web typecheck).
4. **Tests.**
   - Pure renderer: stoplist applied; caps enforced (long description, many
     groups → `+N more`; many delegates → total cap); first-sentence
     extraction; a connector-group example (`mcp-firecrawl` name +
     untrusted note surviving the clip); newline stripping.
   - Hook: with a stubbed roster fn (or mocked db per
     `dispatch.test.ts`'s pattern), assert description appended AND enum
     still patched; roster failure → enum-only patch.
5. **Docs.** Short section in `docs/tools-and-skills.md` (near the
   specialist-routing/Phase-6 material) + a line in `docs/mcp-connectors.md`
   ("granting a connector group teaches the parent via the delegate
   roster"). Check `packages/tools/src/description-lint.test.ts` still
   passes (the static `invoke_agent` description is unchanged; the roster is
   dynamic, which the lint does not see).

## Guardrails to respect

- Brain-authored text only. Never tool slugs, never tool descriptions,
  never remote `serverInfo` strings.
- Only agents in the caller's `delegate_to`, only `enabled` agents and
  `enabled` groups.
- Prompt-cache: the hook already runs once per turn; the roster changes
  only when grants change. Do not add per-turn variance (no timestamps).
- No new crons, no persistence, no migration.

## Verify + land

`pnpm vitest run packages/tools packages/agent-runtime server/web/lib/system-manifest`,
package typechecks (`tools`, `web`), then `scripts/merge-branch.sh` per the
repo workflow. Do NOT push or roll boxes — Jason triggers that. Write the
result back to the dev brain per the mantle-status skill (roadmap task,
Feature Tracker row, working-memory bullet).
