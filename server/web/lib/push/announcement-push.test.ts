/**
 * The push of a Control Center broadcast (announcement-push.ts): each live
 * member who did not mute Announcements, on its own devices; a login whose
 * messenger push is off gets none; with message preview off, the title only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sent = vi.hoisted(() => [] as { devices: string[]; b: string; t: string }[]);
const prefs = vi.hoisted(
  () => ({}) as Record<string, { messages: 'all' | 'mentions' | 'off'; messagePreview: boolean }>,
);

vi.mock('@mantle/content/messenger', () => ({
  messengerParticipantLogins: async () => [
    { loginId: 'admin', leftSeq: null, fromSeq: 0, muted: false },
    { loginId: 'ann', leftSeq: null, fromSeq: 0, muted: false },
    { loginId: 'bob', leftSeq: null, fromSeq: 0, muted: false },
    { loginId: 'cid', leftSeq: null, fromSeq: 0, muted: false },
    { loginId: 'muted', leftSeq: null, fromSeq: 0, muted: true },
    { loginId: 'left', leftSeq: 3, fromSeq: 0, muted: false },
  ],
}));
vi.mock('./store', () => ({
  getPushInstance: async () => ({ instanceToken: 't', relayUrl: 'https://relay.example' }),
  listAdminSubscriptions: async () => [{ id: 'd-admin', loginId: 'admin' }],
  listLoginSubscriptions: async (_owner: string, loginId: string) => [
    { id: `d-${loginId}`, loginId },
  ],
  getLoginMessagePrefs: async (loginId: string) =>
    prefs[loginId] ?? { messages: 'all', messagePreview: true },
}));
vi.mock('./notify', () => ({
  sendToDevices: async (_i: unknown, devices: { id: string }[], c: { t: string; b: string }) => {
    sent.push({ devices: devices.map((d) => d.id), t: c.t, b: c.b });
    return { delivered: devices.length, dropped: 0 };
  },
}));

const { pushAnnouncement } = await import('./announcement-push');

beforeEach(() => {
  sent.length = 0;
  for (const k of Object.keys(prefs)) delete prefs[k];
});

describe('the broadcast push', () => {
  it('reaches each live, unmuted member on its own devices; off skips; no preview is the title only', async () => {
    prefs.bob = { messages: 'off', messagePreview: true };
    prefs.cid = { messages: 'mentions', messagePreview: false };
    const r = await pushAnnouncement('owner', {
      conversationId: 'c1',
      seq: 2,
      title: 'Maintenance',
      body: 'The boxes restart at 22:00.',
    });
    expect(sent).toEqual([
      { devices: ['d-admin'], t: 'Maintenance', b: 'The boxes restart at 22:00.' },
      { devices: ['d-ann'], t: 'Maintenance', b: 'The boxes restart at 22:00.' },
      { devices: ['d-cid'], t: 'Maintenance', b: 'New announcement' },
    ]);
    expect(r).toEqual({ attempted: 3, delivered: 3, dropped: 0 });
  });
});
