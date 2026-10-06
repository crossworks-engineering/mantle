---
title: Formulas
toolGroups: [formulas, formulas-eval, calculator]
---

## Formulas

Formulas stores calculations taken from published standards and works them out for you. One formula can hold equations, a branch that picks the right equation, lookup tables and rules for sorting a case into a class.

- Browse the list, search it, or filter by standard.
- Open a formula to see its spec: equations, variables with units, lookup tables and transcription notes.
- Warnings show at the top: an equation marked **Unverified**, units that do not add up, or gaps in a lookup table.
- Under **Evaluate**, choose a **Target**, fill in the inputs it asks for and click **Evaluate formula**.

## Assistant

- "Work out the release rate for a 1/4 inch hole at 300 psi and 120 °F."
- "What does the pump power formula need from me?"
- "Which of my formulas have unverified equations?"

Each result comes with its working: which branch was taken, which table row matched and what each symbol was. Writing a new formula from a standard is handed to the mathematician specialist.

## Technical

- A formula is a `formula` node with its spec stored as JSON.
- Evaluation fails loudly. A missing value is an error, never a silent zero. Symbols are case-sensitive, so `k` and `K` are different.
- Shared formulas show their warnings and include a calculator for the visitor.
- Tools: `formula_list`, `formula_get`, `formula_evaluate`, `formula_create`, `formula_update`, and `calculate` for plain arithmetic with units. `formula_delete` is in a separate admin group.
