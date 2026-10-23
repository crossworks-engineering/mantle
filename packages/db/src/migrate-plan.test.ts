import { describe, expect, it } from 'vitest';
import { GAP_REFUSED_FROM, gapRefusal, gapWarning, planMigrations } from './migrate-plan';

/** Arch A6 fix round 1, H1: a migration below the high-water mark that was
 *  never applied is never skipped silently. */
describe('planMigrations', () => {
  const entry = (idx: number, when: number) => ({
    idx,
    tag: `${String(idx).padStart(4, '0')}_m${idx}`,
    when,
  });
  const mig = (when: number, hash = `h${when}`) => ({ folderMillis: when, hash });
  const journal = [
    entry(210, 100),
    entry(212, 120),
    entry(289, 200),
    entry(290, 210),
    entry(291, 220),
  ];
  const migrations = journal.map((e) => mig(e.when));
  const ledger = (whens: number[]) => whens.map((w) => ({ hash: `h${w}`, created_at: String(w) }));

  it('refuses from 0290 on', () => {
    expect(GAP_REFUSED_FROM).toBe(290);
  });

  it('applies everything on an empty ledger, no gap', () => {
    const p = planMigrations(migrations, journal, []);
    expect(p.lastWhen).toBe(-1);
    expect(p.pending.map((m) => m.folderMillis)).toEqual([100, 120, 200, 210, 220]);
    expect(p.gaps).toEqual([]);
  });

  it('applies what is above the mark when nothing below is missing', () => {
    const p = planMigrations(migrations, journal, ledger([100, 120, 200]));
    expect(p.pending.map((m) => m.folderMillis)).toEqual([210, 220]);
    expect(p.gaps).toEqual([]);
  });

  it('refuses 0290 missing below 0291 (a lower number merged after a higher one)', () => {
    const p = planMigrations(migrations, journal, ledger([100, 120, 200, 220]));
    expect(p.pending).toEqual([]);
    expect(p.gaps).toEqual([
      { idx: 290, tag: '0290_m290', when: 210, hash: 'h210', refused: true },
    ]);
    const text = gapRefusal(p.gaps);
    expect(text).toContain('0290_m290 (when 210)');
    expect(text).toContain('Nothing was applied');
  });

  it('only warns on an older gap, and still applies what is above the mark', () => {
    const p = planMigrations(migrations, journal, ledger([100, 200]));
    expect(p.pending.map((m) => m.folderMillis)).toEqual([210, 220]);
    expect(p.gaps).toEqual([
      { idx: 212, tag: '0212_m212', when: 120, hash: 'h120', refused: false },
    ]);
    expect(gapWarning(p.gaps[0]!)).toMatch(/WARNING migration 0212_m212 .* below 0290/);
  });

  it('counts an entry applied by its hash under an older stamp (a re-stamp) as applied', () => {
    const p = planMigrations(migrations, journal, [
      ...ledger([100, 200, 210, 220]),
      { hash: 'h120', created_at: '90' },
    ]);
    expect(p.gaps).toEqual([]);
    expect(p.pending).toEqual([]);
  });

  it('counts an entry edited in place (same when, new hash) as applied', () => {
    const p = planMigrations(
      migrations,
      journal,
      ledger([100, 120, 200, 210, 220]).map((r) =>
        r.created_at === '210' ? { ...r, hash: 'old' } : r,
      ),
    );
    expect(p.gaps).toEqual([]);
  });

  it('refuses a gap the journal does not name (nothing says it is historic)', () => {
    const p = planMigrations([mig(50), ...migrations], journal, ledger([100, 120, 200, 210, 220]));
    expect(p.gaps).toEqual([{ idx: -1, tag: 'when 50', when: 50, hash: 'h50', refused: true }]);
  });

  it('ignores ledger rows of entries the journal no longer has', () => {
    const p = planMigrations(migrations, journal, [
      ...ledger([100, 120, 200, 210]),
      { hash: 'gone', created_at: '205' },
      { hash: 'null-stamp', created_at: null },
    ]);
    expect(p.lastWhen).toBe(210);
    expect(p.pending.map((m) => m.folderMillis)).toEqual([220]);
    expect(p.gaps).toEqual([]);
  });

  it('refuses an entry from 0314 on whose stamp ran under another hash', () => {
    const j = [...journal, { idx: 314, tag: '0314_m314', when: 230 }, { idx: 315, tag: '0315_m315', when: 240 }];
    const ms = [...migrations, mig(230), mig(240)];
    const p = planMigrations(ms, j, [
      ...ledger([100, 120, 200, 210, 220, 240]),
      { hash: 'another-branch', created_at: '230' },
    ]);
    expect(p.gaps).toEqual([
      { idx: 314, tag: '0314_m314', when: 230, hash: 'h230', refused: true, otherHash: true },
    ]);
    expect(gapRefusal(p.gaps)).toContain('that stamp ran here under another hash');
  });

  it('counts an entry from 0314 on as applied when its hash ran under another stamp', () => {
    const j = [...journal, { idx: 314, tag: '0314_m314', when: 230 }];
    const p = planMigrations([...migrations, mig(230)], j, [
      ...ledger([100, 120, 200, 210, 220]),
      { hash: 'h230', created_at: '90' },
      { hash: 'other', created_at: '230' },
    ]);
    expect(p.gaps).toEqual([]);
  });
});
