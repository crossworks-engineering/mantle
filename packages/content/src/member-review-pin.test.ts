import { describe, expect, it } from 'vitest';
import { pinHolds } from './member-review-pin';

describe('the Approve pin', () => {
  const sent = '2026-10-09T09:00:00.123Z';

  it('holds for the version that was shown, whatever the offset spelling', () => {
    expect(pinHolds(sent, sent)).toBe(true);
    expect(pinHolds('2026-10-09T11:00:00.123+02:00', sent)).toBe(true);
  });

  it('refuses a version sent again since', () => {
    expect(pinHolds(sent, '2026-10-09T09:05:00.000Z')).toBe(false);
  });

  it('a left-behind item pins null, and only null matches it', () => {
    expect(pinHolds(null, null)).toBe(true);
    expect(pinHolds(null, sent)).toBe(false);
    expect(pinHolds(sent, null)).toBe(false);
  });

  it('an older client sends no pin: nothing to check', () => {
    expect(pinHolds(undefined, sent)).toBe(true);
  });

  it('a pin that is not a time never holds', () => {
    expect(pinHolds('not a time', sent)).toBe(false);
  });
});
