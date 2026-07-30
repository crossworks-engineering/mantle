// Routine operational traffic — the unglamorous bulk a real brain accumulates.
//
// This is not padding: it is the difference between a curated demo and a
// lived-in one. A studio's brain is mostly transmittals, confirmations,
// call notes and quote chasing; a demo with only the interesting documents
// reads like a brochure, and search over it returns three tidy results
// instead of the messy, plausible eleven a real brain gives you.
import { world, owner, first } from '../lib/world.mjs';

const STAFF = ['rowan-mercer', 'tessa-okafor', 'dana-whitfield', 'felix-arendse', 'june-castellanos'];
// Client-side correspondents are reached per project (proj.people) so that a
// thread's participants always belong to the engagement it is about.
const PROJECTS = [
  { key: 'pumphouse', label: 'PS3', branch: 'work.pumphouse', doc: 'PS3-DRG', people: ['gordon-bekker', 'lena-marsh', 'harold-venn'] },
  { key: 'storefront', label: 'tranche 2', branch: 'work.storefront', doc: 'VR-GA', people: ['nadia-flores', 'marcus-bell'] },
  { key: 'island', label: 'ISLAND', branch: 'work.island', doc: 'ISL-RPT', people: ['ingrid-solberg', 'theo-mokoena'] },
];

const emailOf = (id) => (id === owner.id ? owner.email : world.people.find((p) => p.id === id).email);

// ── Thread shapes: [subject, opener, reply] ─────────────────────────────────
const THREADS = [
  ['Transmittal {doc}-{n} rev {rev}', 'Transmittal attached: {doc}-{n} rev {rev}, issued for {purpose}. Superseded sheets to be withdrawn from site.', 'Received, thanks — logged against the register and the old sheet is off the wall.'],
  ['Site access — {day}', 'Requesting access for {day}, two engineers, {hours}. Permit reference to follow.', 'Access confirmed for {day}. Sign in at the gatehouse; {who} will meet you.'],
  ['Meeting confirmation', 'Confirming the review {day}. Agenda: programme, snags, lead times. Anything to add?', 'Nothing to add from our side — see you {day}.'],
  ['Quote request — {item}', 'Could you quote for {item}? Programme needs delivery inside {weeks} weeks if possible.', 'Quote attached. Delivery is {weeks} weeks from order, subject to the usual caveat on the enclosure line.'],
  ['Invoice {inv} query', 'Invoice {inv} bounced at our end — PO number does not match the amended schedule.', 'Re-issued with the corrected PO reference. Apologies for the round trip.'],
  ['Programme update', 'Programme reissued after this week\'s changes. Two activities moved; float unchanged overall.', 'Noted — the moved activities do not clash with our access windows.'],
  ['Document register — monthly reconciliation', 'Monthly register reconciliation attached. Two revisions issued since last month.', 'Reconciled against our copy; we agree on both.'],
  ['Photos from {day}', 'Photos from {day} uploaded to the project folder — the {area} in particular is worth a look.', 'Seen, thanks. That confirms what we suspected about the {area}.'],
  ['Action list follow-up', 'Following up the actions from the last review — three still open on your side.', 'Two closed this morning, the third needs {who}; expect it inside the week.'],
  ['Holiday cover', 'On leave {day} for a week; {who} is covering anything urgent on {label}.', 'Understood, enjoy the break. We will route through {who}.'],
];
const PURPOSES = ['construction', 'review', 'tender', 'record', 'approval'];
const ITEMS = ['the spare analogue card', 'replacement fitting-room panels', 'the loaner calibrator', 'shopfront vinyl', 'a storage system budget price', 'felt wiper material'];
const AREAS = ['valve chamber', 'comms cabinet', 'ceiling grid', 'intake switchboard', 'shopfront', 'instrument rack'];
const DAYS = ['Tuesday', 'Wednesday', 'Thursday', 'Monday next week', 'Friday'];

export function generate(rngRoot) {
  const rng = rngRoot.fork('traffic');
  const nodes = [], tables = [], emails = [], filesOut = [], turns = [];

  // ── Threaded operational email ────────────────────────────────────────────
  let n = 0;
  for (let i = 0; i < 78; i++) {
    const proj = PROJECTS[i % PROJECTS.length];
    const [subjT, openT, replyT] = THREADS[i % THREADS.length];
    const internal = rng.chance(0.35);
    const them = internal ? rng.pick(STAFF) : rng.pick(proj.people);
    const us = rng.pick([owner.id, ...STAFF]);
    if (us === them) continue;
    const fill = (s) => s
      .replace(/{doc}/g, proj.doc).replace(/{n}/g, String(100 + (i % 40)))
      .replace(/{rev}/g, rng.pick(['A', 'B', 'C'])).replace(/{purpose}/g, rng.pick(PURPOSES))
      .replace(/{day}/g, rng.pick(DAYS)).replace(/{hours}/g, rng.pick(['08:00–16:00', 'morning only', 'out of hours']))
      .replace(/{item}/g, rng.pick(ITEMS)).replace(/{weeks}/g, String(rng.int(2, 8)))
      .replace(/{inv}/g, `HL-${2300 + (i % 12)}`).replace(/{area}/g, rng.pick(AREAS))
      .replace(/{who}/g, first(rng.pick(STAFF))).replace(/{label}/g, proj.label);
    const subject = fill(subjT);
    const base = -170 + i * 2.1 + rng.float();
    const thread = `traffic-${proj.key}-${i}`;
    emails.push({ id: `traffic-mail-${++n}`, thread, subject, from: emailOf(them), to: [emailOf(us)], cc: [], offset: Math.round(base * 10) / 10, body: fill(openT) });
    emails.push({ id: `traffic-mail-${++n}`, thread, subject: `RE: ${subject}`, from: emailOf(us), to: [emailOf(them)], cc: [], offset: Math.round((base + 0.3) * 10) / 10, body: fill(replyT) });
    if (rng.chance(0.3)) {
      emails.push({ id: `traffic-mail-${++n}`, thread, subject: `RE: ${subject}`, from: emailOf(them), to: [emailOf(us)], cc: rng.chance(0.4) ? [emailOf(rng.pick(STAFF))] : [], offset: Math.round((base + 0.7) * 10) / 10, body: rng.pick(['Perfect — closing this one off.', 'Understood, thanks for turning it round quickly.', 'That works. Copying June so it lands on the action list.']) });
    }
  }

  // ── Call notes + weekly wrap notes ────────────────────────────────────────
  for (let i = 0; i < 22; i++) {
    const proj = PROJECTS[i % PROJECTS.length];
    const who = rng.pick(proj.people);
    nodes.push({
      id: `traffic-call-${String(i + 1).padStart(2, '0')}`, kind: 'note', branch: proj.branch,
      title: `Call with ${first(who)} — ${rng.pick(['programme', 'lead times', 'access', 'scope query', 'invoicing'])}`,
      body: `Short call. ${rng.pick([
        'Confirmed the position agreed by email; nothing new, but worth having on the record.',
        'They are comfortable with the programme provided the next transmittal lands this week.',
        'Raised a scope question that will become a formal query if the answer is not obvious.',
        'Chased delivery; promised date holds for now, with the usual caveat.',
        'Access arrangements adjusted around their shutdown; calendar updated.',
      ])} Actions on the task list.`,
      offset: Math.round((-165 + i * 7.3 + rng.float()) * 10) / 10, tags: [proj.key, 'call'], meta: {},
    });
  }
  for (let i = 0; i < 16; i++) {
    nodes.push({
      id: `traffic-weekly-${String(i + 1).padStart(2, '0')}`, kind: 'note', branch: 'studio',
      title: `Week wrap — studio`,
      body: `Across the desks this week: ${rng.pick(['PS3 procedure work and a site day', 'two store surveys and a snag walk', 'load-profile crunching and a client call', 'transmittals, invoicing and a quiet Friday'])}. ${rng.pick(['Nothing on fire.', 'One lead time worth watching.', 'Certificates chased.', 'Calibrator booked.'])}`,
      offset: Math.round((-168 + i * 10.4) * 10) / 10, tags: ['studio', 'weekly'], meta: {},
    });
  }

  // ── Extra journals (the quieter days) ─────────────────────────────────────
  const quiet = [
    'A day of small corrections. Nothing to show anyone, but the drawings are right now.',
    'Transmittals all morning. Tedium is a form of quality control.',
    'The brain earned its keep today — found a three-month-old answer in about four seconds.',
    'Two calls that could have been emails, one email that should have been a call.',
    'Quiet Friday. Swept the workshop, oiled the ways, thought about nothing much.',
    'Wrote the same sentence four ways before it said what I meant.',
    'Good week for the studio: everyone busy, nobody drowning.',
    'Long day on site. Boots off, notes written up while they are fresh.',
  ];
  for (let i = 0; i < 16; i++) {
    nodes.push({
      id: `traffic-journal-${String(i + 1).padStart(2, '0')}`, kind: 'journal', branch: 'personal.journal',
      title: 'Day notes', body: quiet[i % quiet.length],
      offset: Math.round((-172 + i * 10.7 + rng.float() * 2) * 10) / 10,
      tags: ['reflection'], meta: { mood: rng.pick(['content', 'tired', 'thoughtful', 'satisfied', 'flat']), category: 'work' },
    });
  }

  // ── Routine tasks ─────────────────────────────────────────────────────────
  for (let i = 0; i < 16; i++) {
    const proj = PROJECTS[i % PROJECTS.length];
    const open = i < 6;
    nodes.push({
      id: `traffic-task-${String(i + 1).padStart(2, '0')}`, kind: 'task', branch: proj.branch,
      title: `${rng.pick(['Issue transmittal for', 'Reconcile document register for', 'Chase action list on', 'Update programme for', 'File photos from'])} ${proj.label}`,
      body: 'Routine project administration.',
      offset: Math.round(-rng.int(3, 150) * 10) / 10,
      tags: [proj.key], meta: { status: open ? 'open' : 'done', due_offset: open ? rng.int(2, 18) : -rng.int(5, 90), priority: 'normal' },
    });
  }

  // ── Extra pages: per-project status + reference ───────────────────────────
  const extraPages = [
    ['traffic-page-transmittal-register', 'work.pumphouse', 'Transmittal register — PS3', 'Every document issued to Meridian with its revision, date and purpose. Reconciled monthly against their copy; two revisions issued this month.'],
    ['traffic-page-access-log', 'work.pumphouse', 'Site access log — PS3', 'Every site day: who attended, permit reference, gatehouse sign-in. Meridian audit their own access records, so ours has to agree with theirs.'],
    ['traffic-page-lessons', 'studio', 'Lessons log', 'Running list of things worth not relearning: confirm mall permit lead times separately from the client’s; never build off an unrevised sheet; a calibrator certificate expires at the worst possible moment.'],
    ['traffic-page-glossary', 'studio', 'Project glossary', 'RTU, TQ, PC, snag, transmittal, review gate, islanding, shed scheme, tranche. Written for anyone new who has to read a minute and know what happened.'],
    ['traffic-page-client-contacts', 'studio', 'Client contact map', 'Who to call for what: Bekker approves, Marsh knows the plant, Venn owns the PO, Flores owns the programme, Bell opens doors, Solberg signs, Mokoena has the data.'],
    ['traffic-page-supplier-notes', 'studio', 'Supplier notes', 'Brightpath: good people, honest about lead times, enclosure line is the bottleneck. Programme supplier for finishes: reliable within four weeks, optimistic beyond that.'],
    ['traffic-page-review-log', 'studio', 'Review gate log', 'Every document through the gate: reviewer, date, outcome. The log is the evidence that the gate is real and not a story we tell ourselves.'],
    ['traffic-page-file-plan', 'studio', 'Filing plan', 'Where things live: project branches by codename, site records under .site, research under .research, studio ops separate from finance. If you cannot find it in two guesses, the plan is wrong.'],
  ];
  extraPages.forEach(([id, branch, title, body], i) =>
    nodes.push({ id, kind: 'page', branch, title, body: `# ${title}\n\n${body}`, offset: -120 + i * 12 + rng.int(0, 4), tags: ['reference'], meta: {} }));

  // ── Extra tables ──────────────────────────────────────────────────────────
  tables.push({
    id: 'traffic-transmittal-register', branch: 'work.pumphouse', title: 'Transmittal register',
    columns: [
      { name: 'Transmittal', type: 'text' }, { name: 'Document', type: 'text' },
      { name: 'Rev', type: 'select', options: ['A', 'B', 'C'] },
      { name: 'Purpose', type: 'select', options: PURPOSES },
      { name: 'Issued (offset days)', type: 'number' },
    ],
    rows: Array.from({ length: 18 }, (_, i) => [`T-${String(i + 1).padStart(3, '0')}`, `PS3-DRG-${100 + i}`, rng.pick(['A', 'B', 'C']), rng.pick(PURPOSES), -140 + i * 7]),
    aggregates: {}, offset: -142,
  });
  tables.push({
    id: 'traffic-timesheet', branch: 'studio.finance', title: 'Time by project — month',
    columns: [
      { name: 'Person', type: 'text' }, { name: 'Project', type: 'select', options: ['PUMPHOUSE', 'STOREFRONT', 'ISLAND', 'Studio'] },
      { name: 'Hours', type: 'number' }, { name: 'Rate', type: 'currency' },
      { name: 'Value', type: 'formula', formula: '{Hours} * {Rate}' },
    ],
    rows: STAFF.flatMap((s) => ['PUMPHOUSE', 'STOREFRONT', 'ISLAND'].map((p) => [first(s), p, rng.int(8, 70), 95, null])),
    aggregates: { Hours: 'sum', Value: 'sum' }, offset: -25,
  });
  tables.push({
    id: 'traffic-risk-register', branch: 'studio', title: 'Studio risk register',
    columns: [
      { name: 'Risk', type: 'text' }, { name: 'Project', type: 'select', options: ['PUMPHOUSE', 'STOREFRONT', 'ISLAND', 'Studio'] },
      { name: 'Likelihood', type: 'select', options: ['low', 'medium', 'high'] },
      { name: 'Impact', type: 'select', options: ['low', 'medium', 'high'] },
      { name: 'Owner', type: 'text' },
    ],
    rows: [
      ['Panel enclosure lead time slips again', 'PUMPHOUSE', 'medium', 'high', first('tessa-okafor')],
      ['Commissioning window clashes with plant shutdown', 'PUMPHOUSE', 'low', 'high', 'Alex Carter'],
      ['Store 214 dispute delays certificate and invoice', 'STOREFRONT', 'high', 'medium', first('dana-whitfield')],
      ['Install crew double-booked in peak weeks', 'STOREFRONT', 'medium', 'medium', first('june-castellanos')],
      ['Utility application lead time exceeds study window', 'ISLAND', 'high', 'medium', 'Alex Carter'],
      ['Demand tariff changes again before report issue', 'ISLAND', 'low', 'medium', first('felix-arendse')],
      ['Calibrator certificate lapses mid-commissioning', 'Studio', 'low', 'high', first('rowan-mercer')],
      ['Key person unavailable during commissioning fortnight', 'Studio', 'medium', 'high', 'Alex Carter'],
    ],
    aggregates: {}, offset: -45,
  });
  tables.push({
    id: 'traffic-cpd-log', branch: 'studio', title: 'CPD log',
    columns: [
      { name: 'Person', type: 'text' }, { name: 'Activity', type: 'text' },
      { name: 'Hours', type: 'number' }, { name: 'Date (offset days)', type: 'number' },
    ],
    rows: [...STAFF, 'alex-carter'].flatMap((s, i) => [
      [s === 'alex-carter' ? 'Alex Carter' : first(s), rng.pick(['Functional safety refresher', 'Water industry telemetry seminar', 'Storage systems webinar', 'CAD standards update', 'First aid renewal']), rng.int(2, 16), -150 + i * 22],
    ]),
    aggregates: { Hours: 'sum' }, offset: -150,
  });

  // ── Extra files: transmittal PDFs + registers ─────────────────────────────
  for (let i = 0; i < 14; i++) {
    const proj = PROJECTS[i % PROJECTS.length];
    filesOut.push({
      id: `traffic-file-transmittal-${String(i + 1).padStart(2, '0')}`, kind: 'pdf', branch: proj.branch,
      name: `transmittal-T-${String(i + 1).padStart(3, '0')}.pdf`, title: `Transmittal T-${String(i + 1).padStart(3, '0')}`,
      text: [`Transmittal T-${String(i + 1).padStart(3, '0')} — ${proj.label}`, `Documents issued for ${rng.pick(PURPOSES)}.`, 'Superseded revisions to be withdrawn from site.'],
      offset: -140 + i * 9,
    });
  }
  for (let i = 0; i < 6; i++) {
    filesOut.push({
      id: `traffic-file-register-${i + 1}`, kind: 'xlsx', branch: 'studio.ops',
      name: `document-register-p${i + 1}.xlsx`, title: `Document register — period ${i + 1}`,
      sheet: 'Register',
      rows: [['Document', 'Rev', 'Issued', 'Purpose'], ...Array.from({ length: 10 }, (_, j) => [`DOC-${100 + j}`, rng.pick(['A', 'B', 'C']), `-${rng.int(10, 150)}`, rng.pick(PURPOSES)])],
      text: ['document register', 'revision', 'issued', 'purpose'],
      offset: -130 + i * 22,
    });
  }

  return { nodes, tables, emails, files: filesOut, docs: [], turns };
}
