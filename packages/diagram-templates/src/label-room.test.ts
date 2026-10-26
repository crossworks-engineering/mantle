/**
 * Label overlaps on traced drawing sets: a connector's text written over a
 * guess note ("NEAR ..." over "INFERRED JOIN (GUESS)"), page references
 * ("SEE PAGE 3: ...") running into the next connector or its text. Style 2
 * gives a connector the room of its text lines when it is placed and makes
 * those lines labels at once, so notes, markers, line numbers and valves
 * keep off them. The layout self-check names every label overlap, so the
 * test counts them. Two synthetic multi-page sets, all names made up:
 * test/pid-set-links.json (links on every connector) and
 * test/pid-set-labels.json (a traced random circuit).
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkStaticSvg, estimateMeasurer, render, validate } from './index.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (f: string) =>
  JSON.parse(readFileSync(path.join(ROOT, f), 'utf8')) as Record<string, unknown>;

/** The self-check's notes on a connector's text, its page reference, a
 *  line's note or a "more" marker sitting on something or under a line. */
const labelProblems = (warnings: string[]) =>
  warnings.filter((w) => /label/.test(w) && /'[^']*(?: text| link| note| more)'/.test(w));

describe.each(['test/pid-set-links.json', 'test/pid-set-labels.json'])('%s', (file) => {
  const data = load(file);

  it('checks clean in both styles', () => {
    expect(validate('pid', data).ok).toBe(true);
    expect(validate('pid', { ...data, style: 2 }).ok).toBe(true);
  });

  it('the classic style shows the overlaps (kept byte for byte for old drawings)', () => {
    const r = render('pid', data, estimateMeasurer);
    if (!r.ok) throw new Error(r.errors.join('\n'));
    expect(labelProblems(r.warnings).length).toBeGreaterThan(0);
  });

  it('style 2 draws every page with no connector text, reference, note or marker overlap', () => {
    const r = render('pid', { ...data, style: 2 }, estimateMeasurer);
    if (!r.ok) throw new Error(r.errors.join('\n'));
    expect(r.failed ?? []).toEqual([]);
    expect(labelProblems(r.warnings)).toEqual([]);
    expect(checkStaticSvg(r.svg)).toEqual([]);
    expect(r.pages!.length).toBeGreaterThan(2);
  });
});

describe('page references stay readable', () => {
  it('every link is still printed under its connector in style 2', () => {
    const data = load('test/pid-set-links.json');
    const r = render('pid', { ...data, style: 2 }, estimateMeasurer);
    if (!r.ok) throw new Error(r.errors.join('\n'));
    const refs = (s: string) => (s.match(/>SEE PAGE \d+:/g) ?? []).length;
    const classic = render('pid', data, estimateMeasurer);
    if (!classic.ok) throw new Error(classic.errors.join('\n'));
    expect(refs(r.svg)).toBe(refs(classic.svg));
    expect(refs(r.svg)).toBeGreaterThan(5);
  });
});
