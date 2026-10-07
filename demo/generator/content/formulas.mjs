// FORMULAS: three, one per folder level.
//
//  - team:    pump station specific energy and duty cost (the full showcase:
//             typed variables with units, cited equations, a piecewise branch,
//             a lookup with a declared domain, a rating scale)
//  - client:  battery autonomy for a grid outage, the number the standby
//             findings rest on (350 kWh nameplate, one pump, 4.6 h)
//  - private: pipe velocity check, a quick one Alex keeps for site
//
// The numbers agree with the tables: one pump is 65 kW at PS3, the duty flow
// is 431 m3/h, and the delivery main is DN300.

const pumpSpec = {
  id: 'pump-specific-energy',
  name: 'Pump station specific energy and duty cost',
  unitSystem: 'SI',
  source: { standard: 'Studio calculation sheet PS-EN-01', sections: ['Hydraulic power', 'Drive train losses', 'Time-of-use tariff'] },
  notes: {
    scope: 'Steady-state duty point only. Transients, surge and standby losses are out of scope: size the drive from the duty point, then check the transient case separately.',
    efficiency: 'Motor efficiency comes off the IE class table. The drive derate applies below the minimum-speed threshold, where a VSD is no longer near its rated efficiency.',
  },
  variables: [
    { symbol: 'Q', name: 'Duty flow', unit: 'm3/h', role: 'input', value: 431 },
    { symbol: 'H', name: 'Total dynamic head', unit: 'm', role: 'input', value: 38 },
    { symbol: 'eta_p', name: 'Pump efficiency at duty', unit: '-', role: 'input', value: 0.78 },
    { symbol: 'P_rated', name: 'Motor rated power', unit: 'kW', role: 'input', value: 75 },
    { symbol: 'eff_class', name: 'Motor efficiency class', unit: '-', role: 'input', value: 'IE3', note: 'IE2, IE3 or IE4. Anything else is a gap in the table, not a zero.' },
    { symbol: 'speed_ratio', name: 'Duty speed / rated speed', unit: '-', role: 'input', value: 0.82 },
    { symbol: 'h_peak', name: 'Peak hours per year', unit: 'h', role: 'input', value: 1100 },
    { symbol: 'h_std', name: 'Standard hours per year', unit: 'h', role: 'input', value: 2600 },
    { symbol: 'h_off', name: 'Off-peak hours per year', unit: 'h', role: 'input', value: 2400 },
    { symbol: 'rho', name: 'Density of water', unit: 'kg/m3', role: 'constant', value: 1000 },
    { symbol: 'g', name: 'Gravitational acceleration', unit: 'm/s2', role: 'constant', value: 9.81 },
    { symbol: 'eta_vsd', name: 'Drive efficiency at rated speed', unit: '-', role: 'constant', value: 0.97 },
    { symbol: 'slow_threshold', name: 'Minimum-speed threshold', unit: '-', role: 'constant', value: 0.6 },
    { symbol: 'c_peak', name: 'Peak tariff (cents per kWh)', role: 'constant', value: 412 },
    { symbol: 'c_std', name: 'Standard tariff (cents per kWh)', role: 'constant', value: 187 },
    { symbol: 'c_off', name: 'Off-peak tariff (cents per kWh)', role: 'constant', value: 103 },
    { symbol: 'h_total', name: 'Running hours per year', unit: 'h', role: 'derived', expression: '{h_peak} + {h_std} + {h_off}' },
    { symbol: 'eta_m', name: 'Motor efficiency', unit: '-', role: 'derived', expression: '{eta_m_class}' },
    { symbol: 'eta_drive', name: 'Drive efficiency at duty speed', unit: '-', role: 'derived', expression: '{eta_vsd} * {vsd_derate}' },
    { symbol: 'V_annual', name: 'Volume pumped per year', unit: 'm3', role: 'derived', expression: '{Q} * {h_total}' },
    { symbol: 'eta_wire', name: 'Wire-to-water efficiency', role: 'output' },
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
    { id: 'hydraulic-power', equation: 'PS-EN-01 §1', resultSymbol: 'P_hyd', unit: 'kW', expression: '({rho} * {g} * ({Q} / 3600) * {H}) / 1000', latex: 'P_{hyd} = \\frac{\\rho\\,g\\,Q\\,H}{3.6\\times10^{6}}', note: 'Q converted from m³/h to m³/s, result in kW.' },
    { id: 'shaft-power', equation: 'PS-EN-01 §2.1', resultSymbol: 'P_shaft', unit: 'kW', expression: '{P_hyd} / {eta_p}' },
    { id: 'electrical-power', equation: 'PS-EN-01 §2.3', resultSymbol: 'P_elec', unit: 'kW', expression: '{P_shaft} / ({eta_m} * {eta_drive})', latex: 'P_{elec} = \\frac{P_{shaft}}{\\eta_m\\,\\eta_{drive}}' },
    { id: 'annual-energy', equation: 'PS-EN-01 §3', resultSymbol: 'E_annual', unit: 'kWh', expression: '{P_elec} * {h_total}' },
    { id: 'specific-energy', equation: 'PS-EN-01 §4', resultSymbol: 'SE', unit: 'kWh/m3', expression: '{E_annual} / {V_annual}', latex: 'SE = \\frac{E_{annual}}{V_{annual}}', note: 'The number that says whether the station is well matched, independent of how long it runs.' },
    { id: 'wire-to-water', equation: 'PS-EN-01 §4.1', resultSymbol: 'eta_wire', expression: '{P_hyd} / {P_elec}', note: 'Hydraulic power out over electrical power in: the whole drive train in one number, and unlike kWh/m³ it does not move with head.' },
    { id: 'annual-cost', equation: 'PS-EN-01 §5', resultSymbol: 'cost_annual', expression: '({P_elec} * {h_peak} * {c_peak} + {P_elec} * {h_std} * {c_std} + {P_elec} * {h_off} * {c_off}) / 100', note: 'Tariffs are in cents per kWh; the divide by 100 brings the total back to currency.' },
    { id: 'derate-normal', expression: '1', note: 'At or above the minimum-speed threshold the drive runs near its rated efficiency.' },
    { id: 'derate-slow', expression: 'ROUND(0.88 + 0.12 * ({speed_ratio} / {slow_threshold}), 3)', note: 'Below the threshold, drive losses stop scaling with load and efficiency falls away.' },
  ],
  piecewise: [
    {
      id: 'vsd-derate', resultSymbol: 'vsd_derate',
      cases: [
        { when: '{speed_ratio} >= {slow_threshold}', use: 'derate-normal', label: 'At or above minimum speed' },
        { when: '{speed_ratio} < {slow_threshold}', use: 'derate-slow', label: 'Below minimum speed' },
      ],
      note: 'No `otherwise`: every speed ratio falls in one arm, so a miss would be a genuine error rather than a default.',
    },
  ],
  lookups: [
    {
      id: 'motor-efficiency', name: 'Motor efficiency by IE class', keys: ['eff_class'],
      result: 'eta_m_class', resultSymbol: 'eta_m_class', domains: { eff_class: ['IE2', 'IE3', 'IE4'] },
      rows: [
        { eff_class: 'IE2', eta_m_class: 0.923 },
        { eff_class: 'IE3', eta_m_class: 0.941 },
        { eff_class: 'IE4', eta_m_class: 0.957 },
      ],
    },
  ],
  classifications: [
    {
      id: 'station-rating', domain: ['Good', 'Acceptable', 'Investigate'],
      criteria: {
        Good: 'Wire-to-water above 0.68: pump, motor and drive all near their best points.',
        Acceptable: '0.55 to 0.68: usually a duty point sitting off the curve peak, or an ageing impeller.',
        Investigate: 'Below 0.55: check the duty point against the pump curve before blaming the tariff.',
      },
      note: 'Rated on wire-to-water, NOT on kWh/m³. Specific energy scales with head, so an absolute band would call a high-lift station bad and a low-lift one good regardless of how well either is matched.',
    },
  ],
};

const autonomySpec = {
  id: 'battery-autonomy',
  name: 'Battery autonomy for a grid outage',
  unitSystem: 'SI',
  source: { standard: 'Standby power study, PS3', sections: ['Storage sizing'] },
  notes: {
    scope: 'Energy balance only: the battery must carry the station load less whatever the solar canopy gives. Night is the design case, so solar defaults to zero.',
    load: 'Meridian runs one pump during an outage and lets the hilltop reservoir carry the rest. One pump at PS3 is 65 kW (load profile table).',
  },
  variables: [
    { symbol: 'E_nom', name: 'Battery nameplate capacity', unit: 'kWh', role: 'input', value: 350 },
    { symbol: 'DoD', name: 'Usable depth of discharge', unit: '-', role: 'input', value: 0.9 },
    { symbol: 'eta_inv', name: 'Inverter efficiency', unit: '-', role: 'input', value: 0.95 },
    { symbol: 'P_load', name: 'Station load during the outage', unit: 'kW', role: 'input', value: 65 },
    { symbol: 'P_pv', name: 'Solar contribution', unit: 'kW', role: 'input', value: 0, note: 'Zero at night. Use 25 kW for a winter midday.' },
    { symbol: 't_req', name: 'Required ride-through', unit: 'h', role: 'constant', value: 4 },
    { symbol: 'E_use', name: 'Usable energy', unit: 'kWh', role: 'output' },
    { symbol: 'P_net', name: 'Net load on the battery', unit: 'kW', role: 'output' },
    { symbol: 't_auto', name: 'Autonomy', unit: 'h', role: 'output' },
    { symbol: 't_margin', name: 'Margin over the requirement', unit: 'h', role: 'output' },
  ],
  expressions: [
    { id: 'usable-energy', equation: 'Study §3.1', resultSymbol: 'E_use', unit: 'kWh', expression: '{E_nom} * {DoD} * {eta_inv}', latex: 'E_{use} = E_{nom}\\,DoD\\,\\eta_{inv}' },
    { id: 'net-load', equation: 'Study §3.2', resultSymbol: 'P_net', unit: 'kW', expression: '{P_load} - {P_pv}' },
    { id: 'autonomy', equation: 'Study §3.3', resultSymbol: 't_auto', unit: 'h', expression: '{E_use} / {P_net}', latex: 't_{auto} = \\frac{E_{use}}{P_{load} - P_{pv}}', note: 'With the defaults: 299 kWh over 65 kW is 4.6 h.' },
    { id: 'margin', equation: 'Study §3.4', resultSymbol: 't_margin', unit: 'h', expression: '{t_auto} - {t_req}' },
  ],
  classifications: [
    {
      id: 'outage-rating', domain: ['Meets', 'Marginal', 'Short'],
      criteria: {
        Meets: 'Margin of half an hour or more over the four-hour requirement.',
        Marginal: 'Between zero and half an hour of margin: one cold night or an ageing cell away from short.',
        Short: 'Below four hours. The 300 kWh option lands here at night (3.95 h).',
      },
      note: 'Judgement scale for the findings review, not an output of the calculation.',
    },
  ],
};

const velocitySpec = {
  id: 'pipe-velocity',
  name: 'Pipe velocity check',
  unitSystem: 'SI',
  source: { standard: 'Site rule of thumb', sections: ['Velocity'] },
  notes: { scope: 'Full-bore flow in a round pipe. Use the internal diameter, not the nominal size.' },
  variables: [
    { symbol: 'Q', name: 'Flow', unit: 'm3/h', role: 'input', value: 431 },
    { symbol: 'd', name: 'Internal diameter', unit: 'mm', role: 'input', value: 300 },
    { symbol: 'pi', name: 'Pi', unit: '-', role: 'constant', value: 3.14159 },
    { symbol: 'A', name: 'Bore area', unit: 'm2', role: 'output' },
    { symbol: 'v', name: 'Mean velocity', unit: 'm/s', role: 'output' },
  ],
  expressions: [
    { id: 'bore-area', resultSymbol: 'A', unit: 'm2', expression: '{pi} * ({d} / 1000) * ({d} / 1000) / 4', note: 'Diameter from mm to m.' },
    { id: 'velocity', resultSymbol: 'v', unit: 'm/s', expression: '({Q} / 3600) / {A}', latex: 'v = \\frac{Q}{A}', note: 'Flow from m³/h to m³/s. The PS3 delivery main runs at about 1.7 m/s at duty.' },
  ],
  classifications: [
    {
      id: 'velocity-band', domain: ['Slow', 'Normal', 'Fast'],
      criteria: {
        Slow: 'Below 0.6 m/s: sediment settles, and a magnetic flow meter reads poorly.',
        Normal: '0.6 to 2.5 m/s.',
        Fast: 'Above 2.5 m/s: surge on a trip gets serious; check the valve closing time.',
      },
    },
  ],
};

export function generate() {
  return {
    nodes: [
      {
        id: 'formula-pump-specific-energy', kind: 'formula', tier: 'team',
        title: 'Pump station specific energy and duty cost',
        body: 'Works PS3 from duty point to annual running cost: hydraulic power, drive-train losses, time-of-use tariff, and the specific energy (kWh/m³) that says whether the station is well matched.',
        offset: -80, tags: ['pumphouse', 'reference'], meta: { spec: pumpSpec },
      },
      {
        id: 'formula-battery-autonomy', kind: 'formula', tier: 'client',
        title: 'Battery autonomy for a grid outage',
        body: 'How long a battery carries PS3 with the grid down. The standby power findings rest on this number: 350 kWh nameplate carries one pump for 4.6 hours at night.',
        offset: -16, tags: ['island', 'sizing'], meta: { spec: autonomySpec },
      },
      {
        id: 'formula-pipe-velocity', kind: 'formula', tier: 'private',
        title: 'Pipe velocity check',
        body: 'Quick site check: flow and bore in, velocity out, with a band that says when to worry about sediment or surge.',
        offset: -70, tags: ['reference'], meta: { spec: velocitySpec },
      },
    ],
  };
}
