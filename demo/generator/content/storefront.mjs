// STOREFRONT — Vantage Retail fit-out programme, tranche 2.
// Table-centric: the pipeline (currency + select + aggregate), budgets as
// xlsx, drawings, survey notes, the store-214 snag dispute email thread.
import { first } from '../lib/world.mjs';

const STORES = [
  { no: 208, city: 'Northgate', stage: 'practical completion', value: 412000 },
  { no: 211, city: 'Riverside', stage: 'practical completion', value: 388500 },
  { no: 214, city: 'Old Quarter', stage: 'snag dispute', value: 445200 },
  { no: 217, city: 'Harbour Mall', stage: 'install', value: 401000 },
  { no: 219, city: 'Eastfield', stage: 'install', value: 396750 },
  { no: 222, city: 'Summit Park', stage: 'procurement', value: 379900 },
  { no: 225, city: 'Westbrook', stage: 'drawings', value: 366400 },
  { no: 228, city: 'Lakeside', stage: 'survey', value: 358000 },
];
const FINISHES = ['counter laminate', 'entrance matting', 'ceiling grid', 'LED track', 'shopfront vinyl', 'back-of-house epoxy', 'fitting-room panels'];

export function generate(rngRoot) {
  const rng = rngRoot.fork('storefront');
  const nodes = [], tables = [], emails = [], filesOut = [], turns = [];
  const B = 'work.storefront';

  // ── The pipeline table (currency + select + sum aggregate) ────────────────
  tables.push({
    id: 'store-pipeline', branch: B, title: 'Tranche 2 fit-out pipeline',
    columns: [
      { name: 'Store', type: 'text' }, { name: 'City', type: 'text' },
      { name: 'Stage', type: 'select', options: ['survey', 'drawings', 'procurement', 'install', 'practical completion', 'snag dispute'] },
      { name: 'Contract value', type: 'currency' },
      { name: 'PC (offset days)', type: 'number' },
    ],
    rows: STORES.map((s) => [`Store ${s.no}`, s.city, s.stage, s.value, s.stage === 'practical completion' ? -rng.int(5, 40) : rng.int(10, 60)]),
    aggregates: { 'Contract value': 'sum' }, offset: -88,
  });

  // ── Finishes schedule table ───────────────────────────────────────────────
  tables.push({
    id: 'store-finishes', branch: B, title: 'Finishes schedule — tranche 2 standard',
    columns: [
      { name: 'Item', type: 'text' }, { name: 'Spec', type: 'text' }, { name: 'Supplier', type: 'text' }, { name: 'Lead time (weeks)', type: 'number' },
    ],
    rows: FINISHES.map((f, i) => [f, `VR-T2-${String(i + 1).padStart(2, '0')}`, i % 3 === 0 ? 'Brightpath Components' : 'programme supplier', rng.int(2, 8)]),
    aggregates: {}, offset: -80,
  });

  // ── Pages ─────────────────────────────────────────────────────────────────
  const pages = [
    ['store-tranche-overview', 'Tranche 2 overview', 'Eight stores, one standard finishes schedule, staggered starts. The pipeline table is the single source of truth for stage and value; practical completion dates feed the programme review with Nadia Flores.'],
    ['store-survey-template', 'Store survey template', 'What Dana captures on every survey: shell condition, services positions, shopfront constraints, access for the install crew, photos keyed to the drawing grid. A survey that misses services positions costs a week at install — store 217 proved it.'],
    ['store-214-dispute-summary', 'Store 214 snag dispute — position summary', 'Vantage withheld the final certificate over ceiling grid alignment and two damaged fitting-room panels. Our position: grid is within the spec tolerance (measurements filed); panels are accepted as install damage and replacement is ordered. Practical completion should not be held for the panels — proposed a retention against the panel swap instead.'],
    ['store-drawing-standards', 'Fit-out drawing standards', 'Sheet naming, revision discipline and the review gate before issue: no drawing goes to a store contractor without a second pair of eyes. The standard exists because two stores in tranche 1 were built off superseded sheets.'],
    ['store-pc-checklist', 'Practical completion checklist', 'The walk-through list used at every store: finishes against schedule, snags logged with photos, keys and O&M handover, certificate issued only when the snag list is agreed line by line.'],
    ['store-access-notes', 'Site access arrangements', 'Marcus Bell arranges out-of-hours access per store; install crews book through June. Lesson from store 211: confirm the mall’s own permit lead time, not just Vantage’s.'],
  ];
  pages.forEach(([id, title, body], i) =>
    nodes.push({ id, kind: 'page', branch: B, title, body: `# ${title}\n\n${body}`, offset: -85 + i * 13 + rng.int(0, 4), tags: ['storefront'], meta: {} }));

  // ── Survey + progress notes ───────────────────────────────────────────────
  STORES.forEach((s, i) => {
    nodes.push({
      id: `store-survey-${s.no}`, kind: 'note', branch: `${B}.stores`,
      title: `Store ${s.no} ${s.city} — survey notes`,
      body: `Surveyed by ${first('dana-whitfield')}. Shell ${rng.pick(['clean', 'needs make-good on the rear wall', 'previous tenant services still in ceiling void'])}; services ${rng.pick(['as drawing', 'power intake relocated — drawings updated', 'water point missing at counter position'])}. Shopfront ${rng.pick(['standard', 'heritage constraint — vinyl only', 'mall approval needed for signage'])}. Photos filed against the drawing grid.`,
      offset: -88 + i * 9 + rng.int(0, 3), tags: ['storefront', 'survey'], meta: {},
    });
  });
  for (let i = 0; i < 8; i++) {
    nodes.push({
      id: `store-progress-${String(i + 1).padStart(2, '0')}`, kind: 'note', branch: B,
      title: `Programme review with Vantage — notes #${i + 1}`,
      body: `Pipeline walked store by store with ${first('nadia-flores')}. ${rng.pick(['Two stores moved stage this fortnight.', 'Store 214 dispute discussed — position summary shared.', 'Procurement lead times holding.', 'Install crew double-booked week 30 — resequenced.'])} Practical completion forecast updated in the pipeline table.`,
      offset: -84 + i * 11, tags: ['storefront', 'minutes'], meta: {},
    });
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────
  const tasks = [
    ['Send store 214 position summary to Vantage legal', 'open', 4],
    ['Order replacement fitting-room panels for 214', 'open', 8],
    ['Issue store 225 drawings through the review gate', 'open', 6],
    ['Book install crew for store 222', 'open', 12],
    ['Confirm mall permit lead time for store 228', 'open', 9],
    ['Close out store 208 O&M handover', 'done', -12],
    ['File store 211 practical completion certificate', 'done', -30],
    ['Update pipeline after the week-30 resequence', 'done', -8],
    ['Chase counter laminate lead time', 'done', -25],
    ['Survey store 228 Lakeside', 'done', -5],
  ];
  tasks.forEach(([title, status, due], i) =>
    nodes.push({
      id: `store-task-${String(i + 1).padStart(2, '0')}`, kind: 'task', branch: B, title,
      body: 'STOREFRONT tranche 2.',
      offset: status === 'done' ? due - rng.int(3, 10) : -rng.int(1, 15),
      tags: ['storefront'], meta: { status, due_offset: due, priority: title.includes('214') ? 'high' : 'normal' },
    }));
  for (let i = 0; i < 10; i++) {
    nodes.push({
      id: `store-task-x${String(i + 1).padStart(2, '0')}`, kind: 'task', branch: B,
      title: `Store ${rng.pick(STORES).no}: ${rng.pick(['issue drawings', 'snag walk', 'order finishes', 'programme update', 'certificate paperwork'])}`,
      body: 'Routine tranche 2 pipeline task.', offset: -rng.int(10, 85),
      tags: ['storefront'], meta: { status: 'done', due_offset: -rng.int(5, 80), priority: 'normal' },
    });
  }

  // ── Events ────────────────────────────────────────────────────────────────
  for (let i = 0; i < 4; i++) {
    const off = -70 + i * 21;
    nodes.push({
      id: `store-event-review-${i + 1}`, kind: 'event', branch: B,
      title: 'Vantage programme review', body: 'Fortnightly-ish pipeline walk with Nadia; pipeline table updated live.',
      offset: off, tags: ['storefront'], meta: { start_offset: off, duration_min: 60, location: 'video call' },
    });
  }
  nodes.push({
    id: 'store-event-214-walk', kind: 'event', branch: B,
    title: 'Store 214 joint snag walk', body: 'Joint walk-through with Vantage to settle the ceiling-grid measurements in person.',
    offset: 5, tags: ['storefront'], meta: { start_offset: 5, duration_min: 120, location: 'Store 214, Old Quarter' },
  });
  nodes.push({
    id: 'store-event-fitout-start', kind: 'event', branch: B,
    title: 'Store 222 fit-out start on site', body: 'Fit-out crew mobilises at Summit Park; Dana on site for the first morning.',
    offset: 10, tags: ['storefront'], meta: { start_offset: 10, duration_min: 240, location: 'Store 222, Summit Park' },
  });

  // ── The snag-dispute email thread ─────────────────────────────────────────
  const dispute = [
    ['nflores@vantageretail.example.net', ['alex@harbourlabs.example.com'], 'Store 214 — certificate withheld', -3, 'Alex, facilities have flagged the ceiling grid alignment and two damaged fitting-room panels at 214. We are holding the practical completion certificate until both are resolved. Marcus has the photos.'],
    ['alex@harbourlabs.example.com', ['nflores@vantageretail.example.net'], 'RE: Store 214 — certificate withheld', -2.5, 'Nadia, the grid measurements are within the spec tolerance — Dana is sending the measured survey today. The panels are ours: install damage, replacements ordered. Proposal: certify with a retention against the panel swap rather than holding completion for a two-week lead time item.'],
    ['mbell@vantageretail.example.net', ['dana@harbourlabs.example.com'], 'RE: Store 214 — grid measurements', -2, 'Dana, send the measured survey to me directly and I will walk it with facilities. If the numbers hold I will recommend the retention route to Nadia.'],
    ['dana@harbourlabs.example.com', ['mbell@vantageretail.example.net'], 'RE: Store 214 — grid measurements', -1.5, 'Sent, Marcus — measurements keyed to the drawing grid, all within tolerance. Joint walk booked for next week; replacement panels land the week after.'],
  ];
  dispute.forEach(([from, to, subject, off, body], i) =>
    emails.push({ id: `store-mail-dispute-${i + 1}`, thread: 'store-214-dispute', subject, from, to, cc: [], offset: off, body }));
  const updates = [
    ['june@harbourlabs.example.com', ['nflores@vantageretail.example.net'], 'Tranche 2 weekly pipeline summary', -21, 'Weekly summary attached: two stores in install, 222 into procurement, practical completion holding on 208 and 211. Full detail in the shared pipeline.'],
    ['nflores@vantageretail.example.net', ['june@harbourlabs.example.com'], 'RE: Tranche 2 weekly pipeline summary', -20, 'Thanks June. Board pack needs the contract value roll-up by Thursday — the sum from the pipeline table is fine.'],
    ['mbell@vantageretail.example.net', ['june@harbourlabs.example.com'], 'Fit-out access — Summit Park', -14, 'June, the Summit Park fit-out will need out-of-hours access for the noisy work. Mall permit lead time is two weeks, so start that now rather than the week before practical completion.'],
    ['june@harbourlabs.example.com', ['mbell@vantageretail.example.net'], 'RE: Fit-out access — Summit Park', -13.5, 'Permit application going in today, Marcus — lesson learned from store 211. Fit-out start pencilled for the week after next.'],
  ];
  updates.forEach(([from, to, subject, off, body], i) =>
    emails.push({ id: `store-mail-update-${i + 1}`, thread: 'store-weekly-updates', subject, from, to, cc: [], offset: off, body }));

  // ── Files ─────────────────────────────────────────────────────────────────
  for (let i = 0; i < 8; i++) {
    const s = STORES[i];
    filesOut.push({
      id: `store-drawing-${s.no}`, kind: 'pdf', branch: `${B}.stores`,
      name: `VR-${s.no}-GA-rev${rng.pick(['A', 'B', 'C'])}.pdf`, title: `Store ${s.no} general arrangement`,
      text: [`Vantage store ${s.no} ${s.city} — general arrangement`, 'Fit-out drawing issued through the review gate.', `Finishes per schedule VR-T2; shopfront ${rng.pick(['standard', 'heritage constraint'])}.`],
      offset: -80 + i * 8,
    });
  }
  for (let i = 0; i < 3; i++) {
    filesOut.push({
      id: `store-budget-${i + 1}`, kind: 'xlsx', branch: B,
      name: `tranche2-budget-q${i + 1}.xlsx`, title: `Tranche 2 budget — period ${i + 1}`,
      sheet: 'Budget',
      rows: [
        ['Store', 'Contract value', 'Certified to date', 'Retention'],
        ...STORES.slice(0, 5 + i).map((s) => [`Store ${s.no}`, s.value, Math.round(s.value * (0.3 + i * 0.25)), Math.round(s.value * 0.05)]),
      ],
      text: ['Tranche 2 budget', 'contract value', 'certified to date', 'retention'],
      offset: -75 + i * 30,
    });
  }
  for (let i = 0; i < 6; i++) {
    filesOut.push({
      id: `store-photo-${String(i + 1).padStart(2, '0')}`, kind: 'png', branch: `${B}.stores`,
      name: `store-${rng.pick(STORES).no}-progress-${i + 1}.png`, title: `Store progress photo ${i + 1}`,
      pngSeed: 90 + i, text: ['store fit-out progress photo'], offset: -60 + i * 10,
    });
  }

  // ── Turns ─────────────────────────────────────────────────────────────────
  turns.push(
    { id: 'turn-store-1', agent: 'assistant', offset: -2, prompt: 'What is our position on the store 214 snag dispute and what happens next?' },
    { id: 'turn-store-2', agent: 'assistant', offset: -18, prompt: 'What is the total contract value of the tranche 2 fit-out pipeline, and which stores are at practical completion?' },
    { id: 'turn-store-3', agent: 'assistant', offset: -40, prompt: 'Which finishes have the longest lead time in the tranche 2 schedule?' },
  );

  return { nodes, tables, emails, files: filesOut, turns };
}
