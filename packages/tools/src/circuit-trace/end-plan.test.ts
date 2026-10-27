/**
 * An end plan reads one key (pid.ts): a free end where several ends meet
 * (two certain sheet links into one point that is no end of its own)
 * draws ONE of them, and its text, its plain word and the image's
 * correction all come from that one end, never a mix: the end the image
 * corrected first, else the first unconfirmed one. Made-up sheets, built
 * as the trace hands them to the drawing.
 */
import { describe, expect, it } from 'vitest';
import { validate } from '@mantle/diagram-templates';
import { buildPid, type PidInput, type Verdict } from './pid';
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
/** One end's answer: its verdict and, after a no, the alternative. */
type Answer = { verdict?: Verdict; alt?: string };
const guess = (verdict?: Verdict, alt?: string): Answer => ({
  ...(verdict ? { verdict } : {}),
  ...(alt ? { alt } : {}),
});

/** E-101 on PID-A feeds node 2 (no end of its own), which certain links
 *  join to an end near P-2 on PID-B and one near P-3 on PID-C. */
function input(b: Answer, c: Answer): PidInput {
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
  if (b.verdict) near.set('tb:1', b.verdict);
  if (c.verdict) near.set('tc:1', c.verdict);
  const alts = new Map<string, string>();
  if (b.alt) alts.set('end|tb:1', b.alt);
  if (c.alt) alts.set('end|tc:1', c.alt);
  return {
    circuit: 'C',
    sheets: [a, sb, sc],
    links: [link('PID-B'), link('PID-C')],
    equipmentType: () => 'centrifugal-pump',
    checked: { near, alts },
  };
}
type Conn = { text: string; sheet: string };
const connectorOf = (pid: Record<string, unknown>): Conn => {
  const conns = pid.offpage as Conn[];
  expect(conns).toHaveLength(1);
  return conns[0]!;
};

describe('an end where several ends meet draws one of them, all from its key', () => {
  it('the end the image corrected wins: its word and its sheet; never the other yes', () => {
    const pid = buildPid(input(guess('yes'), guess('no', 'break')), [], []);
    expect(validate('pid', pid).ok).toBe(true);
    const conn = connectorOf(pid);
    expect(conn.text).toBe('BREAK (FROM IMAGE)');
    expect(conn.sheet).toBe('BRK');
    expect(JSON.stringify(pid.offpage)).not.toContain('CHECKED BY IMAGE');
  });

  it('else the first unconfirmed end: its unsure stays a guess, the other yes is not borrowed', () => {
    const pid = buildPid(input(guess('unsure'), guess('yes')), [], []);
    const conn = connectorOf(pid);
    expect(conn.text).toBe('NEAR P-2 (GUESS)');
    expect(JSON.stringify(pid.offpage)).not.toContain('CHECKED BY IMAGE');
  });

  it('unanswered: the first end, GUESS in its own text', () => {
    const pid = buildPid(input(guess(), guess()), [], []);
    expect(connectorOf(pid).text).toBe('NEAR P-2 (GUESS)');
  });
});
