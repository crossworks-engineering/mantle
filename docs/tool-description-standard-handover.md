# Handover: the tool-description standard + lint

**Status: DONE — executed 2026-07-07** (same day it was scoped), merged to
main in `40e15564`. The standard lives in `packages/tools/CLAUDE.md` ("The
description style guide"); the lint is `packages/tools/src/description-lint.test.ts`.
The first-pass audit found far more than the expected handful — 206 missing
param descriptions, 20 over-budget descriptions, 45 uncovered node-id params —
all swept in the same change. This document is kept as the design rationale;
the two files above are now the source of truth.

Originally scoped 2026-07-07 at the end of the v0.119.x tool-reliability
session; written for a fresh session to execute without that conversation.
Jason approved the direction ("I think we are on to something here").

## Why this exists

The v0.119.0 release moved tool-usage rules down the reliability ladder
(prose → schema → validating errors → gates → code — see
[tool-reliability.md](tool-reliability.md)). What remains in prose is the
part that SHOULD be prose: tool descriptions carrying judgment calls no
schema can express. The 2026-07-07 audit inventoried ~40 such load-bearing
rules and found they follow consistent shapes — but the shapes are folklore.
There is a written, repo-checked standard for **errors** and **schemas**
(`packages/tools/CLAUDE.md`), and **nothing** for description prose itself.
Whoever writes the next builtin copies whichever neighbor they read first.

**Deliverable:** codify the description standard beside the error guide, and
enforce the mechanical subset in CI the way `manifest.test.ts` enforces slug
integrity for the manifest.

## Part 1 — the standard (write into `packages/tools/CLAUDE.md`)

Add a section "The description style guide" beside the existing error-style
section. Content to codify (drafted and agreed, tune wording freely):

1. **First sentence = what it does + what it returns.** The model skims;
   the opening line does the tool-selection work.
   Exemplar: `search_nodes` ("Hybrid full-text + semantic search… ranked by
   relevance, NOT by date").
2. **Selection boundaries must name the alternative.** Every "when to use"
   states which tool to use for the adjacent case ("for time-windowed email
   questions use `email_list`"). A boundary without a named alternative
   teaches hesitation. This is the highest-value pattern in the codebase —
   exemplars: `email_list` vs `search_nodes`, `page_from_file` vs
   `page_create`, `search_chunks` → `read_section` → `file_read` ladder.
3. **Side effects and visibility, always.** Draft vs published, outward-
   facing or not, reversible or not. Exemplars: the `DRAFT_REVIEW_HINT`
   pattern in builtins-pages/tables; `contact_delete`'s allowlist warning.
4. **Scaling behavior when it matters.** What happens at size — truncation
   self-announces (`pageMeta`), sheets split (`table_from_file`), batches
   are atomic (`page_blocks_apply`).
5. **The ladder check.** Before ANY rule enters prose: can it be a schema
   constraint (enum/min/max/required), a precondition (`node_exists`), a
   dynamic-schema hook, or a guard? If yes it goes there and prose says
   nothing. Prose duplicating the schema WILL drift.

Hygiene rules:
- **Param descriptions carry semantics + an example, never type info**
  (the schema has types; the validator enforces them).
- **Length budget ~120 words** per description. Every description ships in
  the system prompt of every granted agent on every turn (the hermes
  "narrow waist" point). Exceeding the budget is allowed only for genuine
  footguns and must be justified — current sanctioned essays:
  `page_block_update` (markdown structural-prefix trap), `page_split`,
  `page_blocks_apply`, `search_nodes`, `search_chunks`, `table_from_file`,
  `page_from_file`, `api_tool_create`.
- Formatting conventions: backticks for tool/param names; **bold** only for
  load-bearing rules (if everything is bold nothing is); "Use when… / For
  X use `y` instead" phrasing.

## Part 2 — the lint (`packages/tools/src/description-lint.test.ts`)

A pure vitest suite over `listBuiltins()` (or `BUILTIN_TOOLS` + the domain
arrays — use the registry so app-registered builtins are covered). Checks,
in order of certainty:

1. **Non-empty**: `description` present on every def; every
   `inputSchema.properties[*]` has a non-empty `description` (allowlist
   for genuinely self-evident params if any exist — prefer zero).
2. **Cross-references resolve**: every backticked token in a description
   that *looks like a tool slug* must exist in the registry. This catches
   the rename-rot class (the Todos→Tasks / Lifelogs→Journal renames left
   stale references once before). Heuristic that avoids false positives:
   token matches `^[a-z][a-z0-9]*(_[a-z0-9]+)+$` (lowercase, contains an
   underscore) AND is not a param name of that same tool AND is not in a
   small allowlist of non-tool terms (`input_schema`, `draft_doc`,
   `requires_confirm`, `tool_slugs`, `memory_config`, `max_tokens`, …
   grow it as the first run reveals). Anything else unresolved fails with
   the token + tool named.
3. **Length ceiling**: description word count ≤ ~120 unless the slug is in
   the sanctioned-essay allowlist (list above; keep it in the test file
   with a comment requiring justification for additions).
4. **No schema duplication**: a param whose schema declares `enum` while
   its description contains "must be one of" / "one of:" fails — the enum
   renders to the model already, and prose copies drift.
5. **Precondition coverage**: any top-level param matching
   `/^(page|table|note|node|journal|task|event|file|folder)_id$/` (or
   `id` on a tool whose slug starts with one of those domains) must have a
   matching `preconditions` entry on the def — or be in an explicit
   exceptions list with a comment. (The v0.119.0 first-consumer wiring
   covered pages block tools + table row/column tools; this check makes
   the pattern self-extending.)

Run the first pass as a MINI-AUDIT: expect a handful of violations in the
~80 existing builtins; fix them in the same commit (that's the point).
Expect the cross-reference allowlist to need 2–3 tuning rounds — start
strict, add terms deliberately, never regex-loosen.

## Part 3 — order of work

1. Worktree: `scripts/new-worktree.sh tool-description-standard`.
2. Write the style-guide section into `packages/tools/CLAUDE.md`.
3. Build the lint; run it; sweep every violation it finds (each sweep edit
   should APPLY the standard, not just silence the check).
4. `pnpm -C packages/tools typecheck && pnpm vitest run packages/tools`.
5. One commit for guide+lint, one for the sweep if it's large; merge
   `--no-ff` from the integrator; Feature Tracker row + dev-brain journal
   (standing practice); rides the next release tag.

## Context a fresh session needs

- **The rule book is repo-checked**: `packages/tools/CLAUDE.md` (errors,
  schemas — this work adds descriptions) and `docs/tool-reliability.md`
  (architecture, the ladder, ops). Read both first.
- Scope is **builtin tool defs only** (`packages/tools/src/builtins*.ts`).
  Manifest prose (agent prompts, skills) is governed separately by
  `apps/web/lib/system-manifest/CLAUDE.md` — do not lint it here, though
  the standard's principles may migrate there later.
- Related principles: "mutate diagnostics, never data" (fence boundary —
  see tool-reliability.md); operator overrides are sacred (seed never
  re-asserts flags). Don't let sweep edits touch those behaviors.
- Prior work anchors: v0.119.0 release (commits `20c2f975..3e138a95`),
  audit fixes `a8c38e84`, /debug telemetry tab `8ab26364` (v0.119.1).
  Dev-brain journals: `6d473b7f` (audit), `e40bbc4e` (hermes cross-check),
  `62679cbc` (adversarial review), `d6eea688` (release), plus the Feature
  Tracker table `38934aa7-214a-4a98-9bb2-7e35b17b3665`.
- House workflow: worktrees for features, `--no-ff` merges from the
  integrator, commit-per-discrete-change, version bumps only at release
  time on Jason's word.
