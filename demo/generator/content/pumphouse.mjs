// PUMPHOUSE — Meridian Waterworks PS3 telemetry retrofit.
// The revision-heavy engagement: procedure families (rev A→B→C, supersession),
// site-visit series, technical queries, minutes, the snag table, the
// lead-time email saga.
import { first } from '../lib/world.mjs';

const SIGNALS = ['inlet pressure', 'discharge pressure', 'flow (delivery)', 'sump level', 'motor winding temp', 'bearing vibration', 'valve position', 'wet-well level'];
const AREAS = ['RTU panel', 'motor control centre', 'valve chamber', 'wet well', 'instrument rack', 'comms cabinet', 'standby generator bay', 'chlorine room interface'];
const OBSERVATIONS = [
  'Cable numbering on the old marshalling strip does not match the 1998 as-builts; we photographed every core before disconnection.',
  'The spare conduit into the valve chamber is waterlogged — new signal runs will need the overhead tray instead.',
  'Standby generator changeover contact chattered during test; flagged to Meridian electrical.',
  'Existing RTU battery bank swollen; isolated and tagged for disposal per site procedure.',
  'Radio path survey to the reservoir repeater is clean; margin better than expected.',
  'Panel door earth strap missing on the comms cabinet — added to the snag list.',
  'Wet-well level transmitter reads 4% high against the dip tape; scaling error in the old config.',
  'Meridian stores located the missing valve actuator brackets; delivery to site Thursday.',
];
const TQ_TOPICS = [
  ['surge protection on the analogue loops', 'Confirm whether the new surge devices are required on both ends of each analogue loop, or field end only.', 'Both ends for loops leaving the building envelope; field end only for in-panel loops. Reflected in rev C wiring notes.'],
  ['fail state of the delivery valve', 'On comms loss, should the delivery valve hold last position or drive closed?', 'Hold last position. Driving closed on a comms blip would trip the main on deadhead — see incident note from the March test.'],
  ['telemetry poll rate', 'Requested poll rate is 5 s but the licence tier caps at 30 s. Which governs?', '30 s for trend points; alarms are event-driven so the cap does not affect alarm latency.'],
  ['sump pump interlock', 'Does the sump pump interlock migrate to the new RTU or stay hardwired?', 'Stays hardwired. Safety interlocks do not move to software — noted in the changeover procedure prerequisites.'],
  ['spares holding', 'What spares should Meridian hold for the new I/O modules?', 'One of each card type per station, two of the 8-ch analogue input — highest failure rate in the fleet.'],
  ['loop check witness', 'Does Meridian require witnessed loop checks for every point or a sample?', 'Every alarm and control point witnessed; 20% sample for trend-only points. Lena to witness.'],
];

const PROC_FAMILIES = [
  {
    fam: 'proc-changeover', title: 'PS3 Telemetry Changeover Procedure',
    scope: 'controlled changeover of Pump Station 3 telemetry from the legacy outstation to the new RTU',
    revNotes: {
      A: 'Initial issue for review.',
      B: 'Rev B: scope extended to include the standby generator signals after Gordon Bekker’s review — changeover window widened to two shifts, generator changeover contact added to the pre-checks.',
      C: 'Rev C: loop-check order corrected per Lena Marsh — alarm points now witnessed BEFORE trend points, and the delivery-valve fail-state note from TQ-002 folded into step 9.',
    },
  },
  {
    fam: 'proc-loopcheck', title: 'PS3 Loop Check Procedure',
    scope: 'point-by-point verification of every migrated I/O loop against the new RTU database',
    revNotes: {
      A: 'Initial issue.',
      B: 'Rev B: witness requirements table added (every alarm/control point witnessed; 20% sample for trend points).',
      C: 'Rev C: analogue scaling verification moved ahead of alarm simulation — the wet-well transmitter scaling error showed why order matters.',
    },
  },
  {
    fam: 'proc-cutover', title: 'RTU Cutover & Rollback Procedure',
    scope: 'final cutover of live control to the new RTU, and the tested path back to the legacy outstation if acceptance fails',
    revNotes: {
      A: 'Initial issue.',
      B: 'Rev B: rollback window extended to 72 h of parallel running before the legacy outstation is de-energised.',
      C: 'Rev C: comms-loss drill added as a mandatory acceptance step; hold-last-position behaviour verified live.',
    },
  },
];

function procedureBody(rng, famDef, rev) {
  const steps = [];
  const stepPool = [
    'Confirm permit to work is issued and displayed at the MCC.',
    'Verify the legacy outstation is in local mode and Meridian control room has acknowledged the outage window.',
    'Photograph the marshalling strip before lifting any core.',
    'Transfer signal cores one loop at a time; never bulk-lift a strip.',
    'For each transferred loop, complete the loop-check record and obtain the witness signature.',
    'Simulate each alarm point from the field end and confirm receipt at the control room.',
    'Verify analogue scaling at 0%, 50% and 100% of range against the calibrator.',
    'Confirm the delivery valve holds last position on a forced comms loss.',
    'Run the standby generator changeover and confirm all generator signals report correctly.',
    'Record the RTU configuration checksum in the commissioning file.',
    'Return the station to remote and observe one full pump cycle under control-room command.',
    'Complete the daily changeover log and email the scanned record to the project coordinator.',
  ];
  const chosen = stepPool.slice(0, 8 + rng.int(0, 4));
  chosen.forEach((s, i) => steps.push(`${i + 1}. ${s}`));
  return [
    `# ${famDef.title} — Rev ${rev}`, '',
    `**Document:** ${famDef.fam.toUpperCase()}-${rev} · **Project:** PUMPHOUSE · **Client:** Meridian Waterworks`, '',
    '## Purpose', `This procedure controls the ${famDef.scope}. It exists so that a changeover on a live water asset is boring: every step known, every rollback tested, every signature collected.`, '',
    '## Scope', `Applies to Pump Station 3 (PS3) only. Signals in scope: ${rng.pickN(SIGNALS, 5).join(', ')}. The sump pump safety interlock remains hardwired and is explicitly out of scope.`, '',
    '## References', '- PS3 I/O schedule (project file)', '- Meridian permit-to-work procedure', '- TQ register (technical queries raised on this project)', '',
    '## Prerequisites', '- Outage window agreed with the Meridian control room', '- Loop-check records printed and witness availability confirmed', '- Rollback path verified within the last 7 days', '',
    '## Safety', 'PS3 remains a live water asset throughout. No safety interlock is ever transferred to software. If any step fails twice, stop and invoke the rollback procedure — do not improvise on site.', '',
    '## Steps', ...steps, '',
    '## Verification', 'The changeover is complete only when one full pump cycle has run under control-room command with all telemetry healthy, and the commissioning file holds a signed loop-check record for every point.', '',
    '## Revision history', `- Rev ${rev}: ${famDef.revNotes[rev]}`,
  ].join('\n');
}

export function generate(rngRoot) {
  const rng = rngRoot.fork('pumphouse');
  const nodes = [], tables = [], emails = [], filesOut = [], turns = [];
  const B = 'work.pumphouse';

  // ── Procedure families: rev A (-120) → B (-45) → C (-10) ──────────────────
  const revOffsets = { A: -120, B: -45, C: -10 };
  for (const famDef of PROC_FAMILIES) {
    let prev = null;
    for (const rev of ['A', 'B', 'C']) {
      const id = `${famDef.fam}-rev-${rev.toLowerCase()}`;
      nodes.push({
        id, kind: 'page', branch: `${B}.procedures`,
        title: `${famDef.title} — Rev ${rev}`,
        body: procedureBody(rng, famDef, rev),
        offset: revOffsets[rev] + rng.int(0, 2), tags: ['pumphouse', 'procedure'],
        meta: { family: famDef.fam, rev, supersedes: prev },
      });
      prev = id;
    }
  }

  // ── Commissioning plan (long doc → many chunks) ───────────────────────────
  nodes.push({
    id: 'pump-commissioning-plan', kind: 'page', branch: B,
    title: 'PS3 Commissioning Plan',
    body: [
      '# PS3 Commissioning Plan', '',
      'The commissioning window opens seven days from now. This plan sequences the changeover, loop checks and cutover so Meridian keeps water moving throughout.', '',
      '## Sequence',
      '1. Pre-checks and permit (day 1 morning)',
      '2. Telemetry changeover per procedure (day 1–2)',
      '3. Loop checks, witnessed (day 2–3)',
      '4. 72 h parallel running',
      '5. Cutover and acceptance, including the comms-loss drill',
      '',
      '## Witness plan',
      `Lena Marsh witnesses all alarm and control points. ${first('gordon-bekker')} signs the acceptance certificate. Harbour Labs provides two engineers on site for the full window: Tessa on telemetry, Rowan on mechanical standby.`,
      '',
      '## Risks held open',
      '- Brightpath lead time on the spare 8-ch analogue card — see the running email thread; commissioning proceeds with the bench spare if delivery slips again.',
      '- Radio path to the reservoir repeater re-checked the week before; margin recorded in the site file.',
      '',
      '## Hold points',
      'A failed step repeated twice is a hold point: stop, log, and either invoke rollback or raise a TQ. The snag list is reviewed at the end of every commissioning day.',
    ].join('\n'),
    offset: -8, tags: ['pumphouse', 'commissioning'], meta: {},
  });

  // ── Misc project pages ────────────────────────────────────────────────────
  const miscPages = [
    ['pump-io-schedule-summary', 'PS3 I/O Schedule — summary', 'Summary of the point count by type: 34 digital in, 12 digital out, 16 analogue in, 4 analogue out. Full schedule lives in the project xlsx. The telemetry changeover transfers all except the hardwired sump interlock.'],
    ['pump-radio-survey', 'Reservoir repeater radio survey', 'Path survey results for the telemetry link: clean line of sight, fade margin comfortably above the design threshold in both directions. Survey repeated after the mast extension; no change.'],
    ['pump-rtu-config-notes', 'RTU configuration notes', 'Running notes on the RTU database build: poll rates per the TQ ruling (30 s trends, event-driven alarms), scaling verified against the calibrator, config checksum recorded per cutover procedure.'],
    ['pump-incident-march', 'March deadhead incident — what it taught us', 'During an early test the delivery valve drove closed on a comms blip and the main tripped on deadhead. This is why the fail state is hold-last-position, why the comms-loss drill is mandatory at acceptance, and why TQ-002 exists.'],
    ['pump-fat-report', 'Factory acceptance test — RTU panel', 'FAT completed at the Brightpath works: all I/O simulated, generator changeover contact exercised, punch items closed except the door earth strap (carried to site snag list).'],
  ];
  miscPages.forEach(([id, title, body], i) =>
    nodes.push({ id, kind: 'page', branch: B, title, body: `# ${title}\n\n${body}`, offset: -100 + i * 18 + rng.int(0, 5), tags: ['pumphouse'], meta: {} }));

  // ── Site-visit reports (note series) ──────────────────────────────────────
  for (let i = 0; i < 24; i++) {
    const off = -150 + Math.round(i * 6.2) + rng.int(0, 2);
    if (off > -1) break;
    const visitors = rng.pickN(['tessa-okafor', 'rowan-mercer', 'june-castellanos'], rng.int(1, 2));
    nodes.push({
      id: `pump-site-visit-${String(i + 1).padStart(2, '0')}`, kind: 'note', branch: `${B}.site`,
      title: `PS3 site visit — day ${i + 1}`,
      body: [
        `Attendees: ${visitors.map(first).join(', ')} (Harbour Labs); ${first(rng.pick(['gordon-bekker', 'lena-marsh']))} (Meridian).`, '',
        `Area focus: ${rng.pick(AREAS)}.`, '',
        `Observations:`, `- ${rng.pick(OBSERVATIONS)}`, `- ${rng.pick(OBSERVATIONS)}`, '',
        `Actions: ${rng.pick(['photograph and file before next visit', 'raise on the snag list', 'carry to the fortnightly minutes', 'raise a TQ if Meridian confirms'])}.`,
      ].join('\n'),
      offset: off, tags: ['pumphouse', 'site-visit'], meta: {},
    });
  }

  // ── Technical queries (paired question/answer notes) ──────────────────────
  TQ_TOPICS.forEach(([topic, q, a], i) => {
    const n = String(i + 1).padStart(3, '0');
    const raised = -110 + i * 16 + rng.int(0, 4);
    nodes.push({
      id: `pump-tq-${n}`, kind: 'note', branch: B,
      title: `TQ-${n}: ${topic}`,
      body: `**Raised by:** ${first(rng.pick(['lena-marsh', 'tessa-okafor']))} · **Status:** answered\n\n**Query:** ${q}\n\n**Answer:** ${a}`,
      offset: raised, tags: ['pumphouse', 'tq'], meta: {},
    });
    nodes.push({
      id: `pump-tq-${n}-followup`, kind: 'note', branch: B,
      title: `TQ-${n} follow-up — closure note`,
      body: `Closure confirmed with Meridian; answer reflected in the current procedure revision where applicable. Lead time impact: ${rng.pick(['none', 'none', 'one week on panel mods', 'absorbed in the commissioning float'])}.`,
      offset: raised + rng.int(3, 8), tags: ['pumphouse', 'tq'], meta: {},
    });
  });

  // ── Fortnightly minutes ───────────────────────────────────────────────────
  for (let i = 0; i < 10; i++) {
    const off = -140 + i * 14;
    nodes.push({
      id: `pump-minutes-${String(i + 1).padStart(2, '0')}`, kind: 'note', branch: B,
      title: `PUMPHOUSE progress meeting — minutes #${i + 1}`,
      body: [
        `Present: Alex, ${first('tessa-okafor')}, ${first('june-castellanos')} (Harbour Labs); ${first('gordon-bekker')}, ${first('lena-marsh')} (Meridian).`, '',
        '1. Programme: ' + rng.pick(['on track for the commissioning window', 'one week pressure from panel lead time', 'recovered the slip from the valve chamber rework']),
        '2. Snag list reviewed; ' + rng.int(2, 6) + ' items closed since last meeting.',
        '3. Lead time: Brightpath ' + rng.pick(['holding the promised date', 'slipped a week — escalated to Sam Pruitt', 'confirmed partial shipment']),
        '4. Next review gate: procedure revision status checked against the commissioning plan.',
      ].join('\n'),
      offset: off, tags: ['pumphouse', 'minutes'], meta: {},
    });
  }

  // ── Snag table ────────────────────────────────────────────────────────────
  const snagRows = [];
  const snagDescs = [
    'Door earth strap missing on comms cabinet', 'Legacy cable cores unlabelled at MCC end', 'Conduit into valve chamber waterlogged',
    'RTU battery bank swollen — disposal', 'Wet-well transmitter scaling 4% high', 'Panel light fitting loose', 'As-built drawing mismatch at marshalling strip',
    'Generator changeover contact chatter', 'Spare gland plate not fitted', 'Antenna feeder not weatherproofed', 'Label schedule incomplete for analogue rack',
    'Trip hazard: cable tray offcut in walkway',
  ];
  for (let i = 0; i < 34; i++) {
    const d = snagDescs[i % snagDescs.length] + (i >= snagDescs.length ? ` (${AREAS[i % AREAS.length]})` : '');
    snagRows.push([
      `SNG-${String(i + 1).padStart(3, '0')}`, rng.pick(AREAS), d,
      first(rng.pick(['tessa-okafor', 'rowan-mercer', 'lena-marsh'])),
      rng.pick(['open', 'open', 'closed', 'closed', 'closed', 'in progress']),
      rng.int(-30, 14),
    ]);
  }
  tables.push({
    id: 'pump-snag-list', branch: B, title: 'PS3 snag list',
    columns: [
      { name: 'Ref', type: 'text' }, { name: 'Area', type: 'select' }, { name: 'Description', type: 'text' },
      { name: 'Raised by', type: 'text' }, { name: 'Status', type: 'select' }, { name: 'Due (offset days)', type: 'number' },
    ],
    rows: snagRows, aggregates: { Status: 'count' }, offset: -60,
  });

  // ── Tasks ─────────────────────────────────────────────────────────────────
  const taskPool = [
    ['Chase Brightpath on the 8-ch analogue card lead time', 'open', 3],
    ['Book Lena Marsh for loop check witnessing', 'open', 5],
    ['Update the snag list before the commissioning walk', 'open', 2],
    ['Walk the loop check order with Tessa before the window', 'open', 4],
    ['Print loop-check records for the commissioning file', 'open', 6],
    ['Verify rollback path within 7 days of the window', 'open', 4],
    ['Close the comms cabinet earth strap snag', 'open', 2],
    ['Confirm outage window with Meridian control room', 'open', 1],
    ['File the FAT report against the project record', 'done', -40],
    ['Re-run the radio path survey after the mast extension', 'done', -55],
    ['Update the I/O schedule after the generator scope change', 'done', -42],
    ['Answer TQ-006 on witness sampling', 'done', -20],
    ['Photograph marshalling strip before disconnection', 'done', -75],
    ['Raise disposal of the swollen battery bank with Meridian', 'done', -70],
  ];
  taskPool.forEach(([title, status, due], i) =>
    nodes.push({
      id: `pump-task-${String(i + 1).padStart(2, '0')}`, kind: 'task', branch: B, title,
      body: `PUMPHOUSE. ${status === 'open' ? 'Needed before the commissioning window opens.' : 'Done — see project file.'}`,
      offset: status === 'done' ? due - rng.int(3, 10) : -rng.int(2, 20),
      tags: ['pumphouse'], meta: { status, due_offset: due, priority: status === 'open' && due <= 3 ? 'high' : 'normal' },
    }));
  // a few more done tasks for volume
  for (let i = 0; i < 18; i++) {
    nodes.push({
      id: `pump-task-x${String(i + 1).padStart(2, '0')}`, kind: 'task', branch: B,
      title: `Close snag SNG-${String(rng.int(1, 20)).padStart(3, '0')}`,
      body: 'Snag closure with photo evidence in the site file.',
      offset: -rng.int(10, 120), tags: ['pumphouse', 'snag'],
      meta: { status: 'done', due_offset: -rng.int(5, 100), priority: 'normal' },
    });
  }

  // ── Events ────────────────────────────────────────────────────────────────
  for (let i = 0; i < 8; i++) {
    const off = -150 + i * 19;
    nodes.push({
      id: `pump-event-site-${i + 1}`, kind: 'event', branch: B,
      title: `PS3 site visit`, body: 'Telemetry retrofit site day — see visit report series.',
      offset: off, tags: ['pumphouse'], meta: { start_offset: off, duration_min: 300, location: 'Pump Station 3' },
    });
  }
  nodes.push({
    id: 'pump-event-commissioning', kind: 'event', branch: B,
    title: 'PS3 commissioning window opens', body: 'Two-shift changeover per the commissioning plan; Tessa and Rowan on site.',
    offset: 7, tags: ['pumphouse', 'commissioning'], meta: { start_offset: 7, duration_min: 480, location: 'Pump Station 3' },
  });
  nodes.push({
    id: 'pump-event-acceptance', kind: 'event', branch: B,
    title: 'PS3 cutover acceptance + comms-loss drill', body: 'Acceptance per the cutover procedure rev C; Bekker signs.',
    offset: 12, tags: ['pumphouse'], meta: { start_offset: 12, duration_min: 240, location: 'Pump Station 3' },
  });

  // ── The lead-time email saga + review threads ────────────────────────────
  const saga = [
    ['s.pruitt@brightpath.example.net', ['alex@harbourlabs.example.com'], 'RE: PS3 panel — revised delivery', -95, 'Alex, the panel shop is quoting an extra two weeks on the enclosure. The RTU and I/O cards are unaffected. I know what the lead time does to your programme — options on the phone tomorrow?'],
    ['alex@harbourlabs.example.com', ['s.pruitt@brightpath.example.net'], 'RE: PS3 panel — revised delivery', -94, 'Sam, two weeks eats the whole commissioning float. Can we split the shipment — cards and RTU now, enclosure to follow? Tessa can pre-build the bench config while the enclosure is in paint.'],
    ['s.pruitt@brightpath.example.net', ['alex@harbourlabs.example.com'], 'RE: PS3 panel — revised delivery', -92, 'Split shipment agreed. Cards and RTU dispatch Friday; enclosure follows. I will confirm the 8-ch analogue spare separately — that line has its own lead time at the moment.'],
    ['h.venn@meridianww.example.org', ['alex@harbourlabs.example.com', 'june@harbourlabs.example.com'], 'PO amendment for split shipment', -90, 'Please send the amended delivery schedule for the purchase order. Procurement needs the split shipment reflected before goods receipt or the second delivery will bounce at the gate.'],
    ['june@harbourlabs.example.com', ['h.venn@meridianww.example.org'], 'RE: PO amendment for split shipment', -89, 'Amended schedule attached, Harold — two deliveries, same PO value. Gate pass request for the second delivery to follow once Brightpath confirms the enclosure date.'],
    ['s.pruitt@brightpath.example.net', ['alex@harbourlabs.example.com', 'june@harbourlabs.example.com'], '8-ch analogue spare — lead time', -30, 'The spare 8-ch analogue input card has slipped again — the line is quoting six weeks. Your commissioning plan mentioned a bench spare; I would plan around it. Sorry to be the bearer of lead-time news twice in one project.'],
    ['alex@harbourlabs.example.com', ['s.pruitt@brightpath.example.net'], 'RE: 8-ch analogue spare — lead time', -29, 'Understood. We will commission with the bench spare and swap when the production card lands. Please hold the order — Meridian still wants the fleet spare holding per TQ-005.'],
  ];
  saga.forEach(([from, to, subject, off, body], i) =>
    emails.push({ id: `pump-mail-saga-${i + 1}`, thread: 'pump-leadtime-saga', subject, from, to, cc: [], offset: off, body }));

  const revReview = [
    ['g.bekker@meridianww.example.org', ['alex@harbourlabs.example.com'], 'Changeover procedure rev A — review comments', -48, 'Alex, rev A reads well but it treats the standby generator as out of scope. If the changeover window straddles a mains event, I need those signals proven before we hand back. Please extend the scope and widen the window to two shifts.'],
    ['alex@harbourlabs.example.com', ['g.bekker@meridianww.example.org'], 'RE: Changeover procedure rev A — review comments', -46, 'Agreed on both counts, Gordon. Rev B will fold in the generator signals and the two-shift window. Tessa is updating the pre-checks; you will have rev B for approval this week.'],
    ['l.marsh@meridianww.example.org', ['tessa@harbourlabs.example.com'], 'Loop check order', -12, 'Tessa — small thing that is not small: the procedure has trend points checked before alarm points. If we lose the window early I want the alarms proven first. Can rev C swap the order?'],
    ['tessa@harbourlabs.example.com', ['l.marsh@meridianww.example.org'], 'RE: Loop check order', -11, 'You are completely right, Lena. Rev C reorders: alarms witnessed first, trends after. Same change propagated to the changeover procedure step 9. Issued today.'],
  ];
  revReview.forEach(([from, to, subject, off, body], i) =>
    emails.push({ id: `pump-mail-rev-${i + 1}`, thread: i < 2 ? 'pump-revb-review' : 'pump-revc-review', subject, from, to, cc: [], offset: off, body }));

  const siteAdmin = [
    ['l.marsh@meridianww.example.org', ['tessa@harbourlabs.example.com'], 'Snag list before the window', -7, 'Tessa — can you send the current snag list before the commissioning window? I want the comms cabinet items closed before we start the telemetry changeover, not during it.'],
    ['tessa@harbourlabs.example.com', ['l.marsh@meridianww.example.org'], 'RE: Snag list before the window', -6.5, 'Snag list attached, Lena. Comms cabinet earth strap is the only open one in that area — closing it Thursday. Everything else in the telemetry scope is clear.'],
    ['g.bekker@meridianww.example.org', ['alex@harbourlabs.example.com'], 'Changeover window — control room briefed', -5, 'Control room is briefed on the changeover window and the two-shift arrangement. Lead time on the spare noted; commissioning with your bench spare is acceptable to us provided the fleet spare still lands.'],
  ];
  siteAdmin.forEach(([from, to, subject, off, body], i) =>
    emails.push({ id: `pump-mail-admin-${i + 1}`, thread: i < 2 ? 'pump-snaglist' : 'pump-window-brief', subject, from, to, cc: [], offset: off, body }));

  // ── Files ─────────────────────────────────────────────────────────────────
  for (let i = 0; i < 10; i++) {
    filesOut.push({
      id: `pump-drawing-${String(i + 1).padStart(2, '0')}`, kind: 'pdf', branch: `${B}.site`,
      name: `PS3-DRG-${100 + i}-rev${rng.pick(['A', 'B'])}.pdf`,
      title: `PS3 drawing ${100 + i}`,
      text: [`PS3 telemetry retrofit — drawing ${100 + i}`, `Sheet: ${rng.pick(AREAS)}`, 'Issued for construction. Refer to the I/O schedule for point detail. Not to scale when printed.'],
      offset: -130 + i * 11,
    });
  }
  filesOut.push({
    id: 'pump-io-schedule-xlsx', kind: 'xlsx', branch: B, name: 'PS3-IO-schedule.xlsx', title: 'PS3 I/O schedule',
    sheet: 'IO', rows: [
      ['Tag', 'Description', 'Type', 'Range', 'Alarm'],
      ...SIGNALS.map((s, i) => [`PS3-${200 + i}`, s, i < 4 ? 'AI' : 'DI', i < 4 ? '4-20mA' : 'volt-free', i % 2 === 0 ? 'yes' : 'no']),
    ],
    text: ['PS3 I/O schedule', ...SIGNALS], offset: -115,
  });
  filesOut.push({
    id: 'pump-fat-docx', kind: 'docx', branch: B, name: 'PS3-FAT-report.docx', title: 'PS3 FAT report',
    blocks: [
      { h: 1, text: 'PS3 RTU panel — factory acceptance test' },
      { text: 'All I/O simulated end to end at the Brightpath works. Generator changeover contact exercised ten cycles without chatter after the relay swap.' },
      { text: 'Punch items: door earth strap (carried to site snag list). Witnessed by Tessa Okafor; accepted by Gordon Bekker by correspondence.' },
    ],
    text: ['PS3 RTU panel factory acceptance test', 'generator changeover', 'punch items'], offset: -58,
  });
  for (let i = 0; i < 8; i++) {
    filesOut.push({
      id: `pump-photo-${String(i + 1).padStart(2, '0')}`, kind: 'png', branch: `${B}.site`,
      name: `ps3-site-${String(i + 1).padStart(2, '0')}.png`, title: `PS3 site photo ${i + 1}`,
      pngSeed: 40 + i, text: [`PS3 site photo — ${rng.pick(AREAS)}`], offset: -140 + i * 16,
    });
  }

  // ── Scripted chat turns (P4 will run these against the real assistant) ────
  turns.push(
    { id: 'turn-pump-1', agent: 'assistant', offset: -9, prompt: 'Which revision of the PS3 telemetry changeover procedure is current, and what changed in it?' },
    { id: 'turn-pump-2', agent: 'assistant', offset: -6, prompt: 'Summarise where PS3 commissioning stands and what is still blocking the window.' },
    { id: 'turn-pump-3', agent: 'assistant', offset: -3, prompt: 'What did Lena Marsh raise about the loop check order, and where did it land?' },
    { id: 'turn-pump-4', agent: 'assistant', offset: -1, prompt: 'List the open snag list items for the comms cabinet and who raised them.' },
    { id: 'turn-pump-5', agent: 'assistant', offset: -15, prompt: 'What is the lead time situation with Brightpath and how does it affect commissioning?' },
  );

  return { nodes, tables, emails, files: filesOut, turns };
}
