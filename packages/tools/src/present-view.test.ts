/**
 * The view side of phase 6 on what the check side writes: a traced circuit
 * (synthetic sheets, the check branch's fixtures) with its image check
 * marks passes the pid check and draws in both styles; every mark is a
 * `data-check` key with its evidence; the "N guesses not checked by image"
 * note is counted from the marks at render time, never from a stored
 * `checks`; present-crops names the crops the marks carry.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  checkStaticSvg,
  estimateMeasurer,
  imageCheckSummary,
  render,
  validate,
  withImageCheckSummary,
} from '@mantle/diagram-templates';
import {
  appliedChecks,
  questionsFor,
  sealFieldsOf,
  type AppliedCheck,
  type StoredCheck,
} from './circuit-trace/check';
import { sealOf } from './circuit-trace/check-seal';
import { CIRCUIT, genericValveSheet, readingSheets } from './circuit-trace/fixtures';
import { traceCircuit, type SheetInput } from './circuit-trace/walk';
import { cropIdsOf } from './present-crops';

beforeAll(() => {
  process.env.MANTLE_MASTER_KEY ??= 'present-view-test-key';
});

const CROP = '0f0f0f0f-0000-4000-8000-000000000001';

/** circuit_trace with sealed answers to the first `answered` questions. */
function traced(sheets: SheetInput[], answer: (i: number) => [string, string] | null) {
  const r0 = traceCircuit(CIRCUIT, sheets);
  const qs = questionsFor(r0.sheets, r0.links, sheets, { max: Infinity }).questions;
  const withRows = sheets.map((s) => ({
    ...s,
    checks: qs
      .map((q, i) => ({ q, a: answer(i) }))
      .filter((x) => x.a && x.q.tableId === s.tableId)
      .map(({ q, a }) => {
        const r: StoredCheck = {
          key: q.key,
          kind: q.kind,
          answer: a![0],
          revision: 'rev1',
          checkedAt: '2026-10-26T09:00:00.000Z',
          model: 'test/vision-model',
          reason: 'what the crop shows',
          question: q.question,
          trust: '',
          circuit: CIRCUIT,
          crops: `overview ${CROP} ${CROP}`,
          ...(a![1] ? { alt: a![1] } : {}),
        };
        return { ...r, seal: sealOf(sealFieldsOf(q.tableId, r)) };
      }),
  }));
  const applied: AppliedCheck[] = [];
  const limits: string[] = [];
  return traceCircuit(CIRCUIT, withRows, undefined, {
    checks: (w, l) => appliedChecks(w, l, withRows, applied, limits),
  });
}

const cases: [string, () => unknown][] = [
  ['unanswered guesses', () => traced(readingSheets(), () => null).pid],
  ['a corrected valve', () => traced([genericValveSheet()], () => ['no', 'orifice']).pid],
  [
    'answers of every kind',
    () => traced(readingSheets(), (i) => (i % 2 ? ['yes', ''] : ['no', ''])).pid,
  ],
];

describe.each(cases)('a traced circuit: %s', (_name, make) => {
  it('passes the pid check and draws in both styles, every mark a key with its evidence', () => {
    const pid = make() as Record<string, unknown>;
    const stored = withImageCheckSummary(pid);
    expect(validate('pid', stored).ok).toBe(true);
    const summary = imageCheckSummary(pid);
    expect(summary).not.toBeNull();
    for (const style of [1, 2]) {
      const r = render('pid', { ...stored, style }, estimateMeasurer);
      if (!r.ok) throw new Error(r.errors.join('\n'));
      expect(r.failed ?? []).toEqual([]);
      expect(checkStaticSvg(r.svg)).toEqual([]);
      const evidence = [...(r.checks ?? []), ...(r.pages ?? []).flatMap((p) => p.checks ?? [])];
      expect(evidence.length).toBeGreaterThan(0);
      for (const e of evidence) expect(r.svg).toContain(`data-check="${e.key}"`);
      const marks = evidence.flatMap((e) => e.checks);
      expect(new Set(marks.map((c) => c.key)).size).toBe(summary!.guesses);
      if (summary!.unchecked)
        expect(r.svg).toMatch(
          new RegExp(`>${summary!.unchecked} GUESS(ES)? NOT CHECKED BY IMAGE<`),
        );
      else expect(r.svg).not.toContain('NOT CHECKED BY IMAGE');
    }
  });
});

describe('the unchecked note is the marks own count', () => {
  it('a stored count that disagrees with the marks is never shown', () => {
    const pid = traced(readingSheets(), () => null).pid as Record<string, unknown>;
    const real = imageCheckSummary(pid)!;
    expect(real.unchecked).toBeGreaterThan(0);
    // A canvas edited through its source: zero claimed, the marks say more.
    const lying = {
      ...withImageCheckSummary(pid),
      checks: { ...real, unchecked: 0, checked: real.guesses },
    };
    const r = render('pid', lying, estimateMeasurer);
    if (!r.ok) throw new Error(r.errors.join('\n'));
    expect(r.svg).toMatch(new RegExp(`>${real.unchecked} GUESS(ES)? NOT CHECKED BY IMAGE<`));
  });

  it('the crops the marks name are the ones a save embeds', () => {
    const pid = traced([genericValveSheet()], () => ['no', 'orifice']).pid;
    expect(cropIdsOf(pid)).toEqual([CROP]);
  });
});
