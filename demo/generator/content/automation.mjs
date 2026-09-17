// The "advanced" screens, each with ONE exemplar that shows what the screen is
// for — the demo's third movement (steer the intelligence toward automation)
// needs something to point at. Until 2026-09-17 /settings/heartbeats, /recall
// and /draw were empty on the public demo: no generator ever produced them.
//
//  - heartbeats: scheduled skill→agent triggers. Two the studio would keep.
//    They never fire on the demo (the box runs no worker, and the seed sets
//    earliest_at a day out), so they read as configured automation, honestly.
//  - a Recall map: a page tree whose root carries the `recall` tag and whose
//    nodes end in an "Options" list (`[label](page:<id>) — use when …`). The
//    generator writes the options by GENERATOR id; the seeder resolves them
//    to real page ids after the tree exists (a page cannot link a sibling
//    that has not been created yet), then commits the root so the map
//    compiles. One prompt node, tagged `prompt`, declares its matcher line.
//  - a draw: an Excalidraw scene of the PS3 telemetry after the changeover.
//    Elements carry the fields Excalidraw's restore path expects; ids are
//    fixed strings so the scene is byte-identical run to run.
import { first } from '../lib/world.mjs';


function box(id, x, y, w, h, text, seed) {
  const el = {
    id, type: 'rectangle', x, y, width: w, height: h, angle: 0,
    strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid',
    strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100,
    groupIds: [], frameId: null, roundness: { type: 3 }, seed, version: 1, versionNonce: seed + 1,
    isDeleted: false, boundElements: [{ type: 'text', id: `${id}-t` }], updated: 1, link: null, locked: false,
  };
  const label = {
    id: `${id}-t`, type: 'text', x: x + 8, y: y + h / 2 - 12, width: w - 16, height: 24, angle: 0,
    strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid',
    strokeWidth: 1, strokeStyle: 'solid', roughness: 0, opacity: 100,
    groupIds: [], frameId: null, roundness: null, seed: seed + 2, version: 1, versionNonce: seed + 3,
    isDeleted: false, boundElements: null, updated: 1, link: null, locked: false,
    text, originalText: text, fontSize: 16, fontFamily: 1, textAlign: 'center', verticalAlign: 'middle',
    containerId: id, lineHeight: 1.25, baseline: 18, autoResize: true,
  };
  return [el, label];
}

function arrow(id, from, to, seed) {
  const [x1, y1] = from; const [x2, y2] = to;
  return {
    id, type: 'arrow', x: x1, y: y1, width: Math.abs(x2 - x1), height: Math.abs(y2 - y1), angle: 0,
    strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid',
    strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100,
    groupIds: [], frameId: null, roundness: { type: 2 }, seed, version: 1, versionNonce: seed + 1,
    isDeleted: false, boundElements: null, updated: 1, link: null, locked: false,
    points: [[0, 0], [x2 - x1, y2 - y1]], lastCommittedPoint: null,
    startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: 'arrow', elbowed: false,
  };
}

function note(id, x, y, text, seed) {
  return {
    id, type: 'text', x, y, width: 420, height: 60, angle: 0,
    strokeColor: '#6b6b6b', backgroundColor: 'transparent', fillStyle: 'solid',
    strokeWidth: 1, strokeStyle: 'solid', roughness: 0, opacity: 100,
    groupIds: [], frameId: null, roundness: null, seed, version: 1, versionNonce: seed + 1,
    isDeleted: false, boundElements: null, updated: 1, link: null, locked: false,
    text, originalText: text, fontSize: 14, fontFamily: 1, textAlign: 'left', verticalAlign: 'top',
    containerId: null, lineHeight: 1.25, baseline: 15, autoResize: true,
  };
}

export function generate() {
  const nodes = [], heartbeats = [], draws = [];

  // ── Heartbeats ────────────────────────────────────────────────────────────
  heartbeats.push({
    id: 'hb-morning-briefing', slug: 'morning-briefing', name: 'Morning briefing',
    agent: 'assistant', skill: 'chat_writing',
    schedule: { kind: 'interval', every_minutes: 1440, jitter_minutes: 10 },
    surface: { kind: 'web' },
    description: 'Every weekday before the standup: what is due today across PUMPHOUSE, STOREFRONT and ISLAND, what moved since yesterday (mail, tasks, snags), and anything the risk register says is heating up. Two paragraphs, no lists longer than five.',
    quiet_hours: { from: '20:00', to: '06:30' },
    cooldown_minutes: 600, min_idle_minutes: 30,
    earliest_offset: 1, offset: -95,
  });
  heartbeats.push({
    id: 'hb-invoice-check', slug: 'friday-invoice-check', name: 'Friday invoice check',
    agent: 'assistant', skill: 'chat_writing',
    schedule: { kind: 'interval', every_minutes: 10080 },
    surface: { kind: 'web' },
    description: `Every Friday afternoon for ${first('felix-arendse')}: read the Invoice tracker's Outstanding view, list anything unpaid past its due date or due within seven days, and draft the chase email for each — do not send. Stop if the tracker has not changed since last week.`,
    quiet_hours: null, cooldown_minutes: 4320, min_idle_minutes: null,
    earliest_offset: 2, offset: -40,
  });

  // ── Recall map: how we work at Harbour Labs ───────────────────────────────
  const R = 'studio.recall';
  nodes.push({
    id: 'recall-root', kind: 'page', branch: R, title: 'How we work — a map for the assistant',
    body: [
      '# How we work — a map for the assistant',
      '',
      'Start here when a question is about the studio\'s own way of doing things rather than a project fact. Each option below is one situation; follow it and apply what it says before answering. Project facts live in the project branches, not here.',
    ].join('\n'),
    offset: -30, tags: ['recall', 'handbook'],
    meta: {
      recall_options: [
        { label: 'Before a site visit', target: 'recall-site-visit', use_when: 'someone is planning, packing for, or asking what to check before going to site' },
        { label: 'Issuing a procedure revision', target: 'recall-procedure-revision', use_when: 'a procedure changes, a client asks which revision is current, or a revision needs approval' },
        { label: 'When a client withholds a certificate', target: 'recall-certificate', use_when: 'practical completion, snag disputes, retention or a withheld certificate come up' },
        { label: 'Site visit report — house style', target: 'recall-site-report-prompt', use_when: 'writing up a site visit, a loop check, or a commissioning day' },
      ],
    },
  });
  nodes.push({
    id: 'recall-site-visit', kind: 'page', branch: R, title: 'Before a site visit',
    body: [
      '# Before a site visit',
      '',
      '- Confirm access with the client contact the day before, in writing. At a Vantage store that is Marcus Bell; at PS3 it is the Meridian control room.',
      '- Take the standard site kit (handbook: "Standard site kit"). Calibrator certificate must be in date, or the readings are worthless.',
      '- Print the loop schedule and the CURRENT procedure revision; the brain knows which one that is.',
      '- Photograph before touching anything: wide shot for context, close shot for the label.',
      '- Leave with a snag list that has an owner per line, not a paragraph.',
    ].join('\n'),
    offset: -30, tags: ['recall', 'handbook'], meta: { parent_id: 'recall-root' },
  });
  nodes.push({
    id: 'recall-procedure-revision', kind: 'page', branch: R, title: 'Issuing a procedure revision',
    body: [
      '# Issuing a procedure revision',
      '',
      'A procedure is a revision family: rev B supersedes rev A, and the newest committed revision is the living one. Never edit an issued revision; issue the next one.',
      '',
      '1. Draft the new revision as its own page; say in its first paragraph what changed and why (the Bekker review changed scope at rev B; Marsh\'s loop-check order corrected rev C).',
      '2. Second pair of eyes through the review gate before anything leaves the studio.',
      '3. Client approval: at Meridian, Gordon Bekker approves every revision; witnesses are named separately.',
      '4. Commit; the old revision stays for the record and retrieval prefers the new one on its own.',
    ].join('\n'),
    offset: -30, tags: ['recall', 'handbook'], meta: { parent_id: 'recall-root' },
  });
  nodes.push({
    id: 'recall-certificate', kind: 'page', branch: R, title: 'When a client withholds a certificate',
    body: [
      '# When a client withholds a certificate',
      '',
      'Separate the snags from the certificate. Measure what is measurable (grid alignment against the spec tolerance, filed), accept what is genuinely ours (install damage), and propose a retention against the open items rather than holding practical completion for them. Store 214 is the worked example: position summary in the STOREFRONT pages, thread in mail.',
      '',
      'Escalation order: Dana on the technical position, Felix on the money, Alex with the client. The invoice does not go out until the position summary is agreed internally.',
    ].join('\n'),
    offset: -30, tags: ['recall', 'handbook'], meta: { parent_id: 'recall-root' },
  });
  nodes.push({
    id: 'recall-site-report-prompt', kind: 'page', branch: R, title: 'Site visit report — house style',
    body: [
      '# Site visit report — house style',
      '',
      'Use when: writing up a site visit, a loop check, or a commissioning day for Harbour Labs.',
      '',
      'Write it as the engineer who was there, past tense, in this order: purpose of the visit in one line; who was on site (client people by name and role); what was done, as a numbered list with times; what was found, each finding as "observation → consequence → action, owner, date"; open items carried to the snag list by reference number; next visit and its precondition. Tight bullets, no adjectives, no "as mentioned". Photos are referenced by drawing grid, never described.',
    ].join('\n'),
    offset: -30, tags: ['recall', 'prompt', 'handbook'], meta: { parent_id: 'recall-root' },
  });

  // ── Draw: PS3 telemetry after the changeover ──────────────────────────────
  const els = [
    ...box('d-field', 40, 160, 190, 80, 'Field instruments\n(level, flow, pressure)', 101),
    ...box('d-rtu', 320, 160, 170, 80, 'New RTU\n(PS3 kiosk)', 201),
    ...box('d-radio', 580, 160, 170, 80, 'Radio link\n(mast, extended)', 301),
    ...box('d-scada', 840, 160, 200, 80, 'SCADA head-end\n(Meridian control room)', 401),
    ...box('d-gen', 320, 320, 170, 70, 'Standby generator\n(changeover contact)', 501),
    ...box('d-legacy', 40, 20, 190, 60, 'Legacy telemetry\n(decommissioned at rev C)', 601),
    arrow('d-a1', [230, 200], [320, 200], 701),
    arrow('d-a2', [490, 200], [580, 200], 801),
    arrow('d-a3', [750, 200], [840, 200], 901),
    arrow('d-a4', [405, 320], [405, 240], 1001),
    note('d-n1', 40, 430, 'Delivery valve holds last position on comms loss (TQ-004). Loop check order per rev C: level, flow, pressure — witnessed by Lena Marsh.', 1101),
  ];
  draws.push({
    id: 'draw-ps3-telemetry', branch: 'work.pumphouse', title: 'PS3 telemetry — after the changeover', icon: '🗺️',
    tags: ['pumphouse', 'architecture'],
    scene: { elements: els, appState: { viewBackgroundColor: '#ffffff', gridSize: null } },
    offset: -12,
  });

  return { nodes, heartbeats, draws };
}
