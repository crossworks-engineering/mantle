# Formulas → a scientist's workbench: implementation plan

> Handover plan (2026-07-25). Target: an implementing session (Opus 5) working in
> a worktree (`scripts/new-worktree.sh formulas-workbench`). The model layer is
> deep and correct, do not redesign it. The work is: finish the UI, wire the
> authoring path, make sharing first-class, seed a mathematician specialist via
> the manifest, and ship a formula bank + skill so agents can call formulas in
> chat. Read `docs/formulas.md` and `packages/content/src/formula-spec.ts`'s
> header comment before touching anything, the design decisions there
> (lookups-as-rows, loud failure, case-sensitive symbols, `latex` display-only,
> one expression language) are settled and load-bearing.

## Why

Field deployments (refinery-type brains) want to hold advanced calculation
models and share them, with team members who ask for formulas, publicly by
link, and with agents that can execute them mid-chat. Today the backend does
all of this and the UI does almost none of it: `/formulas` is read-and-evaluate
only, `dimensionIssues`/`specErrors`/`unverified` are computed but never
rendered, `formula` is not a shareable type, and no agent is *responsible* for
formulas.

## What already exists (don't rebuild)

| Layer | State |
|---|---|
| Spec + validator | `packages/content/src/formula-spec.ts`, 4-part model, all-errors-at-once validation |
| Evaluation | `formula-eval.ts`, pure, loud, case-sensitive, full derivation trace |
| Dimensional check | `formula-dimensions.ts` (mathjs), `unit` is a constraint |
| Coverage check | `checkLookupCoverage`, enumerated key domains vs rows |
| Storage | `nodes` row, `type='formula'`, spec in `nodes.data.spec`, no sidecar; FTS over `data`; extractor summary + 768-dim embedding via `formulaToText` |
| Agent tools | `builtins-formulas.ts`: list/get/evaluate/create/update/delete; groups `formulas` (no delete), `formulas-admin` (delete), `calculator`, persona already holds `formulas` + `calculator` |
| API | `GET/POST /api/formulas`, `GET/PATCH/DELETE /api/formulas/[id]`, `POST …/evaluate` |
| UI | Read-only master-detail + evaluator (`client/web/app/(app)/formulas/`) |

**Storage verdict: keep it.** Specs are a few KB of JSON; `nodes.data` +
generated `search_tsv` + the extractor pipeline is the right shape. Do NOT add a
sidecar table, and do NOT persist any derived rendering (the drift argument in
`docs/formulas.md` §1, two copies of a safety calculation is the failure mode).
"Most effective storage" is delivered by improving the *retrieval surface*
(Phase 1), not the schema.

## Decisions for Jason (defaults chosen so work can proceed)

1. **Specialist name**: slug `mathematician`; display name proposed **"Euler"**
   (fits Remy/Ledger/Reader). Jason names agents, confirm before merge.
2. **Bank delivery**: **DECIDED (Jason, 2026-07-25)**, the formula bank is
   owner-derived, not shipped. We seed exactly **5 of the most popular
   formulas as an instructional base**; they teach the spec format by
   example; everything beyond that the owner (or the mathematician) authors.
3. **Team-responder access**: default **yes**: grant a new read+evaluate-only
   group so team members can ask for a formula and a computed number in Team
   Chat.
4. **Detail routing**: keep the `?id=` param pattern (already built, matches
   the master-detail convention); no `/formulas/[id]` route.
5. **Primary authoring mode**: guided form editor first, YAML source view as a
   toggle (specs remain YAML-friendly; `@mantle/content` stays parser-free,
   YAML parsing happens client-side / in the skill, never in the package).

---

## Phase 1: The calling contract (backend, `packages/content` + tools)

Goal: an agent (or the share-page calculator) can answer *"what does this
formula compute, and what must I supply?"* without reading the whole spec.

1. **`formula-signature.ts` (new, in `packages/content`)**,
   `signatureOf(spec)` → per evaluable target:
   `{ id, kind, produces, unit, inputs: [{ symbol, name, unit, kind: 'number'|'enum', domain? }] }`.
   Static analysis mirroring the eval resolution order (input → constant →
   default → derived → producing target): a symbol is *required* iff it cannot
   resolve without being supplied. Lookup keys are `enum` inputs carrying their
   declared `domains`; classification symbols referenced by lookups carry the
   classification `domain`. Piecewise unions its cases' needs (conservative,
   note per-branch inputs in a `branches` sub-field if cheap). Pure,
   dependency-free, computed on read, never persisted (same drift rule).
   Co-located test against the API RP 581-shaped fixture in
   `formula-spec.test.ts`.
2. **Surface it everywhere:**
   - `formula_get` output: replace the thin `targetsOf` with the full signature
     (keep the field name `targets`; extend each entry with `inputs`). Update
     the description: the agent should never have to guess required inputs.
   - `GET /api/formulas/[id]`: add `signature`, the UI evaluator and the share
     calculator both consume it instead of re-deriving fields ad hoc.
3. **`formulaToText`**: append a `Callable:` section per target
   (`vapor-release-rate(Ps [psia], MW, Ts [R], …) → W_v [lb/s]`), so the
   summary + embedding capture *capability*, and "can it compute release rate
   from pressure and temperature?" retrieves on meaning. Existing formulas
   re-embed on next update; add a note to the plan's rollout step to bump-touch
   seeded/imported formulas rather than building a backfill job.
4. **New tool group `formulas-eval`** in `MANIFEST_TOOL_GROUPS`:
   `formula_list` + `formula_get` + `formula_evaluate` (read + compute, no
   authoring). Grant to `team-responder` (decision 3). Persona keeps `formulas`.
5. **Do not** add name/spec_id addressing to `formula_evaluate`, the
   list→get→evaluate ladder plus the skill is the contract; two id namespaces
   invite ambiguity.

## Phase 2: Owner UI: finish the reader, build the author (`client/web`)

Follow `docs/ui-style-guide.md` + `server/web/CLAUDE.md` non-negotiables
(shadcn, theme tokens, Dialog/AlertDialog/useToast, `<SubmitButton>`,
URL-driven list state, `min-h-0`).

**2a. Close the read-path gaps (small, do first):**
- Render `dimensionIssues` on the detail pane (the API already returns it),
  same visual weight as the coverage-gap card; these are "the arithmetic
  disagrees with the declared unit" warnings.
- Render `specErrors` when a stored spec fails re-parse (degraded node) instead
  of silently showing nothing.
- **`unverified` badges** on every equation that carries one, docs promise
  "renders as a warning everywhere"; today it renders nowhere in the UI. Badge +
  the stored justification text. This is the one item I'd call a bug.
- Evaluator: use the Phase 1 `signature`, enum inputs (lookup keys,
  classification ratings) become `Select`s with the criteria prose as help
  text; numeric inputs show unit suffixes. Case-typos become impossible instead
  of merely loud.
- Filters: wire `standard` and `tag` (API already accepts both), clickable
  `TagPill`s and a standard dropdown, URL-driven via `useListNav`.

**2b. The formula editor (the centerpiece):**
- `formula-editor.tsx`, full-pane editor reached from "New formula" and an
  Edit button on the detail header. Two synced views:
  - **Guided form**: sections mirroring the spec: Source & citation (standard/
    part/edition/sections/tables, nudge `edition`, it's part of the claim),
    Variables (grid: symbol/name/unit/role/value/expression), Expressions
    (expression + live KaTeX preview of `latex` side by side, labelled
    "display only, never parsed"; `equation` no.; `resultSymbol`; `unit`;
    `unverified` toggle + justification), Piecewise (case builder), Lookups
    (editable row grid + key-domain editor, live coverage readout),
    Classifications (rating ↔ criteria prose), Notes.
  - **Source view**: YAML editor (client-side `yaml` dep in `client/web`
    only) with parse errors inline. Round-trips with the form.
- **Live validation rail**: on every change run `parseFormulaSpec` +
  `checkLookupCoverage` + `checkDimensions` client-side (all three are pure and
  browser-safe, that's why they're dependency-free) and show the *complete*
  problem list, never one-at-a-time. Save via POST/PATCH; surface the server's
  `errors` array on rejection identically.
- Delete via `AlertDialog` (destructive, names the consequence: citations keep
  only their text).
- `<ShareControl nodeId>` on the detail header (Phase 3 makes it work).
- **Showcase**: the "New formula" dialog offers templates, *blank*, *single
  equation*, *piecewise*, *lookup table*, *full model*, plus one **annotated
  showcase spec** (use the ideal-gas or orifice-flow bank entry) whose YAML
  carries teaching comments on every field: this is the "how to write what,
  how" example. Store templates as constants beside the editor.

## Phase 3: Sharing: public links + team, with a live calculator

- Add `'formula'` to `SHAREABLE_TYPES` (`packages/content/src/shares.ts`),
  the share API, `<ShareControl>`, `node_share`/`node_unshare` and the
  Shared-links registry all follow from that one list. Verify nothing
  type-switches exhaustively without a default.
- **`formula-presenter.tsx`** in `server/web/components/share/` (registered in
  the `/s/[token]` switch): server-rendered spec, title, citation line,
  KaTeX-rendered equations (server-side `katex.renderToString`, same
  `trust:false` posture as the owner UI), lookup tables, classification
  rubrics, transcription notes, **unverified warnings**, coverage/dimension
  cards. Reuse whatever client-island mechanism `table-presenter.tsx` uses for
  its paging grid to mount the calculator.
- **`POST /s/[token]/evaluate`** (new, beside `rows/`): resolve active share →
  assert `node_type='formula'` → team-mode check via the same
  `resolveShareVisitor` path as rows/assets → `readFormulaSpec` by the share's
  `node_id`/owner → `evaluateSpec`. Rate-limit (`lib/rate-limit.ts`), cap the
  inputs object size, and return the same `{ok, value|error, trace}` shape.
  Evaluation is pure/cheap (no model, no DB writes) so this is a safe public
  compute surface, but say so in a route comment and keep the caps.
- The public calculator uses the Phase 1 signature (embed it in the rendered
  page payload) for typed inputs + enum selects, and renders the derivation
  trace, a shared link that *shows its work* is the point.
- Team mode rides existing mechanics (`teamMode` on ShareControl, hub cookie /
  visitor cookie on `/s`). Hub listing of team formulas: defer.

## Phase 4: The mathematician (manifest: this is what makes it fleet-wide)

All in `server/web/lib/system-manifest/`, never hardcoded elsewhere. The boot
reconcile auto-provisions a new specialist with delegation wired on every
brain's next upgrade; that's the entire reason this goes through the manifest.

- **`MANIFEST_AGENTS` entry**: slug `mathematician`, name per decision 1,
  `role: 'custom'`, `isDelegate: true`, model `anthropic/claude-sonnet-5`,
  `envModelVar: 'MATHEMATICIAN_MODEL'`, low temperature,
  `toolGroupSlugs: ['formulas', 'calculator', 'memory-core', 'files']`
  (memory-core for search/read_section over ingested standards; files to read
  an uploaded PDF it's transcribing). **Not** `formulas-admin`; delete stays
  deliberate. `AGENT_PROMPTS['mathematician']`: identity (rigorous applied
  mathematician / calculation librarian), the transcription ethic (cite what
  you actually read; `unverified` on anything from memory; record source
  defects in `notes`, never silently correct; `edition` always), the check
  loop (save → read back `coverage_gaps` + `dimension_issues` → resolve or
  document), and the answering rule (never state a number without its trace).
- **Skills** (`MANIFEST_SKILLS` + `SKILL_INSTRUCTIONS`):
  - `formula_authoring` (specialist): how to write a spec, the YAML shape
    with a worked mini-example, lookups-as-rows (never IF-chains), when
    something is a classification vs a lookup, symbols are case-sensitive and
    chosen to match the printed notation, `latex` is display-only, dimension
    and coverage checks are part of "done", how to revise (`formula_get` →
    amend whole spec → `formula_update`).
  - `formula_use` (persona + team-responder): the fast path for "calculate X
    for me", `formula_list`/`search` (type `formula`) → `formula_get` for the
    signature → collect missing inputs from the user (name units!) →
    `formula_evaluate` → **quote the trace**, flag unverified equations and
    coverage gaps rather than papering over them. Small; this ships in every
    turn's context.
- **Routing**: extend the `specialist_routing` body, transcribing/authoring/
  auditing a formula delegates to the mathematician; a quick evaluation of a
  stored formula the persona does itself (it holds `formulas`).
- Wire `skillSlugs`/`toolGroupSlugs`, then the checklist in
  `system-manifest/CLAUDE.md`: manifest vitest, typecheck, eyeball
  `/settings/config`.

## Phase 5: The instructional seed set (5 formulas)

The bank is **owner-derived**: brains fill with the formulas their owner's
work needs. What we ship is exactly **five** widely-known formulas whose job is
to *teach the spec format by example*: each is a living instance of "how to
write what, how", and together they exercise every part of the model.

- **Location**: `packages/content/formula-seed/*.yaml` + a loader exporting
  the parsed specs; a test that each passes `parseFormulaSpec` clean,
  `checkDimensions` clean, `checkLookupCoverage` complete, and each named
  target evaluates against worked-example input/expected pairs carried in the
  YAML. The seed set doubles as the regression suite.
- **Coverage constraint**: across the five, every spec construct must appear
  at least once: plain expression, derived variables, piecewise, a lookup with
  declared domains, a classification, `latex`, `unitSystem` + units on
  everything, `notes`, and one deliberate `unverified` example (annotated as
  such; it exists to show what the warning looks like). Candidate set (final
  pick is the implementer's, under that constraint): ideal gas law (simplest
  expression), Reynolds number + flow-regime classification, Darcy–Weisbach
  with laminar/turbulent piecewise, orifice flow with a discharge-coefficient
  lookup, pump hydraulic power / NPSH_a. All textbook, public-domain, fully
  cited. The annotated showcase template in Phase 2b reuses one of these.
- **⚠ Copyright**: this repo is public. Equations are facts; *standards' tables
  and prose are not*. Nothing transcribed from API/ASME/ISO documents ships,
  those stay per-brain, authored on-site by the mathematician from the
  operator's own licensed copy. The five cite open textbooks.
- **Delivery**: seeded on **fresh onboarding** (tagged e.g. `instructional`,
  so they're findable and deletable as a set; the owner may clear them).
  Existing brains: a quiet "Add the 5 instructional formulas" action in the
  `/formulas` empty state / New-formula dialog, calling a small
  `POST /api/formulas/seed` that imports any of the five not already present.
  Never re-created on upgrade; deleting them is an owner decision the
  reconcile must respect (content is owner space; this is the exception that
  proves the manifest rule, so keep the seed OUT of the boot reconcile).
- **Export/import**: Download-as-YAML on the detail header; "Import YAML" in
  the New-formula dialog (parse → validate → POST). This is brain-to-brain
  formula sharing *today*; federation over `peer_query` is future work.

## Phase 6: Verification & rollout

1. Unit: `pnpm exec vitest run packages/content` (signature, bank, presenter
   helpers) + `server/web/lib/system-manifest/`.
2. `pnpm --filter` typecheck on `client/web`, `server/web`,
   `@mantle/content`, `@mantle/tools`; `pnpm verify` before any push.
3. Browser: `pnpm dev:fe` (client/web against the test box) for the owner UI;
   the `/s` presenter + public evaluate need a full local stack or a deployed
   brain, check the running-instance rules in the recall skill first.
4. Tool descriptions changed in Phase 1/4 must pass `description-lint.test.ts`
   (packages/tools style guide, boundaries name alternatives, ~120 words).
5. `docs/formulas.md`: new sections (signature, sharing, bank, the agent).
   Changelog + version bump per release cadence; **tag-push is Jason's call**.
6. Order of merge: Phase 1 → 2a are independent of everything and can land
   first; 2b, 3, 4, 5 are parallelisable across worktrees after 1.

## Explicit non-goals

- No second expression language, no `eval`, no Excel `^` semantics.
- No persisted derived text (rendering, signature), computed on read.
- No inference of classification ratings from prose; they stay inputs.
- No auto-seeding bank content into existing brains.
- No federation of formulas (peer_query), export/import YAML covers it for now.
