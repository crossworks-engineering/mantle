import { describe, expect, it } from 'vitest';
import { haversineMeters } from './locations';

// DB-touching CRUD (createLocation/findNearbyLocations) is exercised via the
// end-to-end flow, not here — this repo's unit tests are pure-logic only (no
// test database). haversineMeters is the pure primitive both the geo builtins
// and findNearbyLocations rely on, so we pin its correctness.
describe('haversineMeters', () => {
  it('is zero for identical points', () => {
    expect(haversineMeters(-33.9249, 18.4241, -33.9249, 18.4241)).toBeCloseTo(0, 6);
  });

  it('is ~111.2 km per degree of latitude at the equator', () => {
    const m = haversineMeters(0, 0, 1, 0);
    expect(m).toBeGreaterThan(111_000);
    expect(m).toBeLessThan(111_400);
  });

  it('matches the known London→Paris great-circle (~343 km)', () => {
    const m = haversineMeters(51.5074, -0.1278, 48.8566, 2.3522);
    expect(m / 1000).toBeGreaterThan(340);
    expect(m / 1000).toBeLessThan(346);
  });

  it('is symmetric', () => {
    const a = haversineMeters(40.7128, -74.006, 34.0522, -118.2437);
    const b = haversineMeters(34.0522, -118.2437, 40.7128, -74.006);
    expect(a).toBeCloseTo(b, 3);
  });
});
