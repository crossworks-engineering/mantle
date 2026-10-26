/**
 * An end plan reads one key (pid.ts endPlanOf, fix round 2, L3): a free
 * end where several ends meet (two certain sheet links into one point
 * that is no end of its own) draws ONE of them, and its text, its trust
 * word (the mark's state), its check and the image's correction all come
 * from that one end, never a mix: the end the image corrected first, else
 * the first unconfirmed one. Made-up sheets, built as the trace hands
 * them to the drawing.
 */
import { describe, expect, it } from 'vitest';
import { markSuffix, validate } from '@mantle/diagram-templates';
import { buildPid, type GuessCheck, type PidInput, type Verdict } from './pid';
import type { TraceEnd, TraceSheet } from './walk';

const end = (
  node: number,
  extra: Pick<Partial<TraceEnd>, 'equipment' | 'equipmentUnconfirmed'> = {},
): TraceEnd => ({
  node,
  x: node * 10,
  y: 0,
  meets: { kind: 'open' },
  deadleg: false,
  equipment: [],
  instruments: [],
  labels: [],
  ...extra,
});
const sheetOf = (
  tableId: string,
  title: string,
  chains: TraceSheet['runs'][number]['chains'],
  ends: TraceEnd[],
): TraceSheet => ({
  tableId,
  title,
  sourceFileId: null,
  layers: [],
  injectionPoints: [],
  circuitRows: [],
  runs: [{ run: 1, length: 10, chains, tees: [], ends, deadleg: false }],
  deadlegRuns: 0,
  lineNumbers: [],
  blocksOnPath: [],
  joins: [],
});
const guess = (id: string, verdict?: Verdict, alt?: string): GuessCheck => ({
  id,
  kind: 'end',
  guess: `the end ${id}`,
  ...(verdict
    ? {
        answer: {
          verdict,
          ...(alt ? { alt } : {}),
          question: `Is ${id} at its tag?`,
          reason: 'r',
          model: 'm',
          checkedAt: '2026-10-25T10:00:00.000Z',
          crops: [],
        },
      }
    : {}),
});

/** E-101 on PID-A feeds node 2 (no end of its own), which certain links
 *  join to an end near P-2 on PID-B and one near P-3 on PID-C. */
function input(b: GuessCheck, c: GuessCheck): PidInput {
  const a = sheetOf(
    'ta',
    'PID-A',
    [
      {
        id: 'c1',
        from: 1,
        to: 2,
        role: 'main',
        length: 10,
        handles: ['h1'],
        valves: [],
        lineNumbers: [],
      },
    ],
    [end(1, { equipment: ['E-101'] })],
  );
  const sb = sheetOf('tb', 'PID-B', [], [end(1, { equipmentUnconfirmed: 'P-2' })]);
  const sc = sheetOf('tc', 'PID-C', [], [end(1, { equipmentUnconfirmed: 'P-3' })]);
  const link = (to: string) => ({
    from: { sheet: 'PID-A', node: 2 },
    to: { sheet: to, node: 1 },
    basis: 'label' as const,
    guessed: false,
    note: '',
  });
  const near = new Map<string, Verdict>();
  if (b.answer) near.set('tb:1', b.answer.verdict);
  if (c.answer) near.set('tc:1', c.answer.verdict);
  return {
    circuit: 'C',
    sheets: [a, sb, sc],
    links: [link('PID-B'), link('PID-C')],
    equipmentType: () => 'centrifugal-pump',
    checked: {
      near,
      guesses: new Map([
        ['end|tb:1', b],
        ['end|tc:1', c],
      ]),
    },
  };
}
type Conn = { text: string; sheet: string; check?: Record<string, unknown> };
const connectorOf = (pid: Record<string, unknown>): Conn => {
  const conns = pid.offpage as Conn[];
  expect(conns).toHaveLength(1);
  return conns[0]!;
};

describe('an end where several ends meet draws one of them, all from its key (L3)', () => {
  it('the end the image corrected wins: its word, its check, its state; never the other yes', () => {
    const pid = buildPid(input(guess('gb', 'yes'), guess('gc', 'no', 'break')), [], [], []);
    expect(validate('pid', pid).ok).toBe(true);
    const conn = connectorOf(pid);
    expect(conn.text).toBe('BREAK');
    expect(conn.sheet).toBe('BRK');
    expect(conn.check).toMatchObject({ key: 'gc', state: 'corrected', alt: 'break' });
    expect(markSuffix(conn.check!)).toBe(' (FROM IMAGE)');
    expect(JSON.stringify(pid.offpage)).not.toContain('gb');
  });

  it('else the first unconfirmed end: its unsure stays a guess, the other yes is not borrowed', () => {
    const pid = buildPid(input(guess('gb', 'unsure'), guess('gc', 'yes')), [], [], []);
    const conn = connectorOf(pid);
    expect(conn.text).toBe('NEAR P-2');
    expect(conn.check).toMatchObject({ key: 'gb', state: 'unsure' });
    expect(markSuffix(conn.check!)).toBe(' (GUESS)');
    expect(JSON.stringify(pid.offpage)).not.toContain('gc');
  });

  it('unanswered: the first end, unchecked, its GUESS drawn from the mark', () => {
    const pid = buildPid(input(guess('gb'), guess('gc')), [], [], []);
    const conn = connectorOf(pid);
    expect(conn.text).toBe('NEAR P-2');
    expect(conn.check).toMatchObject({ key: 'gb', state: 'unchecked' });
    expect(markSuffix(conn.check!)).toBe(' (GUESS)');
  });
});
