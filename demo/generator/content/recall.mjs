// RECALL: three small native maps, each an entry card plus a few cards.
// Options name their target by CARD SLUG; the seeder builds a map through the
// owner Recall API (map, cards, options, prompt confirm, publish) and reads it
// back. A prompt card carries the use_when line recall_match compares with.

export function generate() {
  const recall_maps = [];

  recall_maps.push({
    id: 'recall-how-we-work', slug: 'how-we-work-at-harbour-labs', title: 'How we work at Harbour Labs', offset: -40,
    enter_when: 'a question is about the studio\'s own way of doing things (site visits, procedure revisions, site reports) and not about a project fact',
    entry: {
      body: 'Start here when a question is about how the studio works rather than a project fact. Pick the situation, apply what the card says, then answer. Project facts live in the project items, not here.',
      options: [
        { label: 'Before a site visit', target: 'before-a-site-visit', use_when: 'someone is planning, packing for, or asking what to check before going to site' },
        { label: 'Issuing a procedure revision', target: 'issuing-a-procedure-revision', use_when: 'a procedure changes, someone asks which revision is current, or a revision needs approval' },
        { label: 'Site visit report: house style', target: 'site-visit-report-house-style', use_when: 'writing up a site visit, a loop check day, or a commissioning day' },
      ],
    },
    cards: [
      {
        slug: 'before-a-site-visit', kind: 'knowledge', title: 'Before a site visit',
        body: [
          '- Confirm access with the control room the day before, in writing.',
          '- Check the calibrator certificate is in date for every day of the visit. A reading taken on an expired certificate is worthless.',
          '- Print the current procedure revision and the I/O schedule view of what is still to check.',
          '- Tell the control room before any test that drops the radio link.',
          '- Leave with a snag list that has an owner on every line.',
        ].join('\n'),
        options: [{ label: 'Site visit report: house style', target: 'site-visit-report-house-style', use_when: 'the visit is done and it needs writing up' }],
      },
      {
        slug: 'issuing-a-procedure-revision', kind: 'knowledge', title: 'Issuing a procedure revision',
        body: [
          'A procedure is a revision family. The newest approved revision is the living one; never edit an issued revision, issue the next one.',
          '',
          '1. Draft the new revision as its own page. Its first lines say what changed and why.',
          '2. A second engineer reviews it before it leaves the studio.',
          '3. At Meridian, Gordon Bekker approves every revision in writing.',
          '4. Mark the old revision as superseded by the new one, so search sends people to the right one.',
        ].join('\n'),
      },
      {
        slug: 'site-visit-report-house-style', kind: 'prompt', title: 'Site visit report: house style',
        use_when: 'writing up a site visit, a loop check day or a commissioning day for Harbour Labs',
        body: 'Write as the engineer who was there, past tense, in this order: purpose in one line; who was on site, client people by name and role; what was done, as a numbered list with times; findings, each as observation, consequence, action and owner, with its snag number; open items; next visit and its precondition. Short lines, no adjectives.',
      },
    ],
  });

  recall_maps.push({
    id: 'recall-ps3-guide', slug: 'ps3-station-guide', title: 'PS3 station guide', offset: -20,
    enter_when: 'a question is about Pump Station 3: its procedure, its signals, its snags, the commissioning window or the standby power study',
    entry: {
      body: 'Everything at Pump Station 3 runs through two projects: the telemetry retrofit (PUMPHOUSE) and the standby power study (ISLAND). Pick what the question is about.',
      options: [
        { label: 'Which procedure is current', target: 'which-procedure', use_when: 'someone asks which revision of the changeover procedure to work to, or what changed' },
        { label: 'Commissioning window', target: 'commissioning-window', use_when: 'the question is about dates, hold points, or what has to be done before or during commissioning' },
        { label: 'Standby power', target: 'standby-power', use_when: 'the question is about the storm night, the diesel, batteries, solar or the four-hour outage' },
      ],
    },
    cards: [
      {
        slug: 'which-procedure', kind: 'knowledge', title: 'Which procedure is current',
        body: 'Rev B of the PS3 changeover procedure is current; rev A is superseded. Rev B changed two things: loop checks run level, flow, pressure, and the delivery valve holds its last position on comms loss (TQ-004). Gordon Bekker approved it.',
      },
      {
        slug: 'commissioning-window', kind: 'knowledge', title: 'Commissioning window',
        body: 'Five days, agreed in writing with Gordon Bekker. Before it: loop checks day 2 with Lena Marsh, the loaner calibrator, and the Meridian snags S-03 and S-06. During it: Gordon signs H1 and H3, Lena witnesses H2. The old RTU stays wired until H3.',
      },
      {
        slug: 'standby-power', kind: 'knowledge', title: 'Standby power',
        body: 'The study asks whether PS3 can ride through a four-hour outage without the diesel. Design load is one pump, 65 kW, at night. Option B (60 kWp solar, 350 kWh battery) gives 4.6 hours and is recommended in the draft findings. The findings review with Gordon is two weeks after the draft.',
      },
    ],
  });

  recall_maps.push({
    id: 'recall-writing-to-meridian', slug: 'writing-to-meridian', title: 'Writing to Meridian', offset: -10,
    enter_when: 'drafting an email, a technical query answer or a findings summary for Meridian Waterworks',
    entry: {
      body: 'Meridian is a procedure-driven utility. Everything we send may end up in their records. Pick what you are writing.',
      options: [
        { label: 'An email to Gordon or Lena', target: 'email-to-meridian', use_when: 'drafting an email to anyone at Meridian' },
        { label: 'Answering a technical query', target: 'answering-a-tq', use_when: 'a TQ needs an answer, or a question from Meridian needs a formal reply' },
      ],
    },
    cards: [
      {
        slug: 'email-to-meridian', kind: 'prompt', title: 'Email to Meridian',
        use_when: 'drafting an email to Gordon Bekker, Lena Marsh or anyone at Meridian Waterworks',
        body: 'Plain and short. First line says what you need from them and by when. Name tags (LT-101, XV-401), hold points (H1 to H3) and snag numbers exactly as the procedure does. Never promise a date the control room has not agreed. Sign with your first name.',
      },
      {
        slug: 'answering-a-tq', kind: 'prompt', title: 'Answering a technical query',
        use_when: 'answering a technical query (TQ) from Meridian',
        body: 'Three parts with bold labels: Question (as they asked it), Answer (one decision, then the reason, including what we rejected and why), Outcome (which procedure revision or drawing now carries it). Log the TQ number in the subject.',
      },
    ],
  });

  return { recall_maps };
}
