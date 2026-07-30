// Scripted conversation. These are RUN for real against the seeded brain in
// P4 — every one produces assistant_messages, a trace with its steps, and any
// tool_results the agent's tools generate. Nothing here is written as a row.
//
// The questions are deliberately answerable FROM the brain: a demo whose chat
// history is full of "I don't have information about that" is worse than one
// with no chat history at all. Each prompt targets content the generator
// actually seeded, so the transcript reads like someone using their own brain.
import { world, projects } from '../lib/world.mjs';

const ASK = {
  // Saskia — the main assistant, the bulk of the traffic
  assistant: [
    'Which revision of the PS3 telemetry changeover procedure is current, and what changed in it?',
    'Summarise where PS3 commissioning stands and what is still blocking the window.',
    'What did Lena Marsh raise about the loop check order, and where did it land?',
    'What is our position on the store 214 snag dispute and what happens next?',
    'What is the total contract value of the tranche 2 fit-out pipeline?',
    'What is the ISLAND study recommending, and what are the open comments on the draft?',
    'Why did the feasibility study choose feeder-level islanding over breaker-level?',
    'What is due in the next two weeks across all projects?',
    'Who is covering what during the commissioning fortnight?',
    'Which invoices are unpaid, and is anything heading to overdue?',
    'Give me a picture of this week: deadlines, site days, and anything at risk.',
    'How did the lathe headstock bearing saga end?',
    'When does the taper start and what is left before race day?',
    'What has the lathe restoration cost so far?',
    'What is the lead time situation with Brightpath and how does it affect commissioning?',
    'List the open snag list items for the comms cabinet and who raised them.',
    'What does the handbook say about review gates, and why do they exist?',
    'What is on the standard site kit list?',
    'Which finishes have the longest lead time in the tranche 2 schedule?',
    'What did the March deadhead incident teach us?',
    'Summarise the technical queries raised on PUMPHOUSE and how each was answered.',
    'What risks are we carrying across the three projects?',
    'Who at Meridian approves procedure revisions, and who witnesses loop checks?',
    'What happened at the last Vantage programme review?',
    'How many stores are at practical completion and which are still in install?',
    'What is the shed scheme on the Copperline campus and why does it matter?',
    'Remind me why the delivery valve holds last position on comms loss.',
    'What is outstanding on the utility interconnection application?',
    'Which drawings went out this month and for what purpose?',
    'What did Gordon Bekker ask for in his review of rev A?',
    'Is the calibrator booked for the commissioning window?',
    'What is the current state of the PS3 snag list?',
    'What does the filing plan say about where site records live?',
    'Summarise this week across work and personal.',
    'What have I been reflecting on lately in my journals?',
    'What did the FAT report find, and what carried to site?',
    'Which supplier is the bottleneck on PUMPHOUSE, and why?',
    'What are the acceptance criteria for the PS3 changeover?',
    'Who should I call about site access at a Vantage store?',
    'What did the campus site walk with Theo establish?',
  ],
  // Remy — memory recall, time-windowed questions
  remy: [
    'What was I working on three months ago?',
    'What changed on PUMPHOUSE between the rev A and rev B reviews?',
    'Remind me what we discussed with Vantage before the 214 dispute started.',
    'What did I write in my journal around the time the ankle went?',
    'Walk me through how the ISLAND study developed from kickoff to draft.',
    'What was the state of the snag list a month ago compared with now?',
    'When did the Brightpath lead time first come up?',
    'What has changed on the tranche 2 pipeline in the last six weeks?',
  ],
  // Pages — document work
  pages: [
    'Find the commissioning plan and summarise its hold points.',
    'What sections does the studio handbook cover?',
    'Summarise the islanding scheme options page.',
    'What does the practical completion checklist require?',
    'Give me the gist of the risk register.',
    'Summarise the load shed scheme priorities.',
  ],
  // Ledger — table questions
  tables: [
    'What is the sum of contract values in the tranche 2 pipeline?',
    'How many snag list items are still open?',
    'What is the total spend in the lathe parts table?',
    'Which storage option has the longest ride-through?',
    'What are the total hours by project this month?',
    'Which invoices in the tracker are overdue?',
  ],
};

// Follow-ups make a transcript read like a conversation rather than a survey,
// and they exercise the context path (the agent must use what it just said).
const FOLLOWUPS = [
  'Why?',
  'What would change that?',
  'Who owns it?',
  'When is it due?',
  'What is the risk if it slips?',
  'Show me where that came from.',
];

export function generate(rngRoot) {
  const rng = rngRoot.fork('turns');
  const turns = [];
  let n = 0;

  for (const [agent, prompts] of Object.entries(ASK)) {
    prompts.forEach((prompt) => {
      // Spread across the last ~60 days so the conversation has a history.
      const offset = -Math.round(rng.float() * 60) - 0.5;
      const id = `turn-${agent}-${String(++n).padStart(3, '0')}`;
      turns.push({ id, agent, offset: Math.round(offset * 10) / 10, prompt });
      // Most turns get a follow-up, and some get a second — real threads are
      // rarely one exchange, and each follow-up is another turn's worth of
      // assistant_messages without another hand-written prompt.
      const followUps = rng.chance(0.8) ? (rng.chance(0.35) ? 2 : 1) : 0;
      for (let f = 0; f < followUps; f++) {
        turns.push({
          id: `${id}-f${f + 1}`, agent,
          offset: Math.round((offset + 0.02 * (f + 1)) * 10) / 10,
          prompt: rng.pick(FOLLOWUPS), followUp: true,
        });
      }
    });
  }

  // A handful of world-derived questions so the set is not a fixed list —
  // these vary with the bible rather than being hard-coded twice.
  for (const p of Object.values(projects)) {
    turns.push({
      id: `turn-proj-${p.id}`, agent: 'assistant',
      offset: Math.round((-Math.round(rng.float() * 50) - 0.5) * 10) / 10,
      prompt: `Give me a status summary of ${p.codename} — what is done, what is next, and what is at risk.`,
    });
  }
  for (const person of rng.pickN(world.people, 8)) {
    turns.push({
      id: `turn-who-${person.id}`, agent: 'assistant',
      offset: Math.round((-Math.round(rng.float() * 50) - 0.5) * 10) / 10,
      prompt: `What have I got on with ${person.name} at the moment?`,
    });
  }

  return { nodes: [], tables: [], emails: [], files: [], docs: [], turns };
}
