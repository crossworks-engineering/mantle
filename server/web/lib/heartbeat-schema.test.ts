/**
 * A heartbeat's earliestAt is an ISO date-time (A10 lows, part 2 #2): any
 * other string was an Invalid Date the database refused as an opaque 500;
 * now it is the caller's 400 at the schema.
 */
import { describe, expect, it } from 'vitest';
import { CreateHeartbeatBody, UpdateHeartbeatBody, toUpdateInput } from './heartbeat-schema';

const CREATE = {
  slug: 'hb',
  name: 'hb',
  agentSlug: 'a',
  skillSlug: 's',
  schedule: { kind: 'manual' },
  surface: { kind: 'web' },
};

describe('earliestAt', () => {
  it('takes what the settings form sends (toISOString), an offset, and null', () => {
    for (const earliestAt of [
      new Date('2026-10-20T08:00:00Z').toISOString(),
      '2026-10-20T10:00:00+02:00',
      null,
    ]) {
      const label = String(earliestAt);
      expect(CreateHeartbeatBody.safeParse({ ...CREATE, earliestAt }).success, label).toBe(true);
      expect(UpdateHeartbeatBody.safeParse({ earliestAt }).success, label).toBe(true);
    }
    const parsed = UpdateHeartbeatBody.parse({ earliestAt: '2026-10-20T08:00:00.000Z' });
    expect(toUpdateInput(parsed).earliestAt?.toISOString()).toBe('2026-10-20T08:00:00.000Z');
  });

  it('refuses a string that is no date-time', () => {
    for (const earliestAt of ['not a date', '', '2026-13-40T99:00:00Z', 'tomorrow']) {
      expect(CreateHeartbeatBody.safeParse({ ...CREATE, earliestAt }).success, earliestAt).toBe(
        false,
      );
      expect(UpdateHeartbeatBody.safeParse({ earliestAt }).success, earliestAt).toBe(false);
    }
  });
});
