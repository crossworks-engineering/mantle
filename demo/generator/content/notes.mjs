// NOTES: five. A site visit report in the house style (the Recall map's
// prompt card describes it), the data note behind the load profile, the
// technical query that changed the procedure, the progress minutes, and one
// private thought. Notes are created after pages, so they may mention them.

export function generate() {
  const nodes = [];
  const note = (id, tier, offset, title, tags, body) =>
    nodes.push({ id, kind: 'note', tier, title, body: body.join('\n'), offset, tags, meta: {} });

  note('note-site-visit-day-1', 'team', -12, 'Site visit: PS3 loop checks, day 1', ['pumphouse', 'site-visit', 'loop-check'], [
    'Purpose: loop check the new RTU at PS3 in the rev B order, as far as the day allows.',
    '',
    'On site: Tessa Okafor (Harbour Labs), Lena Marsh (Meridian SCADA technician, for the control room end).',
    '',
    'What was done:',
    '1. 07:30 Signed in at the gatehouse; calibrator certificate checked, in date.',
    '2. 08:10 LT-101 wet well level: 4, 12 and 20 mA injected, read back on the control room screen within 0.5 %.',
    '3. 09:40 FT-201 delivery flow: proven the same way.',
    '4. 11:15 PT-301 delivery pressure: proven, but the isolation valve would not fully close.',
    '5. 13:00 Five digital inputs proven. DOOR.OPEN came in inverted.',
    '6. 15:30 Stopped before XV-401: the valve test needs the radio link pulled, and the control room wanted notice.',
    '',
    '![Injecting 12 mA at the terminal strip](media:gen:img-calibrator-hands)',
    '',
    'Findings:',
    '- PT-301 isolation valve stiff: cannot isolate the transmitter for a swap. Snag S-03, Meridian.',
    '- DOOR.OPEN wired normally closed against a normally open schedule. Rewired on the day. Snag S-02, closed.',
    '- Spare core tags faded. Snag S-04, ours.',
    '',
    '![Tagged cores in the marshalling box](media:gen:img-commissioning-tags)',
    '',
    'Open items: 5 signals left for day 2, listed in the [PS3 I/O schedule](mention:node:gen:tbl-io-schedule) view "Still to check".',
    '',
    'Next visit: day 2, witnessed by Lena. Precondition: control room agrees to a sixty-second radio outage for the XV-401 test.',
    '',
    '![Delivery pressure transmitter PT-301](media:gen:img-pressure-transmitter)',
  ]);

  note('note-logger-data', 'team', -30, 'Standby study: the winter logger data', ['island', 'data', 'load-profile'], [
    'Lena sent four weeks of winter data from the PS3 logger: pump run signals, FT-201 flow and the incomer kW, at one-minute resolution.',
    '',
    'What I did with it:',
    '- Averaged each hour across the weekdays into one typical winter day. Weekends are lighter and would flatter the battery.',
    '- Matched the kW steps to pumps running: idle 4 kW, one pump 65 kW, two pumps 124 kW. The steps are clean, which says the soft starters are healthy.',
    '- Put the result in the [PS3 load profile, typical winter day](mention:node:gen:tbl-load-profile). Station total is about 1,730 kWh a day.',
    '',
    '![Delivery flow meter FT-201](media:gen:img-flow-meter)',
    '',
    'Caveat for the findings: one winter only. If January is wetter than this one, the pumps run longer, and the morning two-pump block gets longer too.',
    '',
    '(Rowan)',
  ]);

  note('note-tq-004', 'client', -26, 'TQ-004: the delivery valve on comms loss', ['pumphouse', 'technical-query', 'TQ-004'], [
    'Raised by Lena Marsh, Meridian, against rev A of the changeover procedure.',
    '',
    '**Question.** If the radio link drops during the changeover, what does the delivery valve XV-401 do? Rev A does not say.',
    '',
    '**Answer (Tessa Okafor).** It holds its last position. The RTU keeps the last command on loss of comms and raises an alarm when the link returns. We considered fail-closed and rejected it: closing the delivery valve with a pump running deadheads the pump.',
    '',
    '**Outcome.** Written into [PS3 changeover procedure, rev B](mention:node:gen:page-procedure-rev-b) as step 7: pull the link for sixty seconds and confirm the valve holds.',
    '',
    '![Delivery valve chamber](media:gen:img-ps3-valve-chamber)',
  ]);

  note('note-progress-week-9', 'client', -7, 'Progress review: PS3, week 9', ['pumphouse', 'minutes'], [
    'Present: Gordon Bekker and Lena Marsh (Meridian); Alex Carter and Tessa Okafor (Harbour Labs).',
    '',
    '1. Loop checks: day 1 proved 7 of 12 signals. Day 2 set for next week, Lena witnessing.',
    '2. Snags: six raised, two closed. S-06, the generator run signal flickering on start, is Meridian\'s and is the one that matters before the window.',
    '3. Commissioning window: five days confirmed. Gordon signs H1 and H3; Lena witnesses H2.',
    '4. Control room mimic shows flow in l/s; the schedule says m3/h. Meridian to change the mimic (S-05).',
    '',
    'Actions: Meridian to free the PT-301 isolation valve (S-03) and fix GEN.RUN (S-06) before the window. Harbour Labs to re-tag the spare cores (S-04).',
    '',
    'Open snags are tracked in the [PS3 snag list](mention:node:gen:tbl-snag-list).',
    '',
    '![Meridian control room desk](media:gen:img-ps3-control-room)',
  ]);

  note('note-price-the-battery', 'private', -15, 'Price the battery as the replacement, not an add-on', ['island', 'thinking'], [
    'If we present the battery as something on top of a new diesel, it loses on cost every time. If we present it as the replacement, the comparison is battery against diesel plus fuel plus the monthly test runs nobody trusts.',
    '',
    'Say it to Gordon that way at the findings review. Check the numbers against the [Battery options compared](mention:node:gen:tbl-battery-options) table first.',
  ]);

  return { nodes };
}
