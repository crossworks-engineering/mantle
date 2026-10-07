// EMAIL: five short threads, each one a turn in the story. Every address is
// on an RFC 2606 domain, and every sender is in the cast.
import { emailOf } from '../lib/world.mjs';

export function generate() {
  const emails = [];
  let n = 0;
  const thread = (key, subject, messages) => {
    messages.forEach(([from, to, cc, offset, body], i) => {
      emails.push({
        id: `mail-${key}-${++n}`, thread: `thread-${key}`, subject: i === 0 ? subject : `RE: ${subject}`,
        from: emailOf(from), to: to.map(emailOf), cc: cc.map(emailOf), offset, body: body.join('\n\n'),
      });
    });
  };

  thread('tq-004', 'TQ-004: what does the delivery valve do on comms loss?', [
    ['lena-marsh', ['tessa-okafor'], ['alex-carter'], -28, [
      'Hi Tessa,',
      'Reading rev A of the changeover procedure. If the radio link drops while you are mid-changeover, what does XV-401 do? Rev A does not say, and our operators will ask.',
      'Lena',
    ]],
    ['tessa-okafor', ['lena-marsh'], ['alex-carter'], -26.6, [
      'Hi Lena,',
      'It holds its last position, and the RTU raises an alarm when the link comes back. We ruled out fail-closed: closing the delivery valve with a pump running deadheads the pump.',
      'Good catch. It goes into rev B as a step of its own, with a sixty-second link pull to prove it. Logged as TQ-004.',
      'Tessa',
    ]],
    ['lena-marsh', ['tessa-okafor'], [], -26.4, ['Perfect, thanks. While you are in there: your loop check order runs pressure first. I would prove level first, so nobody runs a pump on an unproven level signal.']],
  ]);

  thread('rev-b', 'PS3 changeover procedure rev B for approval', [
    ['alex-carter', ['gordon-bekker'], ['lena-marsh'], -22, [
      'Gordon,',
      'Rev B attached for approval. Two changes from rev A, both from Lena: the loop check order is now level, flow, pressure, and the delivery valve holds its last position on comms loss (TQ-004).',
      'Hold points are unchanged: you sign H1 and H3, Lena witnesses H2.',
      'Alex',
    ]],
    ['gordon-bekker', ['alex-carter'], ['lena-marsh'], -21.2, [
      'Approved. Please issue it and withdraw rev A from the site folder so nobody picks up the old one.',
      'Gordon',
    ]],
  ]);

  thread('logger-data', 'Standby study: winter logger data', [
    ['rowan-mercer', ['lena-marsh'], [], -32, [
      'Hi Lena,',
      'For the standby power study: could you export four weeks of the PS3 logger from the winter, with the pump run signals, FT-201 and the incomer kW? One-minute data if the logger kept it.',
      'Rowan',
    ]],
    ['lena-marsh', ['rowan-mercer'], [], -30, [
      'Attached, one-minute resolution, four weeks. The gap on the 14th is the storm night: the logger was on the same supply as everything else.',
      'Lena',
    ]],
  ]);

  thread('window', 'Commissioning window: five days confirmed', [
    ['gordon-bekker', ['alex-carter'], ['tessa-okafor'], -5, [
      'Alex,',
      'Confirming the five-day window for PS3 from next Monday week. The control room will run the station by hand from the old RTU until you sign H3.',
      'Two of the open snags are ours (the PT-301 valve and GEN.RUN). Both will be done before you arrive.',
      'Gordon',
    ]],
    ['alex-carter', ['gordon-bekker'], ['tessa-okafor'], -4.6, [
      'Thanks Gordon, confirmed on our side. Loop checks day 2 comes first, with Lena, so we start the window with all twelve signals proven.',
      'Alex',
    ]],
  ]);

  thread('calibrator', 'Calibrator certificate runs out mid-window', [
    ['tessa-okafor', ['alex-carter'], [], -3, [
      'Our calibrator certificate expires on day 3 of the commissioning window. Readings taken after that would not stand up. Can we book the lab\'s loaner for the whole week?',
      'Tessa',
    ]],
    ['alex-carter', ['tessa-okafor'], [], -2.8, ['Yes, book it. It is on the task list. Check the loaner\'s own certificate when it arrives.']],
  ]);

  return { emails };
}
