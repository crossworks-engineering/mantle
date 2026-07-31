---
title: Formulas
toolGroups: [formulas, formulas-eval, calculator]
---

## Formulas

A formula here is not an expression string. It's a **model of a calculation
taken from a published standard** — and a real engineering calculation is never
just arithmetic.

One stored formula can hold four different kinds of thing at once: the
equations, a piecewise branch (sonic versus subsonic, say, switching on a
pressure threshold), lookup tables keyed on ratings and sizes, and prose rubrics
that map a described system onto an A/B/C classification. A format that stores
only equations cannot hold that, which is why this one exists.

The detail pane shows every finding the system computes, not just the spec:
equations you flagged as **unverified**, dimension mismatches, and gaps in a
lookup table. The evaluator builds its input fields from the formula's own
declared contract, so you only ever see the fields the target you picked
actually needs.

## Assistant

- "Work out the release rate for a 1/4 inch hole at 300 psi and 120 °F."
- "What does the pump power formula need from me?"
- "Which of my formulas have unverified equations?"

Two habits are worth having. Ask what a formula **needs** before asking for the
number — the assistant can read the input list, units and legal rating values
straight off the contract. And expect the derivation, not just the answer: every
evaluation returns a trace of which branch was taken, which lookup row matched
and what each symbol resolved to. An engineering number you cannot explain isn't
worth much.

Transcribing a new formula out of a standard, or auditing one, is handed to the
mathematician specialist. Evaluating one you already have stays with the main
assistant.

## Technical

A formula is an ordinary node with the validated spec in `data.spec` — no
sidecar table, since a spec is a few kilobytes of JSON. Evaluation is a pure
function: no database, no clock, no network.

Two behaviours differ deliberately from formula columns in Tables, because the
failure modes differ. **It fails loud.** A broken spreadsheet cell renders blank
and you move on; a blank release rate reads as a small number, and an unresolved
symbol silently reading as zero is how a calculation gets quietly wrong for a
year. Every failure returns an explicit error instead. And **symbols are
case-sensitive** — in the vapour equations `k` is the specific heat ratio and
`K` is a correction factor, so a near-miss has to be an error rather than a
guess.

Lookup tables are stored as data rows, never as a nested `IF()` chain. That is
what makes gap detection possible: the checker enumerates every combination of
the declared key domains and names the ones with no row. As a conditional, a
missing combination is invisible until it yields a silent zero.

Dimensional checking evaluates each expression with unit-bearing quantities and
compares the result against the declared unit. It catches what proofreading
doesn't — a term dropped inside a square root, a constant labelled with the
wrong dimension. Coverage gaps and dimension issues are reported *separately*
from validation, because an incomplete table is a fact about the source
document, not a malformed spec.

Shared formulas render server-side without JavaScript, warnings included. A
shared calculation that displayed without its unverified notice would be worse
than one that didn't display at all.
