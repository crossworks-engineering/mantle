/**
 * The instructional seed set — five formulas whose job is to TEACH THE SPEC
 * FORMAT BY EXAMPLE.
 *
 * The formula bank is owner-derived: a brain fills with the calculations its
 * owner's work actually needs, and shipping a library nobody asked for would be
 * clutter. What ships is exactly five widely-known models, chosen so that
 * between them every part of the spec appears at least once — a plain
 * expression, derived variables, a piecewise branch, a lookup with declared
 * domains, a classification, `latex`, units on everything, `notes`, and one
 * deliberately `unverified` equation that exists to show what the warning looks
 * like. They double as the regression suite: each carries worked examples with
 * expected values, so a change to the evaluator that breaks real arithmetic
 * fails a test rather than a live assessment.
 *
 * ⚠ COPYRIGHT. This repo is public. Equations are facts; a standard's TABLES
 * AND PROSE are not. Nothing here is transcribed from an API, ASME or ISO
 * document — every entry cites open textbooks or public physical constants.
 * Standard-derived models stay per-brain, authored on site by the mathematician
 * from the operator's own licensed copy.
 *
 * TypeScript rather than the YAML the plan sketched, for one reason: this
 * package is deliberately parser-free (see formula-spec.ts) so it runs
 * unchanged in tool handlers, the API and the browser. A YAML seed would drag a
 * parser into all three. The annotated YAML that teaches the *file* format
 * lives where an author meets it — the editor's template picker.
 */
import type { FormulaValue } from './formula-spec';

export type SeedExample = {
  target: string;
  inputs: Record<string, FormulaValue>;
  /** Expected value, checked to `tolerance` (these are floating-point). */
  expected: number;
  tolerance?: number;
};

export type SeedFormula = {
  /** Matches `spec.id`; used to detect "already present" when seeding. */
  slug: string;
  title: string;
  tags: string[];
  spec: Record<string, unknown>;
  examples: SeedExample[];
};

/** Every seeded formula carries this, so the owner can find — and clear — the
 *  set as a group. Deleting them is an owner decision the reconcile respects. */
export const SEED_TAG = 'instructional';

const idealGas: SeedFormula = {
  slug: 'ideal-gas-density',
  title: 'Ideal gas density',
  tags: [SEED_TAG, 'thermodynamics'],
  spec: {
    id: 'ideal-gas-density',
    name: 'Ideal gas density',
    source: {
      standard: 'Ideal gas law (any thermodynamics text)',
      edition: 'n/a — a defining relation, not an edition-bound clause',
    },
    unitSystem: 'SI',
    variables: [
      { symbol: 'P', name: 'Absolute pressure', unit: 'Pa', role: 'input' },
      { symbol: 'M', name: 'Molar mass', unit: 'kg/mol', role: 'input' },
      { symbol: 'T', name: 'Absolute temperature', unit: 'K', role: 'input' },
      {
        symbol: 'Rgas',
        name: 'Universal gas constant',
        unit: 'J/(mol K)',
        role: 'constant',
        value: 8.314462618,
        note: 'CODATA exact value since the 2019 SI redefinition.',
      },
    ],
    expressions: [
      {
        id: 'density',
        resultSymbol: 'rho',
        unit: 'kg/m3',
        expression: '{P} * {M} / ({Rgas} * {T})',
        latex: '\\rho = \\frac{P M}{R T}',
      },
    ],
    piecewise: [],
    lookups: [],
    classifications: [],
    notes: {
      validity:
        'The ideal gas assumption degrades near saturation and at high pressure. For real gases multiply by the compressibility factor Z.',
      basis:
        'P is ABSOLUTE pressure. Supplying gauge pressure here is the most common way this returns a wrong density.',
    },
  },
  examples: [
    {
      // Dry air at one standard atmosphere and 15 °C → the familiar 1.225 kg/m3.
      target: 'density',
      inputs: { P: 101325, M: 0.0289647, T: 288.15 },
      expected: 1.225,
      tolerance: 0.001,
    },
  ],
};

const reynolds: SeedFormula = {
  slug: 'reynolds-number',
  title: 'Reynolds number and flow regime',
  tags: [SEED_TAG, 'fluids'],
  spec: {
    id: 'reynolds-number',
    name: 'Reynolds number and flow regime',
    source: { standard: 'White, Fluid Mechanics', edition: '7th', sections: ['6.2'] },
    unitSystem: 'SI',
    variables: [
      { symbol: 'rho', name: 'Density', unit: 'kg/m3', role: 'input' },
      { symbol: 'v', name: 'Bulk velocity', unit: 'm/s', role: 'input' },
      {
        symbol: 'D',
        name: 'Characteristic length (pipe inside diameter)',
        unit: 'm',
        role: 'input',
      },
      { symbol: 'mu', name: 'Dynamic viscosity', unit: 'Pa s', role: 'input' },
    ],
    expressions: [
      {
        id: 'reynolds',
        resultSymbol: 'Re',
        // No declared unit: the result is dimensionless, and saying so with an
        // empty string would be a claim the checker cannot verify.
        expression: '{rho} * {v} * {D} / {mu}',
        latex: '\\mathrm{Re} = \\frac{\\rho v D}{\\mu}',
      },
    ],
    piecewise: [],
    lookups: [],
    classifications: [
      {
        id: 'regime-rating',
        domain: ['laminar', 'transitional', 'turbulent'],
        criteria: {
          laminar:
            'Re below roughly 2300 in a smooth circular pipe. Viscous forces dominate; the velocity profile is parabolic and the flow is orderly.',
          transitional:
            'Re roughly 2300 to 4000. Behaviour is intermittent and not reliably either regime; correlations for both are unreliable here.',
          turbulent:
            'Re above roughly 4000. Inertial forces dominate; the profile is flatter and mixing is vigorous.',
        },
        note: 'A rating is an INPUT — the criteria are here so a choice can be justified, not so it can be inferred.',
      },
    ],
    notes: {
      thresholds:
        'The 2300 and 4000 thresholds are conventional rather than sharp, and apply to smooth circular pipe. The source gives no criterion for non-circular sections.',
    },
  },
  examples: [
    {
      // Water at ~20 °C, 2 m/s through a 50 mm pipe.
      target: 'reynolds',
      inputs: { rho: 998, v: 2, D: 0.05, mu: 0.001 },
      expected: 99800,
      tolerance: 1,
    },
  ],
};

const darcyWeisbach: SeedFormula = {
  slug: 'darcy-weisbach-head-loss',
  title: 'Darcy–Weisbach head loss',
  tags: [SEED_TAG, 'fluids'],
  spec: {
    id: 'darcy-weisbach-head-loss',
    name: 'Darcy–Weisbach head loss',
    source: { standard: 'White, Fluid Mechanics', edition: '7th', sections: ['6.4'] },
    unitSystem: 'SI',
    variables: [
      { symbol: 'Re', name: 'Reynolds number', role: 'input' },
      { symbol: 'L', name: 'Pipe length', unit: 'm', role: 'input' },
      { symbol: 'D', name: 'Pipe inside diameter', unit: 'm', role: 'input' },
      { symbol: 'v', name: 'Bulk velocity', unit: 'm/s', role: 'input' },
      // Only the critical-velocity target needs these two, which is why the
      // signature is computed per TARGET rather than per formula.
      { symbol: 'rho', name: 'Density', unit: 'kg/m3', role: 'input' },
      { symbol: 'mu', name: 'Dynamic viscosity', unit: 'Pa s', role: 'input' },
      {
        symbol: 'g',
        name: 'Standard gravity',
        unit: 'm/s2',
        role: 'constant',
        value: 9.80665,
      },
      {
        symbol: 'vhead',
        name: 'Velocity head',
        unit: 'm',
        role: 'derived',
        expression: '{v} ^ 2 / (2 * {g})',
      },
    ],
    expressions: [
      {
        id: 'laminar-factor',
        // No resultSymbol: the PIECEWISE owns `f`. Two expressions both
        // claiming it would make the symbol ambiguous and the evaluator would
        // (rightly) refuse to pick one.
        expression: '64 / {Re}',
        note: 'Exact for fully developed laminar flow in a circular pipe.',
      },
      {
        id: 'turbulent-factor',
        expression: '0.316 * {Re} ^ -0.25',
        note: 'Blasius correlation — an empirical fit for smooth pipe, roughly 4000 < Re < 1e5.',
      },
      {
        id: 'head-loss',
        resultSymbol: 'hf',
        unit: 'm',
        expression: '{f} * ({L} / {D}) * {vhead}',
        latex: 'h_f = f \\frac{L}{D} \\frac{v^2}{2g}',
      },
      {
        id: 'critical-velocity',
        resultSymbol: 'vcrit',
        unit: 'm/s',
        // Symbols, not hard-coded fluid properties: the first cut wrote
        // `2300 * 0.001 / (998 * {D})` and the dimension checker correctly
        // rejected it — bare numbers carry no units, so the result came out as
        // 1/length rather than a velocity.
        expression: '2300 * {mu} / ({rho} * {D})',
        // The deliberate teaching example. It is genuinely reconstructed rather
        // than read off a page, and it is here so the warning can be seen.
        unverified:
          'Rearranged from the Re=2300 transition criterion rather than read from a source. Included to demonstrate what an unverified equation looks like — confirm before relying on it.',
      },
    ],
    piecewise: [
      {
        id: 'friction-factor',
        resultSymbol: 'f',
        cases: [
          { when: '{Re} < 2300', use: 'laminar-factor', label: 'Laminar' },
          { when: '{Re} >= 2300', use: 'turbulent-factor', label: 'Turbulent' },
        ],
        note: 'No `otherwise`: every real Re matches one of the two, and a silent fallback would hide a bad input.',
      },
    ],
    lookups: [],
    classifications: [],
    notes: {
      transition:
        'Between Re 2300 and 4000 neither branch is reliable — the piecewise still returns a number, and that number should be treated as indicative only.',
      roughness:
        'The Blasius branch assumes a SMOOTH pipe. For rough pipe the Colebrook–White equation is required; it is implicit in f and is not modelled here.',
    },
  },
  examples: [
    {
      // Laminar: Re = 1000 → f = 0.064; vhead = 2^2/(2*9.80665) = 0.203944 m.
      target: 'head-loss',
      inputs: { Re: 1000, L: 10, D: 0.05, v: 2 },
      expected: 2.61048,
      tolerance: 0.0001,
    },
    {
      // Turbulent: Re = 10000 → f = 0.316 * 10000^-0.25 = 0.0316.
      target: 'head-loss',
      inputs: { Re: 10000, L: 10, D: 0.05, v: 2 },
      expected: 1.288928,
      tolerance: 0.0001,
    },
    {
      // The branch itself, so the piecewise is exercised directly.
      target: 'friction-factor',
      inputs: { Re: 1000 },
      expected: 0.064,
      tolerance: 1e-9,
    },
  ],
};

const orificeFlow: SeedFormula = {
  slug: 'orifice-flow-rate',
  title: 'Orifice discharge rate',
  tags: [SEED_TAG, 'fluids'],
  spec: {
    id: 'orifice-flow-rate',
    name: 'Orifice discharge rate',
    source: {
      standard: 'Munson, Fundamentals of Fluid Mechanics',
      edition: '7th',
      sections: ['3.6'],
    },
    unitSystem: 'SI',
    variables: [
      { symbol: 'd', name: 'Orifice diameter', unit: 'm', role: 'input' },
      { symbol: 'h', name: 'Head above the orifice centreline', unit: 'm', role: 'input' },
      { symbol: 'g', name: 'Standard gravity', unit: 'm/s2', role: 'constant', value: 9.80665 },
      {
        symbol: 'A',
        name: 'Orifice area',
        unit: 'm2',
        role: 'derived',
        expression: 'PI / 4 * {d} ^ 2',
      },
    ],
    expressions: [
      {
        id: 'discharge',
        resultSymbol: 'Q',
        unit: 'm3/s',
        expression: '{Cd} * {A} * SQRT(2 * {g} * {h})',
        latex: 'Q = C_d A \\sqrt{2 g h}',
      },
    ],
    piecewise: [],
    lookups: [
      {
        id: 'discharge-coefficient',
        name: 'Discharge coefficient by orifice edge',
        keys: ['edgeType'],
        result: 'Cd',
        resultSymbol: 'Cd',
        // Declaring the domain is what makes the coverage check meaningful:
        // every declared combination is checked against the rows, so a missing
        // case is reported instead of silently unrepresented.
        domains: { edgeType: ['sharp', 'rounded', 'short-tube'] },
        rows: [
          { edgeType: 'sharp', Cd: 0.61 },
          { edgeType: 'rounded', Cd: 0.98 },
          { edgeType: 'short-tube', Cd: 0.8 },
        ],
        onMiss: 'error',
      },
    ],
    classifications: [
      {
        id: 'edgeType-classification',
        domain: ['sharp', 'rounded', 'short-tube'],
        criteria: {
          sharp:
            'A thin plate with a square, unrounded edge. The jet contracts downstream (vena contracta), which is why Cd is well below 1.',
          rounded:
            'The approach is bell-mouthed or well radiused, so the streamlines turn gradually and contraction is nearly eliminated.',
          'short-tube':
            'A plain tube a few diameters long attached to the opening; the jet reattaches inside it, recovering part of the contraction loss.',
        },
      },
    ],
    notes: {
      coefficients:
        'These coefficients are representative textbook values for water at ordinary temperatures, not a calibration. A metered installation should use its own calibration.',
    },
  },
  examples: [
    {
      // 50 mm sharp-edged orifice under 2 m of head.
      target: 'discharge',
      inputs: { d: 0.05, h: 2, edgeType: 'sharp' },
      expected: 0.0075014,
      tolerance: 1e-6,
    },
    {
      // The lookup on its own — the rounded edge nearly doubles the flow.
      target: 'discharge-coefficient',
      inputs: { edgeType: 'rounded' },
      expected: 0.98,
      tolerance: 1e-9,
    },
  ],
};

const pumpPower: SeedFormula = {
  slug: 'pump-hydraulic-power',
  title: 'Pump hydraulic and shaft power',
  tags: [SEED_TAG, 'pumps'],
  spec: {
    id: 'pump-hydraulic-power',
    name: 'Pump hydraulic and shaft power',
    source: { standard: 'White, Fluid Mechanics', edition: '7th', sections: ['11.2'] },
    unitSystem: 'SI',
    variables: [
      { symbol: 'rho', name: 'Fluid density', unit: 'kg/m3', role: 'input' },
      { symbol: 'Q', name: 'Volumetric flow rate', unit: 'm3/s', role: 'input' },
      { symbol: 'H', name: 'Total head developed', unit: 'm', role: 'input' },
      { symbol: 'g', name: 'Standard gravity', unit: 'm/s2', role: 'constant', value: 9.80665 },
      {
        symbol: 'eta',
        name: 'Pump efficiency (0–1)',
        role: 'input',
        // A default, not a constant: the caller may know the real efficiency,
        // and this is a placeholder for when they do not.
        value: 0.7,
        note: 'Typical mid-range centrifugal efficiency. Use the manufacturer curve where available.',
      },
      // Declared as outputs so the dimension checker knows what they ARE. It
      // learns units from `variables` only, so a chained symbol that appears
      // nowhere in that list binds as dimensionless and the shaft-power check
      // silently passed as a plain number. Declaring an output is good practice
      // regardless; here it is load-bearing.
      { symbol: 'Ph', name: 'Hydraulic power', unit: 'W', role: 'output' },
      { symbol: 'Ps', name: 'Shaft power', unit: 'W', role: 'output' },
    ],
    expressions: [
      {
        id: 'hydraulic-power',
        resultSymbol: 'Ph',
        unit: 'W',
        expression: '{rho} * {g} * {Q} * {H}',
        latex: 'P_h = \\rho g Q H',
      },
      {
        id: 'shaft-power',
        resultSymbol: 'Ps',
        unit: 'W',
        // Chains: Ph resolves through the single target that produces it, so a
        // caller asking for shaft power never has to compute the hydraulic
        // power first.
        expression: '{Ph} / {eta}',
        latex: 'P_s = \\frac{P_h}{\\eta}',
      },
    ],
    piecewise: [],
    lookups: [],
    classifications: [],
    notes: {
      efficiency:
        'Efficiency here is the pump alone. A motor and any drive have their own efficiencies; electrical input power is higher again.',
      head: 'H is the head the pump DEVELOPS, not the static lift — it includes friction and velocity head.',
    },
  },
  examples: [
    {
      // Water, 50 L/s against 20 m of head.
      target: 'hydraulic-power',
      inputs: { rho: 998, Q: 0.05, H: 20 },
      expected: 9787.0367,
      tolerance: 0.001,
    },
    {
      // Same duty through the chain, at the declared default efficiency.
      target: 'shaft-power',
      inputs: { rho: 998, Q: 0.05, H: 20 },
      expected: 13981.481,
      tolerance: 0.001,
    },
    {
      // Overriding the default.
      target: 'shaft-power',
      inputs: { rho: 998, Q: 0.05, H: 20, eta: 0.5 },
      expected: 19574.0734,
      tolerance: 0.001,
    },
  ],
};

export const FORMULA_SEED: readonly SeedFormula[] = [
  idealGas,
  reynolds,
  darcyWeisbach,
  orificeFlow,
  pumpPower,
];

export const FORMULA_SEED_SLUGS: readonly string[] = FORMULA_SEED.map((f) => f.slug);
