// HANDBOOK — the studio's operating manual as a nested page tree, plus the
// documentation collection (on-disk markdown guides, retrieval-only depth).
import { guideSections } from '../lib/longform.mjs';

export function generate(rngRoot) {
  const rng = rngRoot.fork('handbook');
  const nodes = [], docs = [], turns = [];
  const B = 'studio.handbook';

  // ── Nested page tree (parent_id chains ≥3 deep) ───────────────────────────
  const tree = [
    { id: 'hb-root', parent: null, title: 'Studio Handbook', body: 'How Harbour Labs runs: projects, people, kit. Sections are sub-pages; keep edits small and dated. If the handbook and reality disagree, fix whichever is wrong — usually the handbook.' },
    { id: 'hb-projects', parent: 'hb-root', title: 'How projects run', body: 'Every engagement gets a codename, a branch in the brain, and a single source-of-truth table or page for its status. Client-facing documents go through the review gate — no exceptions, including the principal.' },
    { id: 'hb-review-gates', parent: 'hb-projects', title: 'Review gates', body: 'A second pair of eyes before anything leaves the building: drawings, reports, procedures. The gate is a named reviewer and a recorded yes — not a vibe. Two tranche-1 stores built off superseded sheets are why.' },
    { id: 'hb-templates', parent: 'hb-projects', title: 'Document templates', body: 'Templates for site visit reports, technical queries, minutes and procedures. Copy the template, never a previous project’s document — that is how client names leak between jobs.' },
    { id: 'hb-revisions', parent: 'hb-projects', title: 'Revision discipline', body: 'Procedures and drawings carry revision letters. A superseded revision is never deleted — it is marked superseded so the history reads honestly. The brain does the same thing with its content.' },
    { id: 'hb-people', parent: 'hb-root', title: 'People ops', body: 'Small studio, few rules: cover for each other on site days, book leave in the shared calendar, keep Friday afternoons for the workshop unless a commissioning window says otherwise.' },
    { id: 'hb-leave', parent: 'hb-people', title: 'Leave', body: 'Book it in the calendar, tell the project coordinator, hand over open snags. Nobody reads email on leave; that is what the handover note is for.' },
    { id: 'hb-onboarding', parent: 'hb-people', title: 'Onboarding', body: 'Week one: site safety induction, the handbook, shadowing on a live project. Week two: own the smallest live deliverable end to end, through the review gate like everyone else.' },
    { id: 'hb-siteday', parent: 'hb-people', title: 'Site day rules', body: 'Two engineers minimum on live-asset work. Photograph before you touch. If a step fails twice, stop and phone — improvising on a water asset is how incidents start.' },
    { id: 'hb-kit', parent: 'hb-root', title: 'Kit & tools', body: 'The kit list, the calibrator booking sheet, and the software register live under this section. If you take the last calibrator, the booking sheet is not optional.' },
    { id: 'hb-kitlist', parent: 'hb-kit', title: 'Site kit list', body: 'Standard site box: calibrator, loop tester, label printer, camera, spare glands, PPE. Check the box against the list before every site day — the valve chamber is a long way to go back for a label printer.' },
    { id: 'hb-software', parent: 'hb-kit', title: 'Software register', body: 'Licences and renewal dates for the CAD seats, the calculation pack and the telemetry config tool. Renewals go on the ops task list a month ahead.' },
    { id: 'hb-finance', parent: 'hb-root', title: 'Invoicing & finance', body: 'Felix invoices monthly against the certified-to-date column in each project’s budget. Retentions tracked per store on STOREFRONT. Cashflow review is the first Monday of the month.' },
    { id: 'hb-brain', parent: 'hb-root', title: 'Using the brain', body: 'Everything goes in: site reports, minutes, TQs, the lot. Search before you ask; the answer to “which revision is current” is a search away. The assistant reads the same brain — ask it the question you would ask June.' },
  ];
  tree.forEach((p, i) =>
    nodes.push({
      id: p.id, kind: 'page', branch: B, title: p.title, body: `# ${p.title}\n\n${p.body}`,
      offset: -160 + i * 4 + rng.int(0, 40), tags: ['handbook'], meta: { parent_id: p.parent },
    }));

  // ── Documentation collection: engineering guides (on-disk markdown) ───────
  const guideTopics = [
    ['naming-conventions', 'File and drawing naming conventions'],
    ['cad-standards', 'CAD layer and sheet standards'],
    ['site-safety-checklist', 'Site safety checklist'],
    ['loop-check-guide', 'Loop check field guide'],
    ['calibrator-use', 'Using the loop calibrator'],
    ['rtu-config-basics', 'RTU configuration basics'],
    ['radio-survey-method', 'Radio path survey method'],
    ['telemetry-glossary', 'Telemetry glossary'],
    ['snag-process', 'Snag list process'],
    ['tq-process', 'Technical query process'],
    ['minutes-style', 'Minutes style guide'],
    ['photo-discipline', 'Site photography discipline'],
    ['fitout-survey-guide', 'Store survey field guide'],
    ['finishes-schedule-howto', 'Reading a finishes schedule'],
    ['pc-walkthrough', 'Practical completion walk-through'],
    ['retention-basics', 'Retentions and certificates'],
    ['load-profile-method', 'Building a load profile from meter data'],
    ['storage-sizing-method', 'Storage sizing method'],
    ['islanding-primer', 'Islanding schemes primer'],
    ['report-writing', 'Report writing for boards'],
  ];
  const paras = [
    'Keep it boring: the same structure every time means anyone can pick up anyone else’s work mid-project.',
    'Field data beats memory. Write it down at the panel, not in the van.',
    'When a measurement surprises you, measure again before you theorise.',
    'A checklist you skip under pressure is not a checklist — trim it until you never skip it.',
    'The reader of this guide is you, in eight months, at a site you have forgotten. Write for that person.',
  ];
  guideTopics.forEach(([slug, title], i) => {
    docs.push({
      collection: 'engineering-guides', relpath: `${String(i + 1).padStart(2, '0')}-${slug}.md`,
      title,
      body: [
        `# ${title}`, '', rng.pick(paras), '', rng.pick(paras), '',
        ...guideSections(rng),
        '- Keep the template current.', '- Route changes through the review gate.',
        '- File examples against the project, not the guide.',
      ].join('\n'),
    });
    docs.push({
      collection: 'engineering-guides', relpath: `${String(i + 1).padStart(2, '0')}-${slug}-checklist.md`,
      title: `${title} — checklist`, body: `# ${title} — checklist\n\n- [ ] Prepared per the guide\n- [ ] Reviewer named\n- [ ] Records filed to the project branch\n- [ ] Follow-ups on the task list`,
    });
  });

  turns.push(
    { id: 'turn-hb-1', agent: 'assistant', offset: -20, prompt: 'What does the handbook say about review gates, and why do they exist?' },
    { id: 'turn-hb-2', agent: 'assistant', offset: -35, prompt: 'What is on the standard site kit list?' },
  );

  return { nodes, tables: [], emails: [], files: [], docs, turns };
}
