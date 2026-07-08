# @mantle/tools — authoring guidance

Architecture + ops for the whole reliability layer (validation modes, guards,
fencing, preconditions): [docs/tool-reliability.md](../../docs/tool-reliability.md).

## The error style guide

**Every `{ ok: false, error }` must answer "what do I do instead."** The reader
is an LLM mid-turn: a bare `'q is required'` produces a flail-loop; an error
that names the fix produces a one-retry self-correction. The reliability
ladder for this package is prose → schema → validating errors → gates — an
error message is the *validating errors* rung, so write it like a corrective,
not a verdict.

Concretely, an error should carry as many of these as apply:

1. **The field/entity** that failed (`'limit'`, `page ${id}`).
2. **What was expected vs what arrived** (`must be an integer 1–50 (got 500)`).
3. **The recovery move** — which tool or argument change fixes it
   (`find the right id with page_list / search_nodes, then re-issue`).
4. **A near-miss suggestion** when one exists (`did you mean 'email'?`).

House patterns — reuse, don't reinvent:

- `notFound(kind, id, lookup)` in `errors.ts` for every id-that-resolved-to-
  nothing case. Pass the *actual* lookup tools for the domain
  (`'page_list / search_nodes'`, `'table_list'`, `'journal_list'`).
- Schema-level requiredness/type/enum/range errors are produced centrally by
  `validate-args.ts` (with did-you-mean) — handler-level `'x is required'`
  checks stay as backstops but don't need elaborate prose.
- Truncation/paging must self-announce (see `pageMeta` in builtins-tables) so
  a clipped result is never mistaken for the whole.
- Good existing exemplars: builtins-pages `block … not found — the id may be
  stale, re-run page_blocks_list`; invoke-agent-guards' single-suggestion
  `did you mean` (deliberately never lists the whole allowlist).

Hygiene is centralised — don't duplicate it in handlers:

- `sanitizeToolError()` runs in the tool-loop on every failed call's payload
  (strips role tags / fence-marker fakes / code fences, caps length).
- Secrets are scrubbed by `scrubSecrets` on the HTTP path; sensitive *input*
  fields are declared via `redactInputFields` on the tool def.

## The description style guide

A tool description is the prose rung of the reliability ladder: it carries
ONLY the judgment calls nothing stronger can express. Every description ships
in the system prompt of every granted agent on every turn, so each sentence
is paid for on every call the model makes — write for a skimming LLM doing
tool selection, not for a human reading docs. The mechanical subset of these
rules is enforced by `src/description-lint.test.ts`.

1. **First sentence = what it does + what it returns.** The opening line does
   the tool-selection work; the model may read nothing else. Exemplar:
   `search_nodes` ("Hybrid full-text + semantic search… ranked by relevance,
   NOT by date").
2. **Selection boundaries must name the alternative.** Every "when to use"
   states which tool handles the adjacent case ("for time-windowed email
   questions use `email_list`"). A boundary without a named alternative
   teaches hesitation, not selection. This is the highest-value pattern in
   the codebase — exemplars: `email_list` vs `search_nodes`, `page_from_file`
   vs `page_create`, the `search_chunks` → `read_section` → `file_read`
   ladder.
3. **Side effects and visibility, always.** Say whether the result is a
   draft or published, outward-facing or internal, reversible or not.
   Exemplars: the `DRAFT_REVIEW_HINT` pattern in builtins-pages/-tables;
   `contact_delete`'s allowlist warning.
4. **Scaling behavior when it matters.** What happens at size — truncation
   self-announces (`pageMeta`), sheets split into multiple tables
   (`table_from_file`), batches are atomic (`page_blocks_apply`).
5. **The ladder check.** Before ANY rule enters prose, ask: can it be a
   schema constraint (enum/min/max/required), a precondition
   (`node_exists`), a dynamic-schema hook, or a guard? If yes it goes there
   and the prose says nothing. Prose duplicating the schema WILL drift.

Hygiene:

- **Param descriptions carry semantics + an example, never type info.** The
  schema declares types and the validator enforces them; a param description
  restating "a string" wastes budget. Say what the value *means* and show
  one plausible value.
- **Length budget: ~120 words per description.** Exceeding it is allowed
  only for genuine footguns and needs justification — the sanctioned-essay
  allowlist lives in `description-lint.test.ts` with the reason per entry.
- Formatting: backticks for tool/param names; **bold** only for load-bearing
  rules (if everything is bold, nothing is); phrase boundaries as "Use
  when… / For X use `y` instead".
- Cross-references must resolve: any backticked underscore token that looks
  like a tool slug is checked against the registry by the lint (rename rot
  — the Todos→Tasks / Lifelogs→Journal renames left stale references once).

## Schemas

- JSON Schema on a builtin is a CONTRACT, not documentation: the central
  validator (validate-args.ts) coerces safe drift and, in enforce mode,
  rejects violations with teaching errors. Make constraints real — `enum`,
  `minimum`/`maximum`, `required` — instead of stating them in the
  description.
- Builtin top-level schemas are closed (`additionalProperties: false`) at
  seed time by `closeToolInputSchema`. Dynamic-key inputs belong one level
  down in a nested object prop that declares its own `additionalProperties`
  (see `cells` in builtins-tables, `files` in builtins-apps). A builtin that
  truly needs dynamic top-level keys opts out with `additionalProperties:
  true` in its literal — and should say why in a comment.
