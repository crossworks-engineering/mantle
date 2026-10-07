// CHATS: four owner questions, RUN for real against the drained brain by
// demo/scripts/turns.sh (the fifth real chat is a member's, in
// demo/seed/seed-member-chat.ts). Each one makes a real trace with its
// context trace, which is the point: nothing here is written as a row, and
// nothing else in the demo generates traces, audit rows or runs.
//
// Each question is answerable from the brain, and together they touch
// supersession (a write the assistant does for real), a note with photos, a
// table view and a formula.
export function generate() {
  const turns = [
    {
      id: 'turn-supersede-rev-a', agent: 'assistant', offset: -20,
      prompt: 'Rev B of the PS3 changeover procedure replaces rev A. Mark rev A as superseded by rev B so nobody works to the old one, then tell me in two lines what changed.',
    },
    {
      id: 'turn-loop-day-1', agent: 'assistant', offset: -11,
      prompt: 'What did Tessa find on loop check day 1 at PS3, and which signals are left for day 2?',
    },
    {
      id: 'turn-open-snags', agent: 'assistant', offset: -5,
      prompt: 'Which snags on the PS3 snag list are still open, and which of them does Meridian own?',
    },
    {
      id: 'turn-battery-night', agent: 'assistant', offset: -1,
      prompt: 'Can PS3 ride through a four-hour outage at night on the 350 kWh battery with one pump running? Show me the sum.',
    },
  ];
  return { turns };
}
