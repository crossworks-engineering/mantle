// Personal life: LATHE (workshop restoration with Jamie), TRAILRUN (training
// block with Wren), and the work-week journals. Mantle is a whole-life brain;
// the demo has to read like one.
const LATHE_MOMENTS = [
  'Stripped the apron gearbox; every gear usable, every felt wiper perished. Ordered felt sheet.',
  'The ways cleaned up better than expected under the surface rust — honest machine underneath.',
  'Backgear engagement lever was bodged with a coach bolt at some point. Made a proper pin.',
  'Jamie degreased the change gears while I did the tailstock. Kitchen smells of solvent; noted for next time.',
  'Headstock bearing play measured 0.08 mm — too much. The hunt for a replacement begins.',
  'Every supplier says the same thing: obsolete taper roller size. Sam Pruitt of all people had a contact.',
  'Bearing arrived. An evening of careful heating and it seated like it was meant to be there.',
  'Spindle runs true at 0.01 mm. Cut the first test bar tonight — slight taper, adjusted the tailstock offset.',
  'Painted the base in machine grey. Jamie voted for green; the machine voted grey.',
  'First real part: a bush for the garden gate hinge. The gate has never swung so well.',
];
const RUN_MOMENTS = [
  'Easy 8k with Wren along the coast path. Legs fine, conversation better.',
  'Intervals at the track: 6 × 800. The fifth one always lies about how the sixth will feel.',
  'Long run 18k, last 4 into a headwind. Practised eating on the move; jury still out on the fig bars.',
  'Rest week. Wren enforced it by hiding my shoes, allegedly as a book-club agenda item.',
  'Rolled the left ankle on the descent at the quarry turn. Walked it off but strapping it for a fortnight.',
  'Ankle behaving. Kept to the flat route, shorter stride, no drama.',
  'Hill repeats with the club. The trail half has 600 m of climb; no hiding from it.',
  'Longest run of the block: 21k on the race route. The last climb is honest; the taper is earned.',
];
const WORK_REFLECTIONS = [
  'Commissioning plans are where optimism goes to be audited.',
  'Rehearsed the changeover in my head on the drive home. Twice. The second time it went better.',
  'Feasibility work is a strange pleasure: you get paid to find out whether the answer is no.',
  'Good site day. The kind where the checklist feels like a colleague, not a form.',
  'Spent the morning untangling the pipeline table; spent the afternoon glad it exists.',
  'Bekker’s review comments were right, which is the annoying kind of right that makes the procedure better.',
  'The studio hums when everyone is on the right project. This week it hummed.',
  'Lead-time news from Sam again. Wrote the mitigation before the frustration; growth.',
  'Draft findings out to Ingrid. Writing for a board is a different muscle — one page, no acronyms, no hedging.',
  'Friday workshop afternoon defended successfully. The lathe repays attention like nothing else.',
];

export function generate(rngRoot) {
  const rng = rngRoot.fork('personal');
  const nodes = [], tables = [], emails = [], filesOut = [], turns = [];

  // ── LATHE journals + notes ────────────────────────────────────────────────
  LATHE_MOMENTS.forEach((m, i) => {
    const off = -170 + i * 17 + rng.int(0, 4); // weekend cadence; bearing saga resolves ~-20
    nodes.push({
      id: `lathe-journal-${String(i + 1).padStart(2, '0')}`, kind: 'journal', branch: 'personal.lathe',
      title: `Workshop — ${['teardown', 'cleaning', 'backgear', 'change gears', 'headstock', 'the hunt', 'bearing day', 'first cut', 'paint', 'first part'][i]}`,
      body: m + (i === 4 ? ' The headstock is the heart of the machine; no point pretending otherwise.' : ''),
      offset: off, tags: ['lathe', 'workshop'], meta: { mood: ['content', 'content', 'satisfied', 'amused', 'concerned', 'determined', 'delighted', 'proud', 'content', 'proud'][i], category: 'personal' },
    });
  });
  const latheNotes = [
    ['lathe-note-model', 'Lathe details and serial', 'A 1968 bench lathe, 9-inch swing. Serial places it late in the production run. Original motor plate intact.'],
    ['lathe-note-bearing-specs', 'Headstock bearing measurements', 'Front taper roller: obsolete size, 0.08 mm measured play. Replacement sourced via a Brightpath contact of Sam Pruitt’s — the parts hunt that ate three weekends.'],
    ['lathe-note-shopping', 'Parts and consumables list', 'Felt sheet, way oil, machine grey enamel, drive belt, HSS blanks. Costs tracked in the parts table.'],
    ['lathe-note-test-bar', 'Test bar results', 'First cut showed 0.03 mm taper over 150 mm; tailstock offset adjusted; second cut within 0.01. Good enough for a garden gate, and for most things after it.'],
  ];
  latheNotes.forEach(([id, title, body], i) =>
    nodes.push({ id, kind: 'note', branch: 'personal.lathe', title, body, offset: -150 + i * 35, tags: ['lathe'], meta: {} }));

  tables.push({
    id: 'lathe-parts', branch: 'personal.lathe', title: 'Lathe restoration — parts & costs',
    columns: [
      { name: 'Item', type: 'text' }, { name: 'Source', type: 'text' },
      { name: 'Cost', type: 'currency' }, { name: 'Qty', type: 'number' },
      { name: 'Line total', type: 'formula', formula: '{Cost} * {Qty}' },
    ],
    rows: [
      ['Headstock taper roller bearing', 'via Brightpath contact', 86, 1, null],
      ['Felt sheet (way wipers)', 'model shop', 12, 2, null],
      ['Way oil (1L)', 'machine supplies', 18, 2, null],
      ['Machine grey enamel', 'hardware', 22, 1, null],
      ['Drive belt', 'bearing supplier', 31, 1, null],
      ['HSS tool blanks', 'machine supplies', 9, 6, null],
    ],
    aggregates: { 'Line total': 'sum' }, offset: -60,
  });
  for (let i = 0; i < 12; i++) {
    filesOut.push({
      id: `lathe-photo-${String(i + 1).padStart(2, '0')}`, kind: 'png', branch: 'personal.lathe',
      name: `lathe-${['teardown', 'ways', 'headstock', 'bearing', 'paint', 'done'][i % 6]}-${String(i + 1).padStart(2, '0')}.png`,
      title: `Lathe photo ${i + 1}`, pngSeed: 140 + i, text: ['workshop lathe restoration photo'],
      offset: -165 + i * 14,
    });
  }
  nodes.push({
    id: 'lathe-plan-page', kind: 'page', branch: 'personal.lathe', title: 'Lathe restoration plan',
    body: '# Lathe restoration plan\n\nTeardown → clean → assess → headstock bearing → reassemble → align → paint → first part. One rule: the machine tells the order; the plan just writes it down. Costs in the parts table; the bearing hunt gets its own note because it earned one.',
    offset: -172, tags: ['lathe'], meta: {},
  });

  // ── TRAILRUN journals + events ────────────────────────────────────────────
  RUN_MOMENTS.forEach((m, i) => {
    nodes.push({
      id: `run-journal-${String(i + 1).padStart(2, '0')}`, kind: 'journal', branch: 'personal.trailrun',
      title: `Training — week ${i + 1}`,
      body: m, offset: -80 + i * 10 + rng.int(0, 3),
      tags: ['trailrun', 'training'], meta: { mood: ['content', 'tired', 'strong', 'amused', 'worried', 'relieved', 'determined', 'ready'][i], category: 'personal' },
    });
  });
  for (let i = 0; i < 12; i++) {
    const off = -78 + i * 8;
    if (off > 6) break;
    nodes.push({
      id: `run-event-${String(i + 1).padStart(2, '0')}`, kind: 'event', branch: 'personal.trailrun',
      title: rng.pick(['Club run', 'Intervals', 'Long run', 'Hill repeats']),
      body: 'Training block session with Wren.',
      offset: off, tags: ['trailrun'], meta: { start_offset: off, duration_min: 75, location: 'coast path' },
    });
  }
  nodes.push({
    id: 'run-event-taper', kind: 'event', branch: 'personal.trailrun', title: 'Taper begins',
    body: 'Volume down, sleep up. Wren is enforcing.', offset: 7, tags: ['trailrun'],
    meta: { start_offset: 7, duration_min: 0, location: '' },
  });
  nodes.push({
    id: 'run-event-race', kind: 'event', branch: 'personal.trailrun', title: 'Coastal Trail Half — race day',
    body: '21.1k, 600 m of climb. Number pinned, fig bars ejected from the plan.', offset: 21, tags: ['trailrun', 'race'],
    meta: { start_offset: 21, duration_min: 180, location: 'Coastal trail start' },
  });
  const runNotes = [
    ['run-note-plan', 'Twelve-week plan', 'Three sessions a week: one quality, one club, one long. The long run owns Sunday. Taper begins a fortnight out; the plan survives contact with the ankle only because rest weeks were in it from the start.'],
    ['run-note-kit', 'Race kit list', 'Shoes (the grippy pair), vest, 500 ml soft flasks × 2, gels that are not fig bars, strapping tape for the ankle, drop bag for the finish.'],
    ['run-note-route', 'Race route notes', 'Two climbs that matter: the quarry turn (where the ankle went) and the honest one at 17k. Descend the first like an adult.'],
  ];
  runNotes.forEach(([id, title, body], i) =>
    nodes.push({ id, kind: 'note', branch: 'personal.trailrun', title, body, offset: -70 + i * 25, tags: ['trailrun'], meta: {} }));

  // ── Work-week journals ────────────────────────────────────────────────────
  for (let i = 0; i < 40; i++) {
    const off = -176 + i * 4.4 + rng.float() * 2;
    if (off > -0.5) break;
    nodes.push({
      id: `work-journal-${String(i + 1).padStart(2, '0')}`, kind: 'journal', branch: 'personal.journal',
      title: `Week notes`, body: rng.pick(WORK_REFLECTIONS),
      offset: Math.round(off * 10) / 10, tags: ['reflection'],
      meta: { mood: rng.pick(['content', 'tired', 'energised', 'thoughtful', 'satisfied']), category: 'work' },
    });
  }

  // ── Personal emails ───────────────────────────────────────────────────────
  const personalMail = [
    ['jamie.carter@example.net', ['alex@harbourlabs.example.com'], 'Saturday: paint or bearings?', -25, 'Your choice this weekend: we paint the base or you disappear into the headstock again. I have opinions about green, for the record.'],
    ['alex@harbourlabs.example.com', ['jamie.carter@example.net'], 'RE: Saturday: paint or bearings?', -24.8, 'Bearing seated last night — so paint! Machine grey though. The machine has spoken and it is not a green machine.'],
    ['wren.adler@example.net', ['alex@harbourlabs.example.com'], 'Taper rules (non-negotiable)', 6, 'Taper starts Monday: half volume, no hills, no heroics at the quarry turn. Book club doubles as carb loading, I have decided. Bring the good bread.'],
    ['alex@harbourlabs.example.com', ['wren.adler@example.net'], 'RE: Taper rules (non-negotiable)', 6.2, 'Accepted on all counts. Ankle is strapped, fig bars are banned, bread is sourced. See you at the track Thursday for the last easy one.'],
  ];
  personalMail.forEach(([from, to, subject, off, body], i) =>
    emails.push({ id: `personal-mail-${i + 1}`, thread: i < 2 ? 'lathe-weekend' : 'race-taper', subject, from, to, cc: [], offset: off, body }));

  // ── Turns ─────────────────────────────────────────────────────────────────
  turns.push(
    { id: 'turn-personal-1', agent: 'assistant', offset: -2, prompt: 'How did the lathe headstock bearing saga end?' },
    { id: 'turn-personal-2', agent: 'assistant', offset: 5, prompt: 'When does the taper start and what is left in the training block before race day?' },
    { id: 'turn-personal-3', agent: 'assistant', offset: -22, prompt: 'What has the total spend on the lathe restoration been so far?' },
  );

  return { nodes, tables, emails, files: filesOut, docs: [], turns };
}
