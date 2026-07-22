# Formulas

A **formula** is a declarative model of a calculation taken from a published
standard. Not an expression string — a model, because a real engineering
calculation is never just arithmetic.

The motivating example throughout is the release-quantity calculation from
API RP 581 Part 3 §5.3 (a leaking pressure vessel). One "formula" there needs
four different kinds of thing at once, and only the first is maths:

| Kind | In the example |
|---|---|
| `expressions` | the liquid and vapour release-rate equations |
| `piecewise` | sonic vs subsonic, branching on a pressure threshold |
| `lookups` | a reduction factor per detection/isolation rating; a leak duration per rating **and** hole size |
| `classifications` | prose rubrics mapping a described system to an A/B/C rating |

A format that stores only expressions cannot hold that model, which is why this
one exists.

---

## 1. Storage

A formula is a `nodes` row with `type='formula'`:

```
nodes.title       display name (from spec.name, else spec.id)
nodes.data.spec   the validated FormulaSpec
nodes.tags        freeform tags
```

All under the `formulas` ltree root, lazy-created on first write. **No sidecar
table** — a spec is a few kilobytes of JSON and lives entirely in `nodes.data`.

`formula` is in the extractor's `DEFAULT_EXTRACT_TYPES`, so a summary and a
768-dim embedding land automatically on the next `pg_notify('node_ingested')`.
The extractor renders the body through `formulaToText`.

The rendered text is **not persisted**. `nodes.search_tsv` is generated from the
whole `data` blob, so FTS already covers the spec JSON; storing a second
rendering would create a copy that can drift from the spec it describes, and for
a calculation transcribed out of a safety standard two disagreeing copies is a
worse failure than a slightly noisier FTS vector.

Surface: `packages/content/src/formulas.ts` (`createFormula`, `listFormulas`,
`readFormulaSpec`, …). It only persists and retrieves — evaluation is pure and
lives elsewhere.

## 2. The spec — `formula-spec.ts`

Types plus `parseFormulaSpec`, a hand-written validator that reports **every**
problem at once rather than throwing on the first. These specs get transcribed
from printed standards by hand; a reviewer wants the whole list.

Deliberately dependency-free (no zod, no YAML) so it runs unchanged in tool
handlers, the API and the browser. Callers hand it an already-parsed object;
where that object came from is their problem.

Two decisions worth knowing before you change anything here:

**Lookup tables are stored as data rows, never as a nested `IF()` chain.**
Standards get revised. A changed factor should be a one-line diff a reviewer can
hold against the printed table, not a re-reading of a forty-term conditional.
Rows are also what make `checkLookupCoverage` possible — it takes the declared
key domains, enumerates every combination, and names the ones with no row.
The Table 5.6 reproduction in the source document behind this model specifies
six of nine detection/isolation combinations; as an `IF()` chain that gap is
invisible until it yields a silent zero on a live assessment. (Whether the gap
is in API RP 581 itself or only in that derived document is exactly the kind of
question coverage checking is meant to raise, not answer.) An incomplete table is a fact about the source, not a malformed
spec, so coverage is reported separately from validation.

**Classifications are inputs, not computations.** The criteria text is stored so
a rating can be justified by citing the clause it matched, but nothing here
tries to infer a rating from prose.

## 3. Evaluation — `formula-eval.ts`

`evaluateSpec(spec, targetId, inputs)`. Pure — no I/O, no DB, no clock. The
target may be an expression, a piecewise branch, or a lookup, all addressed by
bare id from one shared namespace.

Resolution order for a symbol: supplied input → constant → declared default →
derived expression (cycle-guarded) → the unique target declaring it as its
`resultSymbol`. If two targets produce the same symbol the error names both and
asks you to supply it explicitly, rather than picking one.

Two behaviours differ from table formula columns **because the failure modes
differ**:

- **It fails loud.** `evalFormula` returns `null` on any problem, which is right
  for a spreadsheet cell — a broken formula renders blank and the user moves on.
  It is wrong here. A blank release rate reads as a small number, and an
  unresolved symbol silently reading as zero is how a calculation gets quietly
  wrong for a year. Every failure returns an explicit error.
- **Symbols are case-sensitive.** Table columns match case-insensitively, which
  is friendly for `{qty}` vs `{Qty}`. Engineering notation has no such luxury:
  in the vapour equations `k` is the specific heat ratio and `K` is a correction
  factor. A near-miss must be an error, not a guess.

Every evaluation returns a **trace** — which branch was taken, which lookup row
matched, what each symbol resolved to. An engineering number that cannot be
explained is not worth much; the trace is what lets a result be shown with its
derivation rather than asserted.

## 4. The expression grammar

Expressions use the **same grammar as table formula columns**
(`table-formula.ts`): `{Braced}` references, `+ - * / % ^`, comparisons, and a
fixed function set. Still a hand-written tokenizer and recursive descent parser
— never `eval`, no identifier reaches a global scope.

Specs bind `{refs}` to variables, table columns bind them to cells of the
current row. Two binding strategies over one parser, via
`evalExpression(src, resolver)`. There is deliberately only one expression
language in the codebase.

The scientific set — `^`, `SQRT`, `POW`, `LN`, `LOG10`, `EXP`, and the bare
constants `PI` and `E` — exists for this feature. `^` binds tighter than `*`
and tighter than unary minus, so `-2^2` is `-(2^2)` = `-4`, per maths
convention. (Excel disagrees — there `=-2^2` is `+4`. We do not follow Excel.)
Right-associative with a unary-capable exponent: `2^3^2` = 512, `2^-1` = 0.5.
Scientific notation and leading-dot decimals are accepted (`1.5E-6`, `.5`).

## 5. Dimensional checking — `formula-dimensions.ts`

`checkDimensions(spec)` evaluates each expression with unit-bearing quantities
and compares the result's dimension against the declared `unit`. This is what
`unit` is FOR — it stopped being display text the moment mathjs arrived.

It catches the errors proofreading does not: a term dropped inside a `SQRT`, a
constant labelled with the wrong dimension, a declared result unit that the
arithmetic cannot produce. The motivating case is real — `g_c` was recorded as
`ft/s2` when it is the gravitational conversion constant `lbm ft/(lbf s^2)`.
Numerically identical in USC, so every value was right and every test passed;
only the dimensions expose it, and an SI port would have been silently out by
a factor of 3.13.

Units are written the way printed tables write them — `lbm-ft/(lbf-s2)`,
`lb/ft3`, `lbf/in2 (abs)` — and `normaliseUnit` translates the conventions
(hyphen-as-multiply, implicit exponents, `R` → `degR`). A trailing `(abs)` /
`(g)` is stripped: a pressure BASIS is not a dimension, which is exactly why
gauge and absolute must be two separate symbols rather than one annotated one.

Reported separately from `parseFormulaSpec`, like `checkLookupCoverage`: units
are optional and an unlabelled spec is incomplete rather than invalid. Surfaced
on `formula_get` / `formula_create` / `formula_update` as `dimension_issues`,
and on the API as `dimensionIssues`.

## 6. Authoring notes

Specs are usually written as YAML and parsed to an object before validation —
YAML because criteria prose and transcription notes are multi-line English,
which JSON turns into unreadable escaped strings. The same validator accepts
either; nothing in `packages/content` depends on a YAML parser.

**Cite what you actually read.** A worked example applying a standard is not
the standard. If the values were transcribed from a derived document — a
company calculation sheet, a vendor note — `source.standard` should say which
standard it *applies*, and a `notes` entry should say the values came from a
derived document. Two tells that you are not looking at the standard itself:
parameters it never uses (API RP 581 has four discrete hole sizes, so a 3/8 in
hole is somebody's spreadsheet), and tables that look abridged.

Set `unverified` on any equation you did not read off the page — supplied from
memory, inferred, or reconstructed. It renders as a warning everywhere the
equation is shown or indexed. An equation number is part of the claim: citing
"Eq 3.7" to a standard you did not open is a fabrication, however plausible the
formula itself.

Set `edition` too. Equation numbers move between editions, so a numbered
citation to an editionless standard is not a citation.

When transcribing from a standard, record what the source got wrong in `notes`
rather than silently correcting it. Real examples found while encoding the
API RP 581 model: a transition pressure the prose branches on but never defines;
a barrels conversion whose final line drops the density division shown one line
above it; a variable table that labels both gauge and absolute pressure
`lb/in²`; a leak-duration table keyed on hole sizes that do not include the hole
size the worked example uses. Each of those is a silently wrong number waiting
to happen, and the spec is the right place for the fact that they are open.
