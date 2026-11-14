/** The one check of a step's result (./step-check.ts). */
import { describe, expect, it } from 'vitest';
import { FILE_TABS_WRITE, PIPELINE_CALLS_MAX, PIPELINE_STATE_MAX_BYTES } from './contract';
import { checkStepResult } from './step-check';

const tab = { name: 'T', columns: [{ name: 'A', type: 'text' }], rows: [['x']] };
const write = (input: unknown) => ({
  status: 'ok',
  calls: [{ call: 'tool', tool: FILE_TABS_WRITE, input }],
});

describe('checkStepResult', () => {
  it('takes the four statuses and a write of whole tabs', () => {
    for (const status of ['ok', 'not_mine', 'unsure', 'failed']) {
      expect(checkStepResult({ status }).ok).toBe(true);
    }
    expect(checkStepResult(write({ tabs: [tab] })).ok).toBe(true);
    expect(checkStepResult({ status: 'ok', kind: 'x'.repeat(64) }).ok).toBe(true);
  });

  it('refuses each limit', () => {
    const why = (raw: unknown) => {
      const out = checkStepResult(raw);
      return out.ok ? null : out.why;
    };
    expect(why(null)).toMatch(/status/);
    expect(why({ status: 'done' })).toMatch(/status/);
    expect(why({ status: 'ok', calls: {} })).toMatch(/not a list/);
    const many = Array.from({ length: PIPELINE_CALLS_MAX + 1 }, () => ({
      call: 'worker',
      worker: 'w',
      input: 1,
    }));
    expect(why({ status: 'ok', calls: many })).toMatch(/more than 64 calls/);
    expect(why({ status: 'ok', calls: [{ call: 'shell' }] })).toMatch(/neither/);
    expect(why({ status: 'ok', calls: [{ call: 'worker' }] })).toMatch(/no worker/);
    expect(why(write({ tabs: [{ name: 'T', columns: 'A', rows: [] }] }))).toMatch(/form of sheets/);
    expect(why(write({}))).toMatch(/form of sheets/);
    expect(why({ status: 'ok', state: 'x'.repeat(PIPELINE_STATE_MAX_BYTES) })).toMatch(/256 KB/);
    expect(why({ status: 'ok', kind: 'x'.repeat(65) })).toMatch(/kind/);
    expect(why({ status: 'ok', kind: 7 })).toMatch(/kind/);
    expect(why({ status: 'ok', warnings: 5 })).toMatch(/field of the result/);
    expect(why({ status: 'ok', warnings: ['a', 1] })).toMatch(/field of the result/);
    expect(why({ status: 'ok', counts: { a: 'x' } })).toMatch(/field of the result/);
    expect(why({ status: 'ok', counts: [1] })).toMatch(/field of the result/);
    expect(why({ status: 'ok', answer: {} })).toMatch(/field of the result/);
    expect(why(write({ tabs: [tab], description: {} }))).toMatch(/field of the write/);
    expect(why(write({ tabs: [tab], pictures: [{ file: 'a.png' }] }))).toMatch(
      /field of the write/,
    );
    expect(why(write({ tabs: [{ ...tab, rows: [[{}]] }] }))).toMatch(/form of sheets/);
    // In the job, before JSON: a number that is not finite.
    expect(why(write({ tabs: [{ ...tab, rows: [[Number.NaN]] }] }))).toMatch(/form of sheets/);
    expect(
      checkStepResult({
        ...write({
          tabs: [tab],
          description: 'd',
          ftsSkipColumns: ['Svg'],
          sourceSha256: 'x',
          text: 't',
          pictures: [{ file: 'a.png', mime: 'image/png', caption: 'c' }],
        }),
        warnings: ['w'],
        counts: { rows: 1 },
        confidence: 0.5,
        answer: 'a',
      }).ok,
    ).toBe(true);
  });
});
