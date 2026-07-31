// Studio infrastructure: the branch tree, contacts (the cast = the email
// allowlist), secrets (obviously fake), formulas, ops notes, the finance
// table, recurring standups, and studio-wide email traffic.
import { world, owner } from '../lib/world.mjs';

export function generate(rngRoot) {
  const rng = rngRoot.fork('studio');
  const nodes = [], tables = [], emails = [], filesOut = [], turns = [];

  // ── Branch tree ───────────────────────────────────────────────────────────
  const branches = [
    'work', 'work.pumphouse', 'work.pumphouse.procedures', 'work.pumphouse.site',
    'work.storefront', 'work.storefront.stores', 'work.island', 'work.island.research',
    'studio', 'studio.handbook', 'studio.ops', 'studio.finance',
    'personal', 'personal.lathe', 'personal.trailrun', 'personal.journal',
  ];
  branches.forEach((path, i) =>
    nodes.push({
      id: `branch-${path.replace(/\./g, '-')}`, kind: 'branch', branch: path,
      title: path.split('.').pop(), body: '', offset: -179 + i * 0.1, tags: [], meta: { path },
    }));

  // ── Contacts: the cast, verbatim from the bible ───────────────────────────
  const cast = [{ ...owner, company: 'harbour-labs' }, ...world.people];
  cast.forEach((p, i) =>
    nodes.push({
      id: `contact-${p.id}`, kind: 'contact', branch: 'studio',
      title: p.name, body: p.role,
      offset: -178 + i * 0.2, tags: ['contact'],
      meta: { emails: [p.email], company: p.company, pronouns: p.pronouns, role: p.role },
    }));

  // ── Secrets (obviously fake, prove the screen renders) ────────────────────
  const secrets = [
    ['secret-metering-portal', 'Metering head-end portal', 'demo-not-a-real-password-001'],
    ['secret-cad-licence', 'CAD licence server key', 'demo-not-a-real-key-002'],
    ['secret-telemetry-tool', 'Telemetry config tool licence', 'demo-not-a-real-key-003'],
  ];
  secrets.forEach(([id, title, value], i) =>
    nodes.push({ id, kind: 'secret', branch: 'studio.ops', title, body: 'Demo placeholder credential — not a real secret.', offset: -100 + i * 20, tags: [], meta: { value } }));

  // ── Formula ───────────────────────────────────────────────────────────────
  // ONE, and a real one. The demo used to carry five one-liners
  // (`{amount} * {rate}` and friends), which showed that formulas exist while
  // hiding everything that makes them worth having. A formula spec is not a
  // string: it is typed variables, cited equations, a piecewise branch, a
  // lookup table with a declared domain, and a rating scale — and every
  // evaluation returns a trace saying which branch was taken and what each
  // symbol resolved to. A single worked example of THAT is worth more than a
  // page of arithmetic.
  //
  // Pump-station specific energy is the right subject for this world: it is
  // what the PUMPHOUSE work is actually about, the numbers are checkable
  // against any pump handbook, and it needs every construct honestly —
  // motor efficiency really does come off a class table, and a drive really
  // does behave differently below its minimum-speed threshold.
  //
  // Variable references are BRACED — `{symbol}`, the same dialect the table
  // formula columns use. A bare identifier fails validation, because the spec
  // parser syntax-checks expressions with a resolver that knows no names.
  // Symbols are CASE-SENSITIVE here (unlike table columns), so `Q` and `q`
  // would be two different things.
  const pumpSpec = {
    id: 'pump-specific-energy',
    name: 'Pump station specific energy and duty cost',
    unitSystem: 'SI',
    source: {
      standard: 'Studio calculation sheet PS-EN-01',
      sections: ['Hydraulic power', 'Drive train losses', 'Time-of-use tariff'],
    },
    notes: {
      scope:
        'Steady-state duty point only. Transients, surge and standby losses are out of scope — size the drive from the duty point, then check the transient case separately.',
      efficiency:
        'Motor efficiency comes off the IE class table. The drive derate applies below the minimum-speed threshold, where a VSD is no longer near its rated efficiency.',
    },
    variables: [
      // ── Duty point ────────────────────────────────────────────────────────
      { symbol: 'Q', name: 'Duty flow', unit: 'm3/h', role: 'input', value: 420 },
      { symbol: 'H', name: 'Total dynamic head', unit: 'm', role: 'input', value: 38 },
      { symbol: 'eta_p', name: 'Pump efficiency at duty', unit: '-', role: 'input', value: 0.78 },
      // ── Drive train ───────────────────────────────────────────────────────
      { symbol: 'P_rated', name: 'Motor rated power', unit: 'kW', role: 'input', value: 75 },
      {
        symbol: 'eff_class',
        name: 'Motor efficiency class',
        unit: '-',
        role: 'input',
        value: 'IE3',
        note: 'IE2, IE3 or IE4 — anything else is a gap in the table, not a zero.',
      },
      { symbol: 'speed_ratio', name: 'Duty speed / rated speed', unit: '-', role: 'input', value: 0.82 },
      // ── Operating pattern ─────────────────────────────────────────────────
      { symbol: 'h_peak', name: 'Peak hours per year', unit: 'h', role: 'input', value: 1100 },
      { symbol: 'h_std', name: 'Standard hours per year', unit: 'h', role: 'input', value: 2600 },
      { symbol: 'h_off', name: 'Off-peak hours per year', unit: 'h', role: 'input', value: 2400 },
      // ── Constants ─────────────────────────────────────────────────────────
      { symbol: 'rho', name: 'Density of water', unit: 'kg/m3', role: 'constant', value: 1000 },
      { symbol: 'g', name: 'Gravitational acceleration', unit: 'm/s2', role: 'constant', value: 9.81 },
      { symbol: 'eta_vsd', name: 'Drive efficiency at rated speed', unit: '-', role: 'constant', value: 0.97 },
      { symbol: 'slow_threshold', name: 'Minimum-speed threshold', unit: '-', role: 'constant', value: 0.6 },
      { symbol: 'c_peak', name: 'Peak tariff (cents per kWh)', role: 'constant', value: 412 },
      { symbol: 'c_std', name: 'Standard tariff (cents per kWh)', role: 'constant', value: 187 },
      { symbol: 'c_off', name: 'Off-peak tariff (cents per kWh)', role: 'constant', value: 103 },
      // ── Derived ───────────────────────────────────────────────────────────
      { symbol: 'h_total', name: 'Running hours per year', unit: 'h', role: 'derived', expression: '{h_peak} + {h_std} + {h_off}' },
      { symbol: 'eta_m', name: 'Motor efficiency', unit: '-', role: 'derived', expression: '{eta_m_class}' },
      {
        symbol: 'eta_drive',
        name: 'Drive efficiency at duty speed',
        unit: '-',
        role: 'derived',
        expression: '{eta_vsd} * {vsd_derate}',
      },
      { symbol: 'V_annual', name: 'Volume pumped per year', unit: 'm3', role: 'derived', expression: '{Q} * {h_total}' },
      { symbol: 'eta_wire', name: 'Wire-to-water efficiency', role: 'output' },
      // Outputs carry no expression of their own: they are PRODUCED by the
      // named expressions below. A target must be an expression, piecewise or
      // lookup id, so the headline numbers have to be expressions or they
      // cannot be evaluated from the UI at all.
      // Intermediates produced by the expressions below. They must be declared
      // WITH their units or the dimensional check has nothing to carry: without
      // these, P_elec reads as dimensionless and annual energy reconciles to
      // bare hours instead of kWh.
      { symbol: 'P_hyd', name: 'Hydraulic power', unit: 'kW', role: 'output' },
      { symbol: 'P_shaft', name: 'Shaft power', unit: 'kW', role: 'output' },
      { symbol: 'P_elec', name: 'Electrical input power', unit: 'kW', role: 'output' },
      { symbol: 'E_annual', name: 'Annual energy', unit: 'kWh', role: 'output' },
      { symbol: 'eta_m_class', name: 'Motor efficiency from class table', role: 'output' },
      { symbol: 'vsd_derate', name: 'Drive derate factor', role: 'output' },
      { symbol: 'SE', name: 'Specific energy', unit: 'kWh/m3', role: 'output' },
      { symbol: 'cost_annual', name: 'Annual energy cost (currency)', role: 'output' },
    ],
    expressions: [
      {
        id: 'hydraulic-power',
        equation: 'PS-EN-01 §1',
        resultSymbol: 'P_hyd',
        unit: 'kW',
        expression: '({rho} * {g} * ({Q} / 3600) * {H}) / 1000',
        latex: 'P_{hyd} = \\frac{\\rho\\,g\\,Q\\,H}{3.6\\times10^{6}}',
        note: 'Q converted from m³/h to m³/s, result in kW.',
      },
      {
        id: 'shaft-power',
        equation: 'PS-EN-01 §2.1',
        resultSymbol: 'P_shaft',
        unit: 'kW',
        expression: '{P_hyd} / {eta_p}',
      },
      {
        id: 'electrical-power',
        equation: 'PS-EN-01 §2.3',
        resultSymbol: 'P_elec',
        unit: 'kW',
        expression: '{P_shaft} / ({eta_m} * {eta_drive})',
        latex: 'P_{elec} = \\frac{P_{shaft}}{\\eta_m\\,\\eta_{drive}}',
      },
      {
        id: 'annual-energy',
        equation: 'PS-EN-01 §3',
        resultSymbol: 'E_annual',
        unit: 'kWh',
        expression: '{P_elec} * {h_total}',
      },
      {
        id: 'specific-energy',
        equation: 'PS-EN-01 §4',
        resultSymbol: 'SE',
        unit: 'kWh/m3',
        expression: '{E_annual} / {V_annual}',
        latex: 'SE = \\frac{E_{annual}}{V_{annual}}',
        note: 'The number that says whether the station is well matched — independent of how long it runs.',
      },
      {
        id: 'wire-to-water',
        equation: 'PS-EN-01 §4.1',
        resultSymbol: 'eta_wire',
        expression: '{P_hyd} / {P_elec}',
        note: 'Hydraulic power out over electrical power in — the whole drive train in one number, and unlike kWh/m³ it does not move with head.',
      },
      {
        id: 'annual-cost',
        equation: 'PS-EN-01 §5',
        resultSymbol: 'cost_annual',
        expression:
          '({P_elec} * {h_peak} * {c_peak} + {P_elec} * {h_std} * {c_std} + {P_elec} * {h_off} * {c_off}) / 100',
        note: 'Tariffs are in cents per kWh; the divide by 100 brings the total back to currency.',
      },
      // The two arms of the drive-derate branch.
      { id: 'derate-normal', expression: '1', note: 'At or above the minimum-speed threshold the drive runs near its rated efficiency.' },
      {
        id: 'derate-slow',
        expression: 'ROUND(0.88 + 0.12 * ({speed_ratio} / {slow_threshold}), 3)',
        note: 'Below the threshold, drive losses stop scaling with load and efficiency falls away.',
      },
    ],
    piecewise: [
      {
        id: 'vsd-derate',
        resultSymbol: 'vsd_derate',
        cases: [
          { when: '{speed_ratio} >= {slow_threshold}', use: 'derate-normal', label: 'At or above minimum speed' },
          { when: '{speed_ratio} < {slow_threshold}', use: 'derate-slow', label: 'Below minimum speed' },
        ],
        note: 'No `otherwise`: every speed ratio falls in one arm, so a miss would be a genuine error rather than a default.',
      },
    ],
    lookups: [
      {
        id: 'motor-efficiency',
        name: 'Motor efficiency by IE class',
        keys: ['eff_class'],
        result: 'eta_m_class',
        resultSymbol: 'eta_m_class',
        domains: { eff_class: ['IE2', 'IE3', 'IE4'] },
        // Nominal full-load efficiencies for a 4-pole machine in this frame
        // size. onMiss defaults to `error`, which is right: an unlisted class
        // is a gap in the table, and reading it as zero would make the running
        // cost infinite rather than obviously wrong.
        rows: [
          { eff_class: 'IE2', eta_m_class: 0.923 },
          { eff_class: 'IE3', eta_m_class: 0.941 },
          { eff_class: 'IE4', eta_m_class: 0.957 },
        ],
      },
    ],
    classifications: [
      {
        id: 'station-rating',
        domain: ['Good', 'Acceptable', 'Investigate'],
        criteria: {
          Good: 'Wire-to-water above 0.68 — pump, motor and drive all near their best points.',
          Acceptable: '0.55 to 0.68 — usually a duty point sitting off the curve peak, or an ageing impeller.',
          Investigate:
            'Below 0.55 — check the duty point against the pump curve before assuming the tariff is the problem.',
        },
        note:
          'Rated on wire-to-water, NOT on kWh/m³. Specific energy scales with head, so an absolute kWh/m³ band would call a high-lift station bad and a low-lift one good regardless of how well either is matched. Judgement scale for review, not an output of the calculation.',
      },
    ],
  };

  nodes.push({
    id: 'formula-pump-specific-energy',
    kind: 'formula',
    branch: 'studio.ops',
    title: 'Pump station specific energy and duty cost',
    body:
      'Works a pump station from duty point to annual running cost: hydraulic power, drive-train losses, ' +
      'time-of-use tariff, and the specific energy (kWh/m³) that actually tells you whether the station is ' +
      'well matched. Motor efficiency comes off the IE class table; the drive derate branches on whether the ' +
      'duty speed sits above or below the minimum-speed threshold.',
    offset: -90,
    tags: ['pumphouse', 'reference'],
    meta: { spec: pumpSpec },
  });

  // ── Ops notes ─────────────────────────────────────────────────────────────
  const ops = [
    ['ops-cashflow-note', 'Cashflow review — first Monday', 'Certified-to-date across projects healthy; STOREFRONT retentions tracked per store. One invoice query from Meridian procurement resolved by re-issuing with the amended PO number.'],
    ['ops-insurance-renewal', 'PI insurance renewal', 'Professional indemnity renewed; live-asset work on water infrastructure declared, premium unchanged. Certificate filed.'],
    ['ops-calibrator-cal', 'Calibrator calibration due', 'The loop calibrator’s own calibration certificate expires next month — booked with the lab; loaner arranged for the PS3 commissioning window.'],
    ['ops-crew-planning', 'Crew planning — commissioning fortnight', 'Tessa and Rowan on PS3 for the window; Dana covers STOREFRONT walks; June holds the fort. Friday workshop afternoons suspended for the fortnight, by unanimous grumble.'],
    ['ops-software-renewal', 'CAD seat renewal', 'Two CAD seats renewed off the software register reminder; telemetry config tool moves to the new licence server key.'],
    ['ops-backup-drill', 'Studio backup drill', 'Quarterly restore test of the project archive passed; oldest file recovered cleanly. The drill exists because backups that are never restored are rumours.'],
    ['ops-review-gate-audit', 'Review gate audit — quarter', 'Audited every client-facing document issued this quarter against the review gate log. Two went out without a recorded reviewer — both minor, both from the same busy fortnight. The review gate only works if it survives being busy; reminder issued.'],
  ];
  ops.forEach(([id, title, body], i) =>
    nodes.push({ id, kind: 'note', branch: 'studio.ops', title, body, offset: -110 + i * 18 + rng.int(0, 4), tags: ['ops'], meta: {} }));

  // ── Finance: invoice tracker ──────────────────────────────────────────────
  tables.push({
    id: 'studio-invoices', branch: 'studio.finance', title: 'Invoice tracker',
    columns: [
      { name: 'Invoice', type: 'text' }, { name: 'Client', type: 'select', options: ['Meridian Waterworks', 'Vantage Retail', 'Copperline Energy'] },
      { name: 'Amount', type: 'currency' }, { name: 'Status', type: 'select', options: ['draft', 'sent', 'paid', 'overdue'] },
      { name: 'Due (offset days)', type: 'number' },
    ],
    rows: Array.from({ length: 12 }, (_, i) => [
      `HL-${2300 + i}`,
      ['Meridian Waterworks', 'Vantage Retail', 'Copperline Energy'][i % 3],
      [48000, 61500, 22000, 53200, 47800, 18500][i % 6],
      i < 8 ? 'paid' : i < 10 ? 'sent' : ['draft', 'overdue'][i - 10],
      -150 + i * 15,
    ]),
    aggregates: { Amount: 'sum' }, offset: -140,
  });

  // ── Recurring standups + studio events ────────────────────────────────────
  for (let i = 0; i < 14; i++) {
    const off = -170 + i * 13;
    nodes.push({
      id: `studio-event-standup-${String(i + 1).padStart(2, '0')}`, kind: 'event', branch: 'studio',
      title: 'Studio standup', body: 'Monday all-hands: projects walked, site days planned, workshop afternoon defended.',
      offset: off, tags: ['studio'], meta: { start_offset: off, duration_min: 30, location: 'studio' },
    });
  }
  nodes.push({
    id: 'studio-event-quarterly', kind: 'event', branch: 'studio',
    title: 'Quarterly review + pizza', body: 'Numbers, lessons, and what the next quarter looks like. Pizza is structural.',
    offset: 16, tags: ['studio'], meta: { start_offset: 16, duration_min: 120, location: 'studio' },
  });

  // ── Studio-wide email traffic ─────────────────────────────────────────────
  const studioMail = [
    ['june@harbourlabs.example.com', ['alex@harbourlabs.example.com', 'rowan@harbourlabs.example.com', 'tessa@harbourlabs.example.com', 'dana@harbourlabs.example.com', 'felix@harbourlabs.example.com'], 'Commissioning fortnight — cover plan', -10, 'Cover plan for the PS3 window: Tessa and Rowan on site, Dana holds STOREFRONT, Felix and I keep the lights on. Calendar updated; shout if your site days clash.'],
    ['felix@harbourlabs.example.com', ['alex@harbourlabs.example.com'], 'Cashflow — first Monday numbers', -32, 'Numbers attached ahead of Monday: certified-to-date healthy on all three, Meridian invoice query resolved, one Vantage invoice heading to overdue if the 214 certificate drags. Retention exposure is in the tracker.'],
    ['alex@harbourlabs.example.com', ['felix@harbourlabs.example.com'], 'RE: Cashflow — first Monday numbers', -31.5, 'Thanks Felix. The 214 position summary went to Vantage — retention route proposed, which unblocks the certificate and the invoice both. Walk the rest Monday.'],
    ['rowan@harbourlabs.example.com', ['tessa@harbourlabs.example.com'], 'Calibrator booking — commissioning', -14, 'Booked the loaner calibrator for the full window. Ours goes to the lab Tuesday; certificate was about to lapse, which would have been a fine thing to discover on site.'],
  ];
  studioMail.forEach(([from, to, subject, off, body], i) =>
    emails.push({ id: `studio-mail-${i + 1}`, thread: ['studio-cover-plan', 'studio-cashflow', 'studio-cashflow', 'studio-calibrator'][i], subject, from, to, cc: [], offset: off, body }));

  // filler thread volume: short operational exchanges across the cast
  const fillerTemplates = [
    ['june@harbourlabs.example.com', 'Minutes issued', 'Minutes from today issued to the project branch; actions on the task list.'],
    ['tessa@harbourlabs.example.com', 'Site day confirmed', 'Meridian confirmed access for Thursday; permit reference filed.'],
    ['dana@harbourlabs.example.com', 'Drawings through the gate', 'Drawings passed review; issuing to the contractor this afternoon.'],
    ['felix@harbourlabs.example.com', 'Invoice run done', 'Monthly invoice run complete; tracker updated.'],
  ];
  for (let i = 0; i < 20; i++) {
    const [from, subject, body] = fillerTemplates[i % fillerTemplates.length];
    emails.push({
      id: `studio-mail-filler-${String(i + 1).padStart(2, '0')}`, thread: `studio-ops-${Math.floor(i / 2) + 1}`,
      subject: `${subject}${i % 2 ? ' — noted' : ''}`,
      from: i % 2 ? 'alex@harbourlabs.example.com' : from,
      to: [i % 2 ? from : 'alex@harbourlabs.example.com'], cc: [],
      offset: -160 + i * 8 + rng.float() * 2, body: i % 2 ? 'Noted with thanks — filed.' : body,
    });
  }

  // ── Files: studio odds and ends ───────────────────────────────────────────
  filesOut.push({
    id: 'studio-pi-certificate', kind: 'pdf', branch: 'studio.ops', name: 'pi-insurance-certificate.pdf',
    title: 'PI insurance certificate', text: ['Professional indemnity insurance certificate', 'Harbour Labs — live-asset water infrastructure work declared.'], offset: -95,
  });
  filesOut.push({
    id: 'studio-kit-list', kind: 'docx', branch: 'studio.ops', name: 'site-kit-list.docx', title: 'Site kit list',
    blocks: [{ h: 1, text: 'Standard site box' }, { text: 'Calibrator, loop tester, label printer, camera, spare glands, PPE. Check against this list before every site day.' }],
    text: ['standard site box calibrator loop tester label printer'], offset: -120,
  });
  for (let i = 0; i < 6; i++) {
    filesOut.push({
      id: `studio-misc-md-${i + 1}`, kind: 'md', branch: 'studio.ops', name: `ops-note-${i + 1}.md`,
      title: `Ops attachment ${i + 1}`,
      text: [`# Ops attachment ${i + 1}`, rng.pick(['Renewal schedule extract.', 'Booking sheet snapshot.', 'Register extract for the quarter.'])],
      offset: -100 + i * 15,
    });
  }

  // ── Turns ─────────────────────────────────────────────────────────────────
  turns.push(
    { id: 'turn-studio-1', agent: 'assistant', offset: -7, prompt: 'Who is covering what during the commissioning fortnight?' },
    { id: 'turn-studio-2', agent: 'assistant', offset: -30, prompt: 'Which invoices are unpaid, and is anything heading to overdue?' },
    { id: 'turn-studio-3', agent: 'assistant', offset: 0, prompt: 'Give me a picture of this week: deadlines, site days, and anything at risk.' },
  );

  return { nodes, tables, emails, files: filesOut, docs: [], turns };
}
