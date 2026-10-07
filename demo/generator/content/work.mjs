// CONTACTS, TASKS, EVENTS and the JOURNAL. These kinds never go below admin,
// so they sit in project folders (content/folders.mjs) instead of tiers.
// Dates are day offsets from seed time; the dashboard's "coming up" comes
// from the tasks and events placed after zero.
import { world, owner, companies } from '../lib/world.mjs';
import { PROJECT_FOLDERS } from './folders.mjs';

export function generate() {
  const nodes = [];

  // ── Contacts: the whole cast, owner included ──────────────────────────────
  for (const p of [owner, ...world.people]) {
    const company = p.company ?? 'harbour-labs';
    nodes.push({
      id: `contact-${p.id}`, kind: 'contact', title: p.name, body: p.role, offset: -88,
      tags: ['contact', company === 'meridian' ? 'client' : 'studio'],
      meta: {
        emails: [p.email], company: companies[company].name, role: p.role,
        folder: PROJECT_FOLDERS.contacts[company],
      },
    });
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────
  const task = (id, project, offset, title, body, status, priority, due) =>
    nodes.push({
      id, kind: 'task', title, body, offset, tags: [project],
      meta: { status, priority, due_offset: due, folder: PROJECT_FOLDERS.tasks[project] },
    });
  task('task-issue-rev-b', 'pumphouse', -23, 'Issue changeover procedure rev B to Gordon',
    'Rev B carries the corrected loop check order and the TQ-004 answer. Gordon approves in writing before it is issued for use.', 'done', 'high', -21);
  task('task-book-calibrator', 'pumphouse', -9, 'Book the loaner calibrator for the commissioning window',
    'Our calibrator\'s certificate expires on day 3 of the window. Book the lab\'s loaner for all five days and check its certificate on arrival.', 'open', 'high', 2);
  task('task-loop-checks-day-2', 'pumphouse', -11, 'Loop checks day 2, witnessed by Lena',
    'Five signals left: P-101.FLT, XV-401.POS, XV-401.CMD, GEN.RUN, RTU.BATT. The XV-401 test needs the control room to agree to a sixty-second radio outage.', 'open', 'high', 3);
  task('task-storage-sizing', 'island', -8, 'Finish the storage sizing section of the findings',
    'Add the cell ageing allowance and show what it does to the 350 kWh option at year ten.', 'open', 'normal', 5);
  task('task-send-findings', 'island', -6, 'Send the draft findings to Gordon',
    'A week ahead of the findings review, so he can bring the reservoir level question to it.', 'open', 'normal', 7);

  // ── Events ────────────────────────────────────────────────────────────────
  const event = (id, project, start, title, body, minutes, location) =>
    nodes.push({
      id, kind: 'event', title, body, offset: Math.min(start, -1), tags: [project],
      meta: { start_offset: start, duration_min: minutes, location, folder: PROJECT_FOLDERS.events[project] },
    });
  event('event-progress-week-9', 'pumphouse', -7, 'Progress review: PS3, week 9',
    'Loop checks, snags and the commissioning window, with Gordon and Lena.', 60, 'Meridian offices');
  event('event-loop-checks-day-2', 'pumphouse', 3.33, 'Loop checks day 2 at PS3',
    'Witnessed by Lena Marsh. Bring the loaner calibrator. Radio outage for the XV-401 test agreed with the control room.', 420, 'Pump Station 3');
  event('event-commissioning-window', 'pumphouse', 7.33, 'PS3 commissioning window opens',
    'Five days. Hold points H1 and H3 signed by Gordon Bekker, H2 witnessed by Lena Marsh.', 480, 'Pump Station 3');
  event('event-findings-review', 'island', 14.42, 'Standby power findings review with Gordon',
    'Three options, the autonomy numbers, and the reservoir level question.', 90, 'Meridian offices');

  // ── Journal: Alex, first person ───────────────────────────────────────────
  const journal = (id, offset, title, mood, body) =>
    nodes.push({ id, kind: 'journal', title, body: body.join('\n\n'), offset, tags: ['work'], meta: { mood, category: 'work' } });
  journal('journal-storm-night', -50, 'The night the diesel did not start', 'uneasy', [
    'Phone at 01:40. Grid down across the valley, and Gordon telling me PS3 was dark: the diesel cranked and would not catch. Three hours before the grid came back. The reservoir held, just.',
    'What bothers me is that the generator passed its monthly run three weeks ago. A test on a dry afternoon proved nothing about a wet night.',
    'Gordon asked, half joking, whether the station could just run on sunshine. I said I would find out properly. That is a study, and a good one.',
  ]);
  journal('journal-rev-b', -21, 'Rev B out the door', 'satisfied', [
    'Gordon signed rev B this morning. Two changes, both from Meridian\'s side of the table: Lena\'s loop check order and her valve question.',
    'Nice to issue a revision that is better because the client read it properly. That is what the revision process is for.',
  ]);
  journal('journal-loop-day-1', -12, 'Loop checks, day one', 'tired', [
    'Long day at PS3 with Tessa and Lena. Seven signals proven, one wired upside down, one isolation valve that will not close. Normal, in other words.',
    'Tessa stopped before the valve test because the control room had not been told. Right call. A procedure only works if you stop at the hold point when it is inconvenient.',
  ]);
  journal('journal-week-before', -2, 'A week before the window', 'focused', [
    'Everything for the commissioning window is on one list now: day 2 of the loop checks, the loaner calibrator, two Meridian snags. The brain answers "what is left" faster than I can open the snag list.',
    'Rowan\'s numbers for the standby study say 350 kWh. I want option B to win, which is exactly why Rowan checks the sums and not me.',
  ]);

  return { nodes };
}
