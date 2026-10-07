// TABLES: five, one per sharing level plus one extra team table.
//
// Every number is consistent with the rest of the story: the load profile
// (one pump is 65 kW at PS3) feeds the battery autonomy formula and the
// standby findings page; the I/O schedule shows exactly what loop check day 1
// covered; the snag list holds what the progress minutes talk about.

// Station load by pumps running: idle (RTU, lights, heaters), one pump, two.
const LOAD = { 0: 4, 1: 65, 2: 124 };
const PUMPS_BY_HOUR = [1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 0, 0, 0, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1];
const SOLAR_BY_HOUR = [0, 0, 0, 0, 0, 0, 0, 2, 8, 16, 24, 30, 33, 31, 25, 17, 8, 2, 0, 0, 0, 0, 0, 0];

export function generate() {
  const tables = [];

  tables.push({
    id: 'tbl-io-schedule', tier: 'team', title: 'PS3 I/O schedule', icon: '📟', offset: -18,
    columns: [
      { name: 'Tag', type: 'text' },
      { name: 'Signal', type: 'text' },
      { name: 'Type', type: 'select', options: ['AI', 'AO', 'DI', 'DO'] },
      { name: 'Range', type: 'text' },
      { name: 'Loop checked', type: 'checkbox' },
      { name: 'Checked on', type: 'date' },
      { name: 'Witness', type: 'select', options: ['Tessa', 'Lena'] },
    ],
    rows: [
      ['LT-101', 'Wet well level', 'AI', '0 to 6 m', true, -12, 'Tessa'],
      ['FT-201', 'Delivery flow', 'AI', '0 to 600 m3/h', true, -12, 'Tessa'],
      ['PT-301', 'Delivery pressure', 'AI', '0 to 10 bar', true, -12, 'Tessa'],
      ['P-101.RUN', 'Duty pump running', 'DI', 'on/off', true, -12, 'Tessa'],
      ['P-102.RUN', 'Standby pump running', 'DI', 'on/off', true, -12, 'Tessa'],
      ['MAINS.OK', 'Mains supply healthy', 'DI', 'on/off', true, -12, 'Tessa'],
      ['DOOR.OPEN', 'Kiosk door open', 'DI', 'on/off', true, -12, 'Tessa'],
      ['P-101.FLT', 'Duty pump fault', 'DI', 'on/off', false, null, null],
      ['XV-401.POS', 'Delivery valve position', 'AI', '0 to 100 %', false, null, null],
      ['XV-401.CMD', 'Delivery valve command', 'AO', '0 to 100 %', false, null, null],
      ['GEN.RUN', 'Standby generator running', 'DI', 'on/off', false, null, null],
      ['RTU.BATT', 'RTU battery voltage', 'AI', '0 to 30 V', false, null, null],
    ],
    aggregates: { Tag: 'count' },
    views: [
      { name: 'Still to check (day 2)', filters: [{ column: 'Loop checked', op: 'eq', value: false }], sort: [{ column: 'Tag', dir: 'asc' }] },
      { name: 'Analogue signals', filters: [{ column: 'Type', op: 'eq', value: 'AI' }] },
    ],
  });

  tables.push({
    id: 'tbl-load-profile', tier: 'team', title: 'PS3 load profile, typical winter day', icon: '⚡', offset: -29,
    columns: [
      { name: 'Hour', type: 'text' },
      { name: 'Pumps running', type: 'number' },
      { name: 'Station load (kW)', type: 'number' },
      { name: 'Solar (kW)', type: 'number' },
      { name: 'Net import (kW)', type: 'formula', formula: '{Station load (kW)} - {Solar (kW)}' },
    ],
    rows: PUMPS_BY_HOUR.map((p, h) => [`${String(h).padStart(2, '0')}:00`, p, LOAD[p], SOLAR_BY_HOUR[h], null]),
    aggregates: { 'Station load (kW)': 'sum', 'Solar (kW)': 'sum', 'Pumps running': 'avg' },
    views: [
      { name: 'Two pumps running', filters: [{ column: 'Pumps running', op: 'eq', value: 2 }] },
      { name: 'Highest load first', sort: [{ column: 'Station load (kW)', dir: 'desc' }] },
    ],
  });

  tables.push({
    id: 'tbl-snag-list', tier: 'client', title: 'PS3 snag list', icon: '📋', offset: -10,
    columns: [
      { name: 'Ref', type: 'text' },
      { name: 'Snag', type: 'text' },
      { name: 'Where', type: 'select', options: ['Roof', 'RTU cabinet', 'Pipework', 'Marshalling box', 'Control room', 'Generator shed'] },
      { name: 'Severity', type: 'select', options: ['Low', 'Medium', 'High'] },
      { name: 'Owner', type: 'select', options: ['Harbour Labs', 'Meridian'] },
      { name: 'Status', type: 'select', options: ['Open', 'Closed'] },
      { name: 'Due', type: 'date' },
    ],
    rows: [
      ['S-01', 'Radio mast earth strap loose at the base clamp', 'Roof', 'Medium', 'Harbour Labs', 'Closed', -10],
      ['S-02', 'DOOR.OPEN wired normally closed; the schedule says normally open', 'RTU cabinet', 'Low', 'Harbour Labs', 'Closed', -10],
      ['S-03', 'PT-301 isolation valve stiff, will not fully close', 'Pipework', 'Medium', 'Meridian', 'Open', 5],
      ['S-04', 'Tags faded on the spare cores', 'Marshalling box', 'Low', 'Harbour Labs', 'Open', 6],
      ['S-05', 'Control room mimic shows flow in l/s; the schedule says m3/h', 'Control room', 'Medium', 'Meridian', 'Open', 6],
      ['S-06', 'GEN.RUN flickers for two seconds on generator start', 'Generator shed', 'High', 'Meridian', 'Open', 4],
    ],
    aggregates: { Ref: 'count' },
    views: [
      { name: 'Open snags', filters: [{ column: 'Status', op: 'eq', value: 'Open' }], sort: [{ column: 'Due', dir: 'asc' }] },
      { name: 'By owner', sort: [{ column: 'Owner', dir: 'asc' }, { column: 'Due', dir: 'asc' }] },
    ],
  });

  tables.push({
    id: 'tbl-budget', tier: 'private', title: 'Project budget', icon: '💰', offset: -9,
    columns: [
      { name: 'Line', type: 'text' },
      { name: 'Project', type: 'select', options: ['PUMPHOUSE', 'ISLAND'] },
      { name: 'Budget', type: 'currency', format: { decimals: 0 } },
      { name: 'Spent', type: 'currency', format: { decimals: 0 } },
      { name: 'Remaining', type: 'formula', formula: '{Budget} - {Spent}', format: { decimals: 0 } },
    ],
    rows: [
      ['Design and procedures (rev A, rev B)', 'PUMPHOUSE', 48000, 44100, null],
      ['Loop checks and commissioning', 'PUMPHOUSE', 36000, 12800, null],
      ['Site expenses and calibrator hire', 'PUMPHOUSE', 6000, 3900, null],
      ['Load profile and storage sizing', 'ISLAND', 14000, 11200, null],
      ['Findings report and meeting', 'ISLAND', 9000, 2100, null],
    ],
    aggregates: { Budget: 'sum', Spent: 'sum', Remaining: 'sum' },
    views: [{ name: 'By project', sort: [{ column: 'Project', dir: 'asc' }] }],
  });

  tables.push({
    id: 'tbl-battery-options', tier: 'public', title: 'Battery options compared', icon: '🔋', offset: -16,
    columns: [
      { name: 'Option', type: 'text' },
      { name: 'Chemistry', type: 'select', options: ['LFP', 'NMC'] },
      { name: 'Usable kWh', type: 'number' },
      { name: 'Price', type: 'currency', format: { decimals: 0 } },
      { name: 'Cycle life', type: 'number' },
      { name: 'Price per kWh', type: 'formula', formula: '{Price} / {Usable kWh}', format: { decimals: 0 } },
    ],
    rows: [
      ['Container, 300 kWh', 'LFP', 300, 186000, 6000, null],
      ['Container, 350 kWh', 'LFP', 350, 209000, 6000, null],
      ['Container, 400 kWh', 'LFP', 400, 232000, 6000, null],
      ['Racked, 300 kWh', 'NMC', 300, 171000, 3500, null],
    ],
    aggregates: { 'Usable kWh': 'max' },
    views: [{ name: 'Cheapest per kWh', sort: [{ column: 'Price per kWh', dir: 'asc' }] }],
  });

  return { tables };
}
