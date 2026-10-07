// DOCUMENTATION: the studio's field guides, as an on-disk markdown
// collection indexed at retrieval depth (searchable, not memorised). Three
// short guides that the rest of the story leans on.

const guide = (relpath, title, lines) => ({ collection: 'field-guides', relpath, title, body: [`# ${title}`, '', ...lines].join('\n') });

export function generate() {
  const docs = [
    guide('01-loop-checks.md', 'Loop check field guide', [
      'A loop check proves one signal end to end: a known value goes in at the field end and the same value comes out on the operator\'s screen.',
      '',
      '## Kit',
      '',
      '- Loop calibrator with an in-date certificate (check the expiry against every day of the visit)',
      '- Multimeter, insulated screwdrivers, spare cable tags',
      '- The I/O schedule, filtered to what is still to check',
      '- The current procedure revision',
      '',
      '## Method for an analogue input',
      '',
      '1. Isolate the transmitter. Tell the control room first.',
      '2. Inject 4, 12 and 20 mA. Read each on the control room screen.',
      '3. Pass if every reading is within 0.5 % of span. Record the witness.',
      '4. Restore, remove the calibrator, confirm the live value is sensible.',
      '',
      '## Order at a pump station',
      '',
      'Level first, then flow, then pressure. Never run a pump on a level signal nobody has proven.',
    ]),
    guide('02-procedure-revisions.md', 'Procedure revisions', [
      'Issued procedures are never edited. A change means a new revision, with its changes listed at the top and the client\'s approval recorded.',
      '',
      '## Lifecycle',
      '',
      '1. Draft as a new page, named with the revision letter.',
      '2. Internal review by a second engineer.',
      '3. Client approval in writing.',
      '4. Issue, mark the previous revision superseded, withdraw it from the site folder.',
      '',
      'Hold points are part of the procedure, not the programme. A hold point not signed means stop.',
    ]),
    guide('03-standby-power-sizing.md', 'Standby power sizing', [
      'Size storage from the night case: the battery must carry the design load with no solar.',
      '',
      '## Steps',
      '',
      '1. Build a typical day from at least four weeks of logged data. Use weekdays.',
      '2. Agree the outage load with the operator (at a pump station, usually one pump).',
      '3. Usable energy is nameplate times depth of discharge times inverter efficiency.',
      '4. Autonomy is usable energy over the net load. Compare with the required ride-through.',
      '5. Add an ageing allowance before choosing the container size.',
    ]),
  ];
  return { docs };
}
