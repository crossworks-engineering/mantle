/**
 * Starting points for a new formula.
 *
 * These are YAML rather than objects on purpose. A spec is authored as YAML —
 * criteria prose and transcription notes are multi-line English, which JSON
 * turns into unreadable escaped strings — and the templates are the first thing
 * an author reads, so they should look like what they are editing.
 *
 * The showcase carries teaching comments on every field. It is the answer to
 * "how do I write what, how", which no amount of form labelling conveys: why a
 * table is rows and not an IF() chain, why `latex` is never parsed, what
 * `unverified` is FOR. Comments survive in the source view and are dropped the
 * moment the form re-serialises — that is fine, they are scaffolding.
 */

export type FormulaTemplate = {
  key: string;
  name: string;
  blurb: string;
  yaml: string;
};

const BLANK = `id: my-formula
name: My formula
source:
  standard: ''
  edition: ''
  sections: []
unitSystem: SI
variables: []
expressions: []
piecewise: []
lookups: []
classifications: []
`;

const SINGLE = `id: ideal-gas-density
name: Ideal gas density
source:
  standard: Any thermodynamics text
  edition: ''
unitSystem: SI
variables:
  - symbol: P
    name: Absolute pressure
    unit: Pa
    role: input
  - symbol: M
    name: Molar mass
    unit: kg/mol
    role: input
  - symbol: Rgas
    name: Universal gas constant
    unit: J/(mol K)
    role: constant
    value: 8.314462618
  - symbol: T
    name: Absolute temperature
    unit: K
    role: input
expressions:
  - id: density
    resultSymbol: rho
    unit: kg/m3
    expression: '{P} * {M} / ({Rgas} * {T})'
    latex: '\\rho = \\frac{P M}{R T}'
piecewise: []
lookups: []
classifications: []
`;

const PIECEWISE = `id: pipe-friction-factor
name: Pipe friction factor
unitSystem: SI
variables:
  - symbol: Re
    name: Reynolds number
    unit: ''
    role: input
expressions:
  - id: laminar
    resultSymbol: f
    expression: '64 / {Re}'
  - id: turbulent
    resultSymbol: f
    expression: '0.316 * {Re} ^ -0.25'
piecewise:
  # The first truthy case wins. Omit 'otherwise' and an unmatched value is an
  # ERROR rather than a quiet zero — which is the point.
  - id: friction-factor
    cases:
      - when: '{Re} < 2300'
        use: laminar
        label: Laminar
      - when: '{Re} >= 2300'
        use: turbulent
        label: Turbulent
lookups: []
classifications: []
`;

const LOOKUP = `id: orifice-discharge
name: Orifice discharge coefficient
unitSystem: SI
variables: []
expressions: []
piecewise: []
lookups:
  # A table is DATA ROWS, never a nested IF() chain. A revised standard should
  # be a one-line diff a reviewer can hold against the printed table.
  - id: discharge-coefficient
    name: Discharge coefficient by edge type
    keys: [edgeType]
    result: Cd
    # Declaring the domain is what makes coverage checking possible: every
    # declared combination with no row is reported instead of silently missing.
    domains:
      edgeType: [sharp, rounded, 'short-tube']
    rows:
      - { edgeType: sharp, Cd: 0.61 }
      - { edgeType: rounded, Cd: 0.98 }
      - { edgeType: 'short-tube', Cd: 0.8 }
    onMiss: error
classifications: []
`;

const FULL = `id: worked-model
name: Worked model
source:
  standard: Example standard
  part: '1'
  edition: 2024
  sections: ['4.2']
  tables: ['4.1']
unitSystem: SI
variables:
  - symbol: d
    name: Hole diameter
    unit: m
    role: input
    value: 0.01
  - symbol: A
    name: Hole area
    unit: m2
    role: derived
    expression: 'PI / 4 * {d} ^ 2'
  - symbol: v
    name: Velocity
    unit: m/s
    role: input
expressions:
  - id: flow
    equation: '4.2'
    resultSymbol: Q
    unit: m3/s
    expression: '{A} * {v} * {reduction}'
piecewise: []
lookups:
  - id: reduction
    name: Reduction factor by detection rating
    keys: [detection]
    result: reduction
    resultSymbol: reduction
    domains:
      detection: [A, B, C]
    rows:
      - { detection: A, reduction: 0.25 }
      - { detection: B, reduction: 0.5 }
      - { detection: C, reduction: 1 }
classifications:
  # Named after the symbol it describes, so the evaluator form can offer the
  # criteria as help text on the picker.
  - id: detection-rating
    domain: [A, B, C]
    criteria:
      A: Instrumentation designed specifically to detect the loss.
      B: Detectors positioned to determine that material is present outside the envelope.
      C: Visual detection only, or marginal coverage.
notes:
  scope: Replace every field here with the model you are transcribing.
`;

const SHOWCASE = `# ─────────────────────────────────────────────────────────────────────────
# An ANNOTATED example. Every field is commented with what it is for.
# Delete the comments once you understand them — they are not stored.
# ─────────────────────────────────────────────────────────────────────────

# Stable slug for this calculation. Referenced in citations; keep it durable.
id: reynolds-number
name: Reynolds number and flow regime

# CITE WHAT YOU ACTUALLY READ. A worked example applying a standard is not the
# standard. 'edition' is part of the claim — equation numbers move between
# editions, so a numbered citation to an editionless standard is not a citation.
source:
  standard: White, Fluid Mechanics
  edition: 7th
  sections: ['6.2']

unitSystem: SI

variables:
  # role: input     — supplied by the caller. A 'value' here is a DEFAULT.
  # role: constant  — fixed by the spec; needs a value.
  # role: derived   — computed from other symbols; needs an expression.
  # role: output    — produced by an expression's resultSymbol.
  #
  # Symbols are CASE-SENSITIVE and should match the printed notation. In these
  # equations 'k' and 'K' would be two different quantities; a near-miss is an
  # error, never a guess.
  - symbol: rho
    name: Density
    unit: kg/m3
    role: input
  - symbol: v
    name: Bulk velocity
    unit: m/s
    role: input
  - symbol: D
    name: Characteristic length
    unit: m
    role: input
  - symbol: mu
    name: Dynamic viscosity
    # The unit is a CONSTRAINT, not a label — the dimension checker evaluates
    # the arithmetic with unit-bearing quantities and rejects a declared result
    # unit the expression cannot produce. This is what catches a dropped term
    # inside a SQRT, or a constant labelled with the wrong dimension.
    unit: Pa s
    role: input

expressions:
  - id: reynolds
    equation: '6.2'
    resultSymbol: Re
    # Dimensionless: density x velocity x length / viscosity cancels out.
    unit: ''
    # 'expression' is the SINGLE SOURCE OF TRUTH for what is computed.
    expression: '{rho} * {v} * {D} / {mu}'
    # 'latex' is DISPLAY ONLY and is never parsed. It exists so a spec can be
    # shown the way it appears in the source. Nothing checks that the two
    # agree — a mismatch is a documentation bug.
    latex: '\\mathrm{Re} = \\frac{\\rho v D}{\\mu}'

  - id: critical-velocity
    resultSymbol: vcrit
    unit: m/s
    expression: '2300 * {mu} / ({rho} * {D})'
    # Set 'unverified' on anything you did NOT read off the page — supplied
    # from memory, inferred, or reconstructed. It renders as a warning wherever
    # the equation is shown or indexed, so a from-memory citation can never be
    # mistaken for a transcribed one. This one is deliberate: it is here to
    # show you what the warning looks like.
    unverified: >-
      Rearranged from the transition criterion rather than read from the text.
      Confirm against the source before relying on it.

piecewise: []
lookups: []

classifications:
  # A classification is an INPUT, not a computation. The criteria text lives
  # here so a rating can be justified by citing the clause it matched; nothing
  # tries to infer a rating from prose. Name it after the symbol it describes
  # and the evaluator offers the prose as help text on the picker.
  - id: regime-rating
    domain: [laminar, transitional, turbulent]
    criteria:
      laminar: Re below about 2300 in a smooth circular pipe; viscous forces dominate.
      transitional: Re roughly 2300 to 4000; behaviour is not reliably either.
      turbulent: Re above about 4000; inertial forces dominate.

notes:
  # Record what the SOURCE got wrong here rather than silently correcting it.
  transition: >-
    The 2300 threshold is conventional rather than sharp, and applies to smooth
    circular pipe. The source gives no criterion for non-circular sections.
`;

export const FORMULA_TEMPLATES: FormulaTemplate[] = [
  {
    key: 'blank',
    name: 'Blank',
    blurb: 'An empty spec with every section stubbed out.',
    yaml: BLANK,
  },
  {
    key: 'showcase',
    name: 'Annotated example',
    blurb: 'A working spec with teaching comments on every field. Start here the first time.',
    yaml: SHOWCASE,
  },
  {
    key: 'single',
    name: 'Single equation',
    blurb: 'One expression over constants and inputs, with a LaTeX rendering.',
    yaml: SINGLE,
  },
  {
    key: 'piecewise',
    name: 'Piecewise',
    blurb: 'Two equations selected by a condition, with no fallback branch.',
    yaml: PIECEWISE,
  },
  {
    key: 'lookup',
    name: 'Lookup table',
    blurb: 'A keyed table stored as rows, with declared domains so coverage can be checked.',
    yaml: LOOKUP,
  },
  {
    key: 'full',
    name: 'Full model',
    blurb: 'Every construct at once — derived variables, a lookup, and a classification.',
    yaml: FULL,
  },
];
