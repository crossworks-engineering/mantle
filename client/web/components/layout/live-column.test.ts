/**
 * formatElapsed — the stopwatch label for in-flight activity rows. Guards the
 * mm:ss zero-padding and the rollover to h:mm:ss past an hour.
 */
import { describe, expect, it } from 'vitest';
import { formatElapsed } from './elapsed';

describe('formatElapsed', () => {
  it('renders m:ss with zero-padded seconds under an hour', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(5)).toBe('0:05');
    expect(formatElapsed(83)).toBe('1:23');
    expect(formatElapsed(600)).toBe('10:00');
    expect(formatElapsed(3599)).toBe('59:59');
  });

  it('rolls over to h:mm:ss past an hour', () => {
    expect(formatElapsed(3600)).toBe('1:00:00');
    expect(formatElapsed(3723)).toBe('1:02:03');
  });

  it('floors fractional seconds and clamps negatives to zero', () => {
    expect(formatElapsed(12.9)).toBe('0:12');
    expect(formatElapsed(-5)).toBe('0:00');
  });
});
