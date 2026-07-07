# @mantle/tools — authoring guidance

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
