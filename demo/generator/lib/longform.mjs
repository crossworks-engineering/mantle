// Long-form section blocks for the genres that are genuinely long in real
// engineering work: procedures, commissioning plans, research reports, guides.
//
// WHY THIS EXISTS: the first full seed produced exactly 1.00 chunks per node —
// every document fitted in a single chunk, so passage-level retrieval had
// nothing to retrieve. That is not a target problem, it is a content problem:
// a real changeover procedure runs to many pages, and a demo whose documents
// are all one chunk cannot show the thing chunk retrieval is for.
//
// These are real sections with real engineering substance, parameterised by
// the calling module — not filler. Filler would chunk just as well and read
// like a brochure, which is the failure this whole demo exists to avoid.

export function procedureSections(rng, { signals, areas }) {
  return [
    '## Roles and responsibilities',
    'The **person in charge** owns the window and is the only one who may authorise a deviation. The **witness** signs each record at the point of test, not afterwards from memory. The **control room operator** retains the right to stop the work at any moment without giving a reason; that authority is not negotiable and is restated at every toolbox talk.',
    '',
    'A second engineer is present for the whole window. This is not redundancy for its own sake: transferring a live loop is a two-person operation, one at the field end and one at the panel, and the second pair of eyes is what catches a core landed on the wrong terminal before it becomes an event.',
    '',
    '## Pre-conditions in detail',
    `Before any core is lifted, confirm: the permit is issued and displayed; the outage window is agreed and logged with the control room; the rollback path has been proven within the last seven days; the loop-check records are printed and in the file; the witness is on site; and the calibrator's own calibration certificate is in date. The last item has stopped a window before — a certificate that lapsed the week before commissioning is discovered on site, not in the office.`,
    '',
    `Signals in scope for this station: ${rng.pickN(signals, 6).join(', ')}. Anything not on that list stays on the legacy outstation until a separate, planned transfer.`,
    '',
    '## Method',
    'Work one loop at a time. Photograph the marshalling strip before lifting anything, and again after landing. Label both ends before disconnection — a core identified only by its position is an unlabelled core the moment it leaves the terminal.',
    '',
    'For each loop: lift, transfer, land, continuity-check, then functional-check from the field end. Record the result against the loop number before starting the next one. Resist the temptation to batch — batching is how a mis-landed core is discovered six loops later, with no way to tell which step introduced it.',
    '',
    '## Acceptance criteria',
    'The changeover is accepted when every alarm point has been simulated from the field end and observed at the control room; every analogue loop has been verified at 0%, 50% and 100% of range against the calibrator; the delivery valve has been shown to hold last position through a forced comms loss; the standby generator signals have been exercised through a real changeover; and one full pump cycle has run under control-room command with all telemetry healthy.',
    '',
    'Anything less is not an acceptance. A partial acceptance recorded as complete is worse than a failed one, because the gap becomes invisible the moment the team leaves site.',
    '',
    '## Records',
    'The commissioning file holds: the signed loop-check record for every point, the RTU configuration checksum, the before-and-after photographs of every marshalling strip touched, the daily changeover log, and the snag list as it stood at the end of each day. The file is the deliverable as much as the working telemetry is — an asset that works but cannot be shown to work has not been handed over.',
    '',
    '## Deviations and stop conditions',
    `Stop and escalate if: a step fails twice; a signal behaves differently from its record; the control room asks you to; or anything in ${rng.pick(areas)} is found in a condition not covered by this procedure. Improvising on a live water asset is how incidents begin. A stopped job costs a shift; an incident costs considerably more than that.`,
    '',
    '## Rollback',
    'The rollback path returns control to the legacy outstation and is proven before the window opens, not discovered during it. It is exercised at least once in the seven days before commissioning, and the proof is filed. A rollback nobody has tested is a hope, not a plan.',
  ];
}

export function researchSections(rng, { topic }) {
  return [
    '## Method',
    `The analysis works from measured data rather than nameplate figures wherever both exist. Where a gap had to be filled, the interpolation is stated in place rather than smoothed away — a reader should be able to see exactly which numbers were measured and which were inferred, and to disagree with the inference without re-doing the work.`,
    '',
    '## Assumptions',
    'Every assumption that materially moves the answer is listed here rather than buried in a spreadsheet. Where an assumption is contestable, the sensitivity of the conclusion to it is given, so the reader can form their own view instead of taking ours on trust.',
    '',
    'Assumptions that do not move the answer are deliberately omitted. A list of forty assumptions hides the three that matter.',
    '',
    '## Sensitivity',
    `The conclusion holds across the plausible range of every input tested. Where it does not, the boundary is stated explicitly: the point at which the recommendation would change, and what would have to be true for that to happen. ${rng.pick(['The tariff assumption is the one worth watching.', 'The load-growth assumption is the one worth watching.', 'The utility lead time is the one worth watching.'])}`,
    '',
    '## What would change the recommendation',
    'A materially different load profile, a change to the interconnection rules, or a step change in storage pricing would each be grounds to revisit this. None of them is likely inside the decision window, but all three are worth a periodic look rather than a one-time answer treated as permanent.',
    '',
    '## Limitations',
    `This is a desk study against supplied data. It is not a design, and it is not a substitute for a site-specific protection study. Where ${topic} interacts with the utility's own protection settings, those settings govern, and the application process exists precisely to settle that.`,
  ];
}

export function guideSections(rng) {
  const blocks = [
    ['## When to use this', 'Reach for this the first time you do the task, and again any time it has been long enough that you are reconstructing the steps from memory. Reconstruction is where errors enter.'],
    ['## Before you start', 'Gather what you need first. The single most common cause of a botched job is starting without something, improvising around the gap, and never going back to correct the improvisation.'],
    ['## Common mistakes', 'Writing it up later rather than at the point of work. Trusting a label you did not verify. Assuming the drawing matches what is installed. Skipping the second check because the first went well — the first going well is not evidence about the second.'],
    ['## Worked example', 'Take the last real instance from the project file and follow it end to end. An example from actual work teaches more than an invented one, because the mess in it is the part you will encounter.'],
    ['## Records', 'What gets filed, where, and under whose name. A record whose author cannot be identified is an anecdote. Keep the naming consistent so that a search finds it in one guess rather than three.'],
    ['## If something is wrong', 'Stop, write down exactly what you observed before you form a theory, and tell someone. The observation is worth more than the theory, and it degrades quickly once a theory attaches to it.'],
  ];
  return rng.shuffle(blocks).flatMap(([h, body]) => [h, body, '']);
}
