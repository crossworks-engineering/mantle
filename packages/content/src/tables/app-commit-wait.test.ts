/**
 * A team app's commit waits out a model pass (delta audit MED-1): refused
 * while a pass is pending or running, and a commit that runs the whole pass
 * refused within ten minutes of the last one. A cell-only commit on a
 * summarised Table (a re-embed) is never held.
 */
import { describe, expect, it } from 'vitest';
import { APP_COMMIT_PASS_GAP_MS, APP_COMMIT_WAIT_MESSAGE, appCommitWait } from './draft';

const now = Date.parse('2026-10-22T12:00:00Z');
const ago = (ms: number) => new Date(now - ms).toISOString();
const MIN = 60_000;

describe('appCommitWait', () => {
  it('a pass pending or running: refused, whatever the change', () => {
    const data = { index_work: 'extract', summary: 's' };
    for (const change of [null, 'cells', 'schema'] as const)
      expect(appCommitWait(data, change, now)).toBe(APP_COMMIT_WAIT_MESSAGE);
  });

  it('a whole pass within ten minutes of the last: refused', () => {
    expect(appCommitWait({ extract_completed_at: ago(2 * MIN) }, 'schema', now)).toBe(
      APP_COMMIT_WAIT_MESSAGE,
    );
    expect(appCommitWait({ summary: '', summary_at: ago(9 * MIN) }, 'schema', now)).toBe(
      APP_COMMIT_WAIT_MESSAGE,
    );
    expect(
      appCommitWait({ extract_skipped: { reason: 'empty', at: ago(MIN) } }, 'schema', now),
    ).toBe(APP_COMMIT_WAIT_MESSAGE);
  });

  it('the latest of the markers counts', () => {
    const data = { extract_completed_at: ago(60 * MIN), summary_at: ago(3 * MIN) };
    expect(appCommitWait(data, 'schema', now)).toBe(APP_COMMIT_WAIT_MESSAGE);
  });

  it('a whole pass after ten minutes, or with no pass yet: allowed', () => {
    expect(
      appCommitWait({ extract_completed_at: ago(APP_COMMIT_PASS_GAP_MS + MIN) }, 'schema', now),
    ).toBeNull();
    expect(appCommitWait({}, 'schema', now)).toBeNull();
    expect(appCommitWait(null, 'schema', now)).toBeNull();
    expect(appCommitWait({ extract_completed_at: 'not a date' }, 'schema', now)).toBeNull();
  });

  it('a cell-only commit (a re-embed) right after a pass: allowed', () => {
    const data = { summary: 's', extract_completed_at: ago(MIN), index_work: 'embed' };
    expect(appCommitWait(data, 'cells', now)).toBeNull();
    expect(appCommitWait(data, null, now)).toBeNull();
  });
});
