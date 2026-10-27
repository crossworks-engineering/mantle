/**
 * The bounds the `pid` template checks before anything walks raw data
 * (templates/pid/limits.ts pidLimitsProblem, run first by validatePid and
 * validatePidSet), the typo hint's own bound (runtime/validate.ts
 * suggest), and errors that repeat an author's text short. Availability:
 * the largest data a canvas holds (1 MB) is refused or checked well under
 * 200 ms. Synthetic data only.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pidLimitsProblem, RAW_LIMITS, validate } from './index.ts';
import { SAID_MAX, SUGGEST_LIMITS, suggest } from './runtime/validate.ts';

const ROOT = join(import.meta.dirname, '..');
const sample = (f: string) => JSON.parse(readFileSync(join(ROOT, f), 'utf8')) as unknown;
/** One megabyte, the canvas cap. */
const MB = 1_000_000;
/** Well under the 200 ms an audit allows a check. */
const FAST = 200;
const timed = <T>(f: () => T): { out: T; ms: number } => {
  const t = performance.now();
  const out = f();
  return { out, ms: performance.now() - t };
};
const drawing = (extra: Record<string, unknown> = {}) => ({
  template: 'pid',
  title: 'Bounds',
  equipment: [{ id: 'V-1', type: 'vertical-vessel' }],
  offpage: [{ id: 'OPC-1', direction: 'out', sheet: 'S2', text: 'TO S2' }],
  lines: [{ id: 'L1', from: 'V-1', to: 'OPC-1' }],
  ...extra,
});

describe('the bounds of raw pid data (pidLimitsProblem)', () => {
  it('data the template draws is within them: the samples, a set, a traced drawing', () => {
    for (const f of [
      'samples/pid-feed-drum.json',
      'samples/pid-tees-branches.json',
      'samples/pid-column-site-profile.json',
      'test/pid-all-parts.json',
      'test/pid-set.json',
      'test/pid-set-links.json',
      'test/pid-set-labels.json',
    ])
      expect(pidLimitsProblem(sample(f)), f).toBeNull();
    expect(pidLimitsProblem(drawing())).toBeNull();
  });

  it('past one, the first problem by its path', () => {
    const line = (extra: Record<string, unknown>) => drawing({ lines: [{ id: 'L1', ...extra }] });
    const cases: [string, unknown, RegExp][] = [
      [
        'too many inline items',
        line({ inline: Array.from({ length: 7 }, () => ({ type: 'gate' })) }),
        /lines\[0\]\.inline: 7 items/,
      ],
      ['a long note', line({ note: 'x'.repeat(33) }), /lines\[0\]\.note: 33 characters/],
      [
        'too many lines',
        drawing({ lines: Array.from({ length: 61 }, (_, i) => ({ id: `L${i}` })) }),
        /^lines: 61 items, at most 60$/,
      ],
      [
        'too many pages',
        { title: 'S', pages: Array.from({ length: 41 }, (_, i) => ({ id: `p${i}`, data: {} })) },
        /^pages: 41 items, at most 40$/,
      ],
      [
        "a page's drawing",
        { title: 'S', pages: [{ id: 'p', data: drawing({ title: 't'.repeat(81) }) }] },
        /^pages\[0\]\.data\.title: 81 characters/,
      ],
      [
        'a string past the longest the template takes, in a field with no limit of its own',
        drawing({ signals: [{ from: 'x'.repeat(RAW_LIMITS.string + 1), to: 'y' }] }),
        /^signals\[0\]\.from: 2001 characters, at most 2000$/,
      ],
      [
        'a list past the longest the template takes',
        drawing({ circuits: [{ id: 'c', lines: Array.from({ length: 4001 }, () => 'L1') }] }),
        /^circuits\[0\]\.lines: 4001 items/,
      ],
      [
        'a nesting past the deepest the template takes',
        drawing({ profile: JSON.parse(`${'{"a":'.repeat(20)}1${'}'.repeat(20)}`) }),
        /nested past 16/,
      ],
    ];
    for (const [why, data, problem] of cases) expect(pidLimitsProblem(data), why).toMatch(problem);
  });

  it('every bound named is one the template check refuses too', () => {
    // Never a drawing the template would draw: each case past a named
    // bound is also an error of the template's own check.
    const over = drawing({ lines: [{ id: 'L1', from: 'V-1', to: 'OPC-1', note: 'x'.repeat(33) }] });
    expect(pidLimitsProblem(over)).not.toBeNull();
    expect(validate('pid', over).ok).toBe(false);
  });
});

describe('the check refuses data past a bound before any pass reads it', () => {
  it('a long id where a typo hint would compare it: refused at once', () => {
    const big = 'x'.repeat(MB - 2000);
    const { out, ms } = timed(() =>
      validate('pid', drawing({ lines: [{ id: 'L1', from: big, to: 'OPC-1' }] })),
    );
    expect(out.ok).toBe(false);
    expect(out.ok ? '' : out.errors.join(' ')).toMatch(/larger than a P&ID drawing can hold/);
    expect(ms).toBeLessThan(FAST);
  });

  it('a nesting 400 000 deep', () => {
    const deep = JSON.parse(`${'['.repeat(400_000)}${']'.repeat(400_000)}`) as unknown;
    const { out, ms } = timed(() => validate('pid', drawing({ circuits: deep })));
    expect(out.ok).toBe(false);
    expect(ms).toBeLessThan(FAST);
  });

  it('the largest strings within the bounds, at every unknown id, check fast', () => {
    // 60 lines, each naming an end that is not there, each name at the
    // longest a string may be: a typo hint is never looked for past
    // SUGGEST_LIMITS.chars, so the check stays linear.
    const lines = Array.from({ length: 60 }, (_, i) => ({
      id: `L${i}`,
      from: `${'V'.repeat(RAW_LIMITS.string - 4)}${i}`,
      to: 'OPC-1',
    }));
    const { out, ms } = timed(() => validate('pid', drawing({ lines })));
    expect(out.ok).toBe(false);
    expect(ms).toBeLessThan(FAST);
  });
});

describe('the typo hint is bounded (suggest)', () => {
  it('still hints a short typo', () => {
    expect(suggest('vertcal-vessel', ['vertical-vessel', 'pump'])).toBe('vertical-vessel');
  });

  it('never compares a value or an option past SUGGEST_LIMITS.chars', () => {
    const long = 'a'.repeat(SUGGEST_LIMITS.chars + 1);
    expect(suggest(long, [long])).toBeNull();
    expect(suggest('abc', [`${'a'.repeat(SUGGEST_LIMITS.chars)}bc`, 'abd'])).toBe('abd');
  });

  it('reads at most SUGGEST_LIMITS.options options', () => {
    const options = [
      ...Array.from({ length: SUGGEST_LIMITS.options }, (_, i) => `zz${i}zz`),
      'L1x',
    ];
    expect(suggest('L1', options)).toBeNull();
    expect(suggest('L1', ['L1x'])).toBe('L1x');
  });
});

describe('an error repeats an author string short and quoted', () => {
  const sheet = (extra: Record<string, unknown>) => ({
    title: 'Said',
    equipment: [{ id: 'V-1', type: 'vertical-vessel' }],
    ...extra,
  });
  const longest = (errors: string[]) =>
    Math.max(0, ...errors.flatMap((e) => [...e.matchAll(/'([^']*)'/g)].map((m) => m[1]!.length)));

  it('a key, a value or a template name of any length is cut to SAID_MAX with an ellipsis', () => {
    const long = 'K'.repeat(300);
    const cases: unknown[] = [
      sheet({ profile: { serviceColours: { [long]: 'v'.repeat(300) } } }),
      sheet({ profile: { serviceColours: { P: 'v'.repeat(300) } } }),
      sheet({ [long]: 1 }),
      { ...sheet({}), template: 't'.repeat(300) },
      sheet({ profile: { instrumentFirstLetters: { [long]: 'x' } } }),
    ];
    for (const c of cases) {
      const v = validate('pid', c);
      expect(v.ok).toBe(false);
      const errors = v.ok ? [] : v.errors;
      expect(errors.join(' ')).toContain('…');
      expect(longest(errors)).toBeLessThanOrEqual(SAID_MAX);
      for (const e of errors) expect(e.length).toBeLessThan(600);
    }
  });

  it('a short one is repeated whole', () => {
    const v = validate('pid', sheet({ profile: { serviceColours: { P: 'teal' } } }));
    expect(v.ok ? '' : v.errors.join(' ')).toContain("profile.serviceColours.P: 'teal' is not");
  });
});
