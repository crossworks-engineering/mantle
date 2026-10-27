/**
 * The bounds a save checks before it normalizes a `pid` canvas
 * (templates/pid/limits.ts pidLimitsProblem, canvas.ts
 * withHonestImageChecks), and the time the normalizing passes take on
 * the largest data a canvas holds (1 MB): data past a bound is refused
 * before any pass reads it, the trust-word scan is linear in a label's
 * length, and a line's marks share one site. Each worst case near the
 * cap finishes well under 200 ms. A stand-in HMAC under a test key.
 * Synthetic data only.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCanvas,
  CanvasLimitsError,
  honestImageChecks,
  mapImageChecks,
  pidLimitsProblem,
  provenanceSealBody,
  RAW_LIMITS,
  signImageChecks,
  validate,
  withHonestImageChecks,
  withoutMarkWords,
} from './index.ts';
import { unvouched } from './data-read.ts';

const seal = (body: string) => createHmac('sha256', 'test-key').update(body).digest('hex');
const holds = (body: string, sig: string) => seal(body) === sig;
const PROV = '0123456789abcdef';
const ROOT = join(import.meta.dirname, '..');
const sample = (f: string) => JSON.parse(readFileSync(join(ROOT, f), 'utf8')) as unknown;
/** One megabyte, the canvas cap. */
const MB = 1_000_000;
/** Well under the 200 ms an audit allows a save's checks. */
const FAST = 200;
const timed = <T>(f: () => T): { out: T; ms: number } => {
  const t = performance.now();
  const out = f();
  return { out, ms: performance.now() - t };
};
const canvas = (data: Record<string, unknown>) =>
  buildCanvas({ template: 'pid', data, mode: 'import' });
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
        'a line with too many joins',
        line({ checks: Array.from({ length: 25 }, (_, i) => ({ key: `j${i}` })) }),
        /^lines\[0\]\.checks: 25 items, at most 24$/,
      ],
      [
        'too many inline items',
        line({ inline: Array.from({ length: 7 }, () => ({ type: 'gate' })) }),
        /lines\[0\]\.inline: 7 items/,
      ],
      ['a long note', line({ note: 'x'.repeat(33) }), /lines\[0\]\.note: 33 characters/],
      [
        "a long mark's question",
        line({ checks: [{ key: 'j', question: 'q'.repeat(601) }] }),
        /lines\[0\]\.checks\[0\]\.question: 601 characters, at most 600/,
      ],
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
    // A save never refuses a drawing the template would draw: each case
    // past a named bound is also an error of the template's own check.
    const over = drawing({ lines: [{ id: 'L1', from: 'V-1', to: 'OPC-1', note: 'x'.repeat(33) }] });
    expect(pidLimitsProblem(over)).not.toBeNull();
    expect(validate('pid', over).ok).toBe(false);
  });
});

describe('a save refuses data past a bound before any pass reads it (H1)', () => {
  const refused = (data: Record<string, unknown>, html = canvas(data)) => {
    expect(html.length).toBeLessThan(MB + 64_000);
    const { out, ms } = timed(() => {
      try {
        withHonestImageChecks(html, holds);
        return null;
      } catch (err) {
        return err;
      }
    });
    expect(out).toBeInstanceOf(CanvasLimitsError);
    expect(ms).toBeLessThan(FAST);
    return out as CanvasLimitsError;
  };

  it('a label of 990 000 spaces after a bracket', () => {
    const err = refused(drawing({ lines: [{ id: 'L1', note: `(${' '.repeat(990_000)}` }] }));
    expect(err.problem).toMatch(/^lines\[0\]\.note: 990001 characters/);
  });

  it('a line with 13 000 marks (each site naming every key on the line)', () => {
    const checks = Array.from({ length: 13_000 }, (_, i) => ({ key: `k${i}`, kind: 'join' }));
    const err = refused(drawing({ lines: [{ id: 'L1', checks }] }));
    expect(err.problem).toMatch(/^lines\[0\]\.checks: 13000 items/);
  });

  it('a nesting 400 000 deep', () => {
    // Written by hand: no JSON writer nests that deep.
    const html = canvas(drawing({ profile: { name: 'DEEP' } })).replace(
      '"DEEP"',
      `${'['.repeat(400_000)}${']'.repeat(400_000)}`,
    );
    const err = refused({}, html);
    expect(err.problem).toMatch(/^profile\.name(\[0\])+: nested past 16$/);
  });

  it('the runtime drops the marks of such data, never normalizes it', () => {
    const checks = Array.from({ length: 20_000 }, (_, i) => ({
      key: `k${i}`,
      kind: 'join',
      state: 'checked',
      answer: 'yes',
    }));
    const { out, ms } = timed(() => unvouched(drawing({ lines: [{ id: 'L1', checks }] })));
    expect(ms).toBeLessThan(FAST);
    expect((out as { lines: Record<string, unknown>[] }).lines[0]!.checks).toBeUndefined();
  });
});

describe('the passes are linear on the largest data within the bounds (H1)', () => {
  it('the trust-word scan: 990 000 spaces between a bracket and a word', () => {
    const sp = ' '.repeat(990_000);
    for (const s of [`(${sp}`, `(${sp}GUESS`, `${sp}(CHECKED BY IMAGE)`, `(GUESS,${sp}IMAGE`]) {
      const { ms } = timed(() => withoutMarkWords({ title: s }));
      expect(ms, JSON.stringify(s.slice(0, 20))).toBeLessThan(FAST);
    }
  });

  it('the scan takes what the old pattern led by white space took', () => {
    // The forms once began with \s*: the same text comes out.
    const old = (s: string) =>
      s
        .replace(/\s*\(\s*GUESS\s*\)/gi, '')
        .replace(/\s*\(\s*GUESS\s*[,;]\s*IMAGE\s*:\s*(?:\d+\s+)?NO\s*\)/gi, '')
        .replace(/\s*\(\s*(?:CHECKED\s+BY\s+IMAGE|FROM\s+IMAGE)\s*\)/gi, '');
    const offpage = (text: string) => ({
      title: 'T',
      offpage: [{ id: 'O', text, check: { key: 'k', kind: 'end', state: 'unchecked' } }],
    });
    for (const text of [
      'NEAR V-9 (GUESS)',
      'A  (GUESS)  B',
      '(GUESS) START',
      'X (CHECKED BY IMAGE) (GUESS)',
      'JOINS (GUESS; IMAGE: 2 NO)\t(FROM  IMAGE) END',
      'ONE (guess)(Guess) TWO',
    ]) {
      const out = withoutMarkWords(offpage(text)) as { offpage: { text: string }[] };
      expect(out.offpage[0]!.text, text).toBe(old(text).trim());
    }
  });

  it("a line's marks share one site: 20 000 of them walked at once", () => {
    const checks = Array.from({ length: 20_000 }, (_, i) => ({ key: `k${i}` }));
    let n = 0;
    const { ms } = timed(() =>
      mapImageChecks({ lines: [{ id: 'L', checks }] }, (c) => {
        n += 1;
        return c;
      }),
    );
    expect(n).toBe(20_000);
    expect(ms).toBeLessThan(FAST);
  });

  it('a sealed set near 1 MB, every line carrying its most joins, holds in one pass', () => {
    const page = (p: number) => ({
      title: `P${p}`,
      equipment: [{ id: 'V-1', type: 'vertical-vessel' }],
      offpage: [],
      lines: Array.from({ length: 60 }, (_, i) => ({
        id: `L${i}`,
        from: 'V-1',
        to: 'V-1',
        checks: Array.from({ length: 24 }, (_, j) => ({
          key: `k${p}-${i}-${j}`,
          kind: 'join',
          state: 'checked',
          answer: 'yes',
        })),
      })),
    });
    const set = {
      title: 'S',
      pages: Array.from({ length: 3 }, (_, p) => ({ id: `p${p}`, title: `P${p}`, data: page(p) })),
    };
    const signed = signImageChecks(set, PROV, seal) as Record<string, unknown>;
    const keys: string[] = [];
    signed.provenance = {
      id: PROV,
      keys,
      sig: seal(provenanceSealBody({ id: PROV, keys }, signed)),
    };
    const html = canvas(signed);
    expect(html.length).toBeGreaterThan(0.9 * MB);
    expect(pidLimitsProblem(signed)).toBeNull();
    const { out, ms } = timed(() => withHonestImageChecks(html, holds));
    expect(ms).toBeLessThan(FAST);
    // Every mark held (the counts were added: the canvas carried none).
    expect(honestImageChecks(signed, holds)).toBe(signed);
    expect(out).toContain('"checked": 4320');
  });
});
