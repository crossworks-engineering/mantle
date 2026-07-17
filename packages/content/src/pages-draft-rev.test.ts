import { describe, expect, it } from 'vitest';
import { evaluateDraftRev } from './pages';

/**
 * Page draft concurrency control (audit item #3). The DB-touching seams
 * (`saveDraft` / `commitPage` / `discardDraft` under `withPageLock`) can't be
 * unit-tested in this package — nothing here has a Postgres harness (all 40+
 * suites are pure). So the etag DECISION is factored out as `evaluateDraftRev`
 * and exercised here; the mutators apply it INSIDE the row lock and, on a
 * conflict, return BEFORE writing — so "stale base ⇒ draft not overwritten /
 * nothing published" is a structural property of that ordering, guaranteed by
 * these cases plus the single call shape each mutator uses. The end-to-end HTTP
 * conflict (409 + current_rev) is covered by the route wiring, not this file.
 */
describe('evaluateDraftRev', () => {
  it('bumps the rev when baseRev matches the current rev (conditional save success)', () => {
    expect(evaluateDraftRev(4, 4)).toEqual({ conflict: false, nextRev: 5 });
  });

  it('matches at rev 0 (a never-edited page)', () => {
    expect(evaluateDraftRev(0, 0)).toEqual({ conflict: false, nextRev: 1 });
  });

  it('conflicts on a stale baseRev, reporting the CURRENT server rev (not the bump)', () => {
    // The client loaded rev 3 but another writer advanced it to 7 — no write.
    expect(evaluateDraftRev(7, 3)).toEqual({ conflict: true, rev: 7 });
  });

  it('conflicts even when the stale base is only one behind', () => {
    expect(evaluateDraftRev(6, 5)).toEqual({ conflict: true, rev: 6 });
  });

  it('conflicts when the client is somehow AHEAD (never trust a mismatched base)', () => {
    expect(evaluateDraftRev(2, 9)).toEqual({ conflict: true, rev: 2 });
  });

  it('always proceeds and bumps when baseRev is absent (internal / agent callers)', () => {
    // No etag presented → serialized by the lock, rev-bumped, never a conflict.
    expect(evaluateDraftRev(11, undefined)).toEqual({ conflict: false, nextRev: 12 });
    expect(evaluateDraftRev(0, undefined)).toEqual({ conflict: false, nextRev: 1 });
  });
});
