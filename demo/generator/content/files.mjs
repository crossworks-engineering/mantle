// FILES: the twenty illustrations (demo/world/art) and three documents.
//
// The images are real JPEGs, generated once and committed (art/art.json says
// how). Pages and notes embed them by generator id (`media:gen:img-<id>`),
// and each one sits in the Files folder of the tier that embeds it.
//
// The documents are what a client actually receives (the issued procedure and
// the I/O schedule, in the client folder) and one private draft.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { worldDir } from '../lib/world.mjs';

export const ART = JSON.parse(readFileSync(join(worldDir, 'art', 'art.json'), 'utf8')).images;
export const imageId = (slug) => `img-${slug}`;

export function generate() {
  const files = ART.map((a) => ({
    id: imageId(a.id), kind: 'image', name: `${a.id}.jpg`, title: a.title, tier: a.tier, offset: a.offset,
    text: [a.title],
  }));

  files.push({
    id: 'doc-procedure-rev-b', kind: 'pdf', tier: 'client', offset: -20,
    name: 'ps3-changeover-procedure-rev-b.pdf', title: 'PS3 changeover procedure, rev B (issued)',
    text: [
      'Pump Station 3 telemetry changeover procedure. Revision B. Issued for use. Supersedes revision A.',
      'Approved by Gordon Bekker, plant superintendent, Meridian Waterworks. Loop checks witnessed by Lena Marsh.',
      'What changed from revision A: the loop check order is level, then flow, then pressure, so the pumps are never run on an unproven level signal. The delivery valve holds its last position on loss of communications (answer to TQ-004).',
      'Hold points: H1 before the old RTU is isolated, H2 after the level loop is proven, H3 before the control room takes the station.',
      'Back-out: the old RTU stays wired and parked until H3 is signed. If H3 is not signed by the end of the window, reconnect it and return the station to the old telemetry.',
    ],
  });
  files.push({
    id: 'doc-io-schedule', kind: 'xlsx', tier: 'client', offset: -18,
    name: 'ps3-io-schedule-rev-b.xlsx', title: 'PS3 I/O schedule, rev B', sheet: 'IO',
    rows: [
      ['Tag', 'Signal', 'Type', 'Range', 'Units'],
      ['LT-101', 'Wet well level', 'AI', '0 to 6', 'm'],
      ['FT-201', 'Delivery flow', 'AI', '0 to 600', 'm3/h'],
      ['PT-301', 'Delivery pressure', 'AI', '0 to 10', 'bar'],
      ['P-101.RUN', 'Duty pump running', 'DI', 'on/off', ''],
      ['P-102.RUN', 'Standby pump running', 'DI', 'on/off', ''],
      ['XV-401.POS', 'Delivery valve position', 'AI', '0 to 100', '%'],
      ['GEN.RUN', 'Standby generator running', 'DI', 'on/off', ''],
      ['MAINS.OK', 'Mains supply healthy', 'DI', 'on/off', ''],
    ],
    text: ['PS3 I/O schedule', 'LT-101 wet well level', 'FT-201 delivery flow', 'PT-301 delivery pressure', 'XV-401 delivery valve'],
  });
  files.push({
    id: 'doc-fee-letter', kind: 'docx', tier: 'private', offset: -44,
    name: 'standby-study-fee-letter-draft.docx', title: 'Fee letter, standby power study (draft)',
    blocks: [
      { h: 1, text: 'Standby power study for Pump Station 3: fee letter (draft)' },
      { text: 'Dear Gordon, thank you for asking us to look at standby power for PS3 after the storm night.' },
      { h: 2, text: 'Scope' },
      { text: 'A load profile from your winter logger data, storage sizing for a four-hour outage, three options compared on cost and risk, and a findings meeting.' },
      { h: 2, text: 'Fee' },
      { text: 'A fixed fee, invoiced in two parts: half at the data review, half at the findings meeting.' },
      { text: 'Not sent. Rowan to check the hours before this goes out.' },
    ],
    text: ['Fee letter for the PS3 standby power study, draft, not sent'],
  });
  return { files };
}
