// ISLAND — Copperline campus microgrid feasibility study.
// Research-shaped: long pages (one with a mermaid diagram), load-profile
// tables with formula columns, reference files, the data-request thread,
// and a live deadline (+14d) the demo's tasks and turns point at.
import { first } from '../lib/world.mjs';
import { researchSections } from '../lib/longform.mjs';

export function generate(rngRoot) {
  const rng = rngRoot.fork('island');
  const nodes = [], tables = [], emails = [], filesOut = [], turns = [];
  const B = 'work.island';

  // ── Research pages ────────────────────────────────────────────────────────
  const pages = [
    ['island-brief', 'ISLAND study brief', 'Can the Copperline campus island for four hours through a grid outage? Commissioned by Ingrid Solberg. Deliverable: a feasibility report with storage sizing, islanding scheme options and a costed recommendation. Due in two weeks.'],
    ['island-load-analysis', 'Campus load analysis', 'Twelve months of half-hourly meter data from Theo Mokoena, cleaned and profiled. Weekday peak 640 kW at 11:00; overnight base 180 kW. The four-hour islanding window that matters is the weekday afternoon: worst case 2,280 kWh with process loads running, 1,140 kWh with non-essential loads shed. The load profile tables carry the derivations; the feasibility hinges on the shed scheme more than the battery.'],
    ['island-storage-sizing', 'Storage sizing options', 'Three candidate configurations: 1.2 MWh full-ride-through, 800 kWh with staged shedding, 600 kWh essential-only. Round-trip efficiency and inverter sizing derived in the sizing table. The 800 kWh option carries the recommendation: it survives the worst recorded afternoon with the agreed shed scheme and clears the payback threshold with room to spare.'],
    ['island-schemes', 'Islanding scheme options', 'Two schemes assessed: breaker-level islanding at the main intake (fast, but the whole campus rides on one relay), versus feeder-level with priority feeders held up (slower to arrange, degrades gracefully). Recommendation is feeder-level: peak shaving on the priority feeders alone already improves the demand-charge position, and a relay failure does not black the whole site.\n\n```mermaid\nflowchart TD\n  G[Grid intake] -->|outage detected| I{Islanding scheme}\n  I -->|breaker-level| A[Whole campus on storage]\n  I -->|feeder-level| Bf[Priority feeders held up]\n  Bf --> S[Staged load shedding]\n  S --> R[4-hour ride-through]\n  A --> R\n```'],
    ['island-standards-review', 'Standards and interconnection review', 'Interconnection requirements for islanded operation reviewed against the utility’s embedded-generation rules: anti-islanding protection stays mandatory at the intake, with the islanding scheme certified as intentional-islanding per the utility application. Nothing in the rules blocks the feeder-level scheme; the application lead time is the long pole and is on the risk register.'],
    ['island-shed-scheme', 'Load shed scheme — agreed priorities', 'Agreed with Theo on site: priority 1 process line and server room ride through; priority 2 HVAC sheds after 30 minutes; priority 3 general power and non-essential lighting shed immediately on islanding. The scheme is what turns a 2,280 kWh problem into a 1,140 kWh one — feasibility lives here, not in the battery spec.'],
    ['island-draft-findings', 'Draft findings — in review', 'Draft circulated to Ingrid for comment: feeder-level islanding, 800 kWh storage with staged shedding, four-hour ride-through demonstrated against the worst recorded afternoon. Open comments: payback sensitivity to the demand-charge assumption, and whether the peak shaving case should be priced as a separate phase. Final report due in fourteen days.'],
    ['island-risk-register', 'ISLAND risk register', 'Held risks: utility application lead time (long pole, mitigation is early submission), meter data gaps in March (interpolated, flagged in the report), demand-charge tariff change mid-study (sensitivity in the findings), single-relay failure mode of the breaker-level option (retired by choosing feeder-level).'],
  ];
  pages.forEach(([id, title, body], i) =>
    nodes.push({
      id, kind: 'page', branch: `${B}.research`, title,
      body: [`# ${title}`, '', body, '', ...researchSections(rng, { topic: 'the islanding scheme' })].join('\n'),
      offset: -55 + i * 6 + rng.int(0, 2), tags: ['island', 'research'], meta: {},
    }));

  // ── Load-profile tables with formula columns ──────────────────────────────
  const hours = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00'];
  tables.push({
    id: 'island-load-profile', branch: B, title: 'Campus load profile — weekday design day',
    columns: [
      { name: 'Hour', type: 'text' },
      { name: 'Load (kW)', type: 'number' },
      { name: 'Shed (kW)', type: 'number' },
      { name: 'Net (kW)', type: 'formula', formula: '{Load (kW)} - {Shed (kW)}' },
    ],
    rows: hours.map((h, i) => {
      const load = [420, 520, 600, 640, 610, 580, 560, 540, 500][i];
      return [h, load, Math.round(load * 0.5), null];
    }),
    aggregates: { 'Load (kW)': 'max' }, offset: -40,
  });
  tables.push({
    id: 'island-storage-options', branch: B, title: 'Storage sizing options',
    columns: [
      { name: 'Option', type: 'text' },
      { name: 'Islanding scheme', type: 'select', options: ['breaker-level', 'feeder-level'] },
      { name: 'Capacity (kWh)', type: 'number' },
      { name: 'Inverter (kW)', type: 'number' },
      { name: 'Usable @ 90% DoD (kWh)', type: 'formula', formula: '{Capacity (kWh)} * 0.9' },
      { name: 'Ride-through (h)', type: 'formula', formula: '{Capacity (kWh)} * 0.9 / 285' },
    ],
    rows: [
      ['Full ride-through', 'breaker-level', 1200, 700, null, null],
      ['Staged shedding (recommended)', 'feeder-level', 800, 400, null, null],
      ['Essential only', 'feeder-level', 600, 300, null, null],
    ],
    aggregates: {}, offset: -35,
  });

  // ── Notes ─────────────────────────────────────────────────────────────────
  const notes = [
    ['island-kickoff-note', 'ISLAND kickoff — scope agreed', `Scope agreed with ${first('ingrid-solberg')}: four-hour islanding feasibility, storage sizing, scheme options, costed recommendation. Meter data from ${first('theo-mokoena')} within the week.`],
    ['island-data-quality', 'Meter data quality check', 'March has a nine-day gap (meter comms fault). Interpolated from adjacent weeks and flagged in the report; does not move the worst-case afternoon.'],
    ['island-site-walk', 'Campus site walk with Theo', 'Walked the intake, the priority feeders and the server room. Feeder segregation is cleaner than the single-line suggested — feeder-level islanding is practical without rewiring.'],
    ['island-tariff-note', 'Demand tariff change mid-study', 'Utility revised the demand charge during the study. Payback recalculated; sensitivity added to the draft findings rather than a single number.'],
    ['island-peer-review', 'Internal review notes — storage sizing', `${first('rowan-mercer')} reviewed the sizing maths. One correction: round-trip efficiency applied twice in the essential-only case. Fixed in the sizing table; conclusion unchanged.`],
    ['island-report-plan', 'Report writing plan', 'Findings → scheme comparison → sizing → costed recommendation → phased peak-shaving option. Ingrid wants the executive summary readable by the board: one page, no acronyms.'],
  ];
  notes.forEach(([id, title, body], i) =>
    nodes.push({ id, kind: 'note', branch: B, title, body, offset: -52 + i * 8 + rng.int(0, 3), tags: ['island'], meta: {} }));

  // ── Tasks ─────────────────────────────────────────────────────────────────
  const tasks = [
    ['Write ISLAND final report', 'open', 12],
    ['Close payback sensitivity comment from Ingrid', 'open', 7],
    ['Price the peak-shaving phase as an option', 'open', 9],
    ['Submit utility intentional-islanding application draft', 'open', 14],
    ['Clean March meter data gap', 'done', -35],
    ['Agree load shed priorities with Theo', 'done', -25],
    ['Fix round-trip efficiency in essential-only case', 'done', -12],
    ['Circulate draft findings to Ingrid', 'done', -6],
  ];
  tasks.forEach(([title, status, due], i) =>
    nodes.push({
      id: `island-task-${String(i + 1).padStart(2, '0')}`, kind: 'task', branch: B, title,
      body: 'ISLAND feasibility study — final report due in fourteen days.',
      offset: status === 'done' ? due - rng.int(3, 8) : -rng.int(1, 10),
      tags: ['island'], meta: { status, due_offset: due, priority: due <= 9 && status === 'open' ? 'high' : 'normal' },
    }));

  // ── Events ────────────────────────────────────────────────────────────────
  nodes.push({
    id: 'island-event-sitewalk', kind: 'event', branch: B,
    title: 'Copperline campus site walk', body: 'Intake + priority feeders + server room with Theo.',
    offset: -38, tags: ['island'], meta: { start_offset: -38, duration_min: 180, location: 'Copperline campus' },
  });
  nodes.push({
    id: 'island-event-review', kind: 'event', branch: B,
    title: 'Draft findings review with Ingrid', body: 'Walk the draft; collect board-readability comments.',
    offset: -5, tags: ['island'], meta: { start_offset: -5, duration_min: 60, location: 'video call' },
  });
  nodes.push({
    id: 'island-event-report-due', kind: 'event', branch: B,
    title: 'ISLAND final report due', body: 'Feasibility report to Ingrid Solberg — the study deliverable.',
    offset: 14, tags: ['island', 'deadline'], meta: { start_offset: 14, duration_min: 0, location: '' },
  });

  // ── Emails ────────────────────────────────────────────────────────────────
  const thread = [
    ['alex@harbourlabs.example.com', ['theo@copperline.example.org'], 'Meter data request — twelve months half-hourly', -56, 'Theo, for the load profile we need twelve months of half-hourly import data for the campus intake, plus the server room submeter if it logs. CSV export from the metering head-end is perfect.'],
    ['theo@copperline.example.org', ['alex@harbourlabs.example.com'], 'RE: Meter data request', -54, 'Export attached for the intake. The server room submeter only logs monthly totals, sorry. Heads up: March has a gap — the meter comms card failed and took nine days to replace.'],
    ['alex@harbourlabs.example.com', ['theo@copperline.example.org'], 'RE: Meter data request', -53, 'Monthly totals will do for the server room — it rides through anyway in every scheme. We will interpolate March from adjacent weeks and flag it in the report.'],
    ['ingrid@copperline.example.org', ['alex@harbourlabs.example.com'], 'Draft findings — comments', -4, 'Alex, draft reads well. Two comments: the payback needs a sensitivity now that the demand tariff changed, and I want the peak shaving priced as a separate phase so the board can approve it independently. Executive summary length is perfect — keep it to the page.'],
  ];
  thread.forEach(([from, to, subject, off, body], i) =>
    emails.push({ id: `island-mail-${i + 1}`, thread: i < 3 ? 'island-data-request' : 'island-draft-comments', subject, from, to, cc: [], offset: off, body }));

  // ── Files ─────────────────────────────────────────────────────────────────
  filesOut.push({
    id: 'island-meter-data', kind: 'xlsx', branch: B, name: 'campus-meter-data-summary.xlsx', title: 'Campus meter data — monthly summary',
    sheet: 'Monthly',
    rows: [
      ['Month', 'Import (kWh)', 'Peak (kW)', 'Notes'],
      ...Array.from({ length: 12 }, (_, i) => [`M-${i + 1}`, 180000 + rng.int(-15000, 20000), 560 + rng.int(-40, 80), i === 2 ? 'nine-day gap interpolated' : '']),
    ],
    text: ['campus meter data monthly summary', 'import kWh', 'peak kW', 'nine-day gap interpolated'],
    offset: -50,
  });
  const refs = [
    ['island-ref-embedded-gen', 'docx', 'utility-embedded-generation-notes.docx', 'Utility embedded-generation rules — working notes',
      [{ h: 1, text: 'Embedded generation rules — what applies to intentional islanding' }, { text: 'Anti-islanding protection remains mandatory at the intake. Intentional islanding requires a certified scheme and a utility application; lead time is the project long pole.' }, { text: 'Nothing in the rules blocks feeder-level islanding. Application draft to be submitted before the final report lands.' }]],
    ['island-ref-battery-datasheet', 'pdf', 'storage-vendor-datasheet.pdf', 'Candidate storage system datasheet',
      ['Candidate storage system — datasheet extract', 'Nominal 800 kWh, 400 kW inverter, 90% usable at rated depth of discharge.', 'Round-trip efficiency quoted at 88% including inverter losses.']],
    ['island-ref-relay-note', 'pdf', 'islanding-relay-application-note.pdf', 'Islanding relay application note',
      ['Islanding detection relay — application note extract', 'Transfer time and detection thresholds for intake-level and feeder-level schemes.', 'Feeder-level schemes degrade gracefully on relay failure — the deciding argument in this study.']],
  ];
  refs.forEach(([id, kind, name, title, content], i) =>
    filesOut.push(kind === 'docx'
      ? { id, kind, branch: `${B}.research`, name, title, blocks: content, text: content.map((b) => b.text), offset: -45 + i * 10 }
      : { id, kind, branch: `${B}.research`, name, title, text: content, offset: -45 + i * 10 }));

  // ── Turns ─────────────────────────────────────────────────────────────────
  turns.push(
    { id: 'turn-island-1', agent: 'assistant', offset: -3, prompt: 'What is the ISLAND study recommending, and what are the open comments on the draft?' },
    { id: 'turn-island-2', agent: 'assistant', offset: -10, prompt: 'Why did the feasibility study choose feeder-level islanding over breaker-level?' },
    { id: 'turn-island-3', agent: 'assistant', offset: -1, prompt: 'What is due in the next two weeks across all projects?' },
  );

  return { nodes, tables, emails, files: filesOut, turns };
}
