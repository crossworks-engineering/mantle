// HEARTBEATS and SECRETS: the configured automation and the vault.
//
// Heartbeats never fire on the public demo (no worker runs there, and the
// seed sets their first run a day out), so the screen shows automation that
// is set up, honestly, rather than a simulation of it running.
// Secret values are obviously fake: they only prove the screen renders.
import { PROJECT_FOLDERS } from './folders.mjs';

export function generate() {
  const heartbeats = [
    {
      id: 'hb-morning-briefing', slug: 'morning-briefing', name: 'Morning briefing',
      agent: 'assistant', skill: 'chat_writing',
      schedule: { kind: 'interval', every_minutes: 1440, jitter_minutes: 10 },
      surface: { kind: 'web' },
      description: 'Every weekday at 07:00: what is due today at PS3 and on the standby study, which snags moved since yesterday, and anything new from Meridian. Two short paragraphs.',
      quiet_hours: { from: '20:00', to: '06:30' }, cooldown_minutes: 600, min_idle_minutes: 30,
      earliest_offset: 1, offset: -40,
    },
    {
      id: 'hb-weekly-status', slug: 'weekly-status-for-gordon', name: 'Weekly status for Gordon',
      agent: 'assistant', skill: 'chat_writing',
      schedule: { kind: 'interval', every_minutes: 10080 },
      surface: { kind: 'web' },
      description: 'Every Friday afternoon: draft (do not send) the weekly PS3 status email to Gordon Bekker in the "Writing to Meridian" style: loop checks, open snags by owner, and anything that threatens the commissioning window.',
      quiet_hours: null, cooldown_minutes: 4320, min_idle_minutes: null,
      earliest_offset: 2, offset: -30,
    },
  ];

  const secret = (id, folder, title, body, value) =>
    ({ id, kind: 'secret', title, body, offset: -60, tags: ['demo'], meta: { value, folder } });
  const nodes = [
    secret('secret-rtu-console', PROJECT_FOLDERS.secrets.pumphouse, 'PS3 RTU web console', 'Engineer login for the new RTU. Demo value, not a real password.', 'demo-rtu-not-real-0001'),
    secret('secret-radio-modem', PROJECT_FOLDERS.secrets.pumphouse, 'PS3 radio modem config PIN', 'Front-panel PIN for the radio modem. Demo value.', 'demo-0000'),
    secret('secret-lab-portal', PROJECT_FOLDERS.secrets.studio, 'Calibration lab booking portal', 'Studio account for booking calibrations and loaners. Demo value.', 'demo-lab-not-real-0002'),
  ];

  return { heartbeats, nodes };
}
