/**
 * The image check (circuit_verify): guesses become questions keyed by
 * handles and coordinates; answers parse to yes / no / unsure; the trace
 * marks a confirmed guess CHECKED BY IMAGE (never certain) and keeps a
 * contradicted or unsure one a GUESS; the whole run with a fake sidecar,
 * model and store (no test ever calls a model). Synthetic sheets only.
 */
import { describe, expect, it } from 'vitest';
import { estimateMeasurer, render, validate } from '@mantle/diagram-templates';
import type { DwgCropSpec } from '@mantle/files';
import {
  appliedChecks,
  batchesFor,
  parseAnswers,
  promptFor,
  questionsFor,
  VERIFY_MAX,
  type AppliedCheck,
  type StoredCheck,
} from './check';
import { endKey, joinKey, linkKey } from './check-keys';
import { CIRCUIT, overviewOf, sheetOne } from './fixtures';
import { verifyCircuit, type CheckAnswer, type VerifyDeps } from './verify';
import { traceCircuit } from './walk';
import type { BlockRow, NodeRow, SegRow, SheetInput, TextRow } from './walk';

const C = '40000-001-01';
const M = `Circuit ${C}`;
const PIPE = 'PROCESS';

const sg = (
  layer: string,
  handle: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  n1: number,
  n2: number,
): SegRow => ({
  layer,
  handle,
  x1,
  y1,
  x2,
  y2,
  length: Math.hypot(x2 - x1, y2 - y1),
  n1,
  n2,
  part: 0,
});

function nodesOf(segs: SegRow[]): NodeRow[] {
  const at = new Map<number, NodeRow>();
  for (const g of segs)
    for (const [n, x, y] of [
      [g.n1, g.x1, g.y1],
      [g.n2, g.x2, g.y2],
    ] as const) {
      const row = at.get(n) ?? {
        id: n,
        x,
        y,
        degree: 0,
        kind: 'end',
        block: '',
        blockHandle: '',
        layers: [],
      };
      row.degree += 1;
      if (!row.layers.includes(g.layer)) row.layers.push(g.layer);
      at.set(n, row);
    }
  for (const r of at.values()) r.kind = r.degree === 1 ? 'end' : r.degree === 2 ? 'joint' : 'tee';
  return [...at.values()];
}

const lineNo = (handle: string, x: number, y: number, number: string): BlockRow => ({
  block: 'LineNumber',
  layer: 'LINENO',
  handle,
  x,
  y,
  attribs: { LINENO: number },
});

function sheet(
  title: string,
  segments: SegRow[],
  network: SegRow[],
  texts: TextRow[] = [],
  blocks: BlockRow[] = [],
): SheetInput {
  return {
    tableId: `t-${title}`,
    title,
    sourceFileId: `f-${title}`,
    revision: 'rev1',
    circuitLayers: [...new Set(segments.map((g) => g.layer))],
    circuitRows: [],
    segments,
    nodes: nodesOf([...segments, ...network]),
    inserts: [],
    texts,
    blocks,
    near: 2,
    network,
    limits: [],
  };
}

/** Two pieces joined through 10 units of PROCESS: an inferred join. */
const joinSheet = () =>
  sheet(
    'PID-9201',
    [sg(M, 'A', 0, 0, 20, 0, 1, 2), sg(M, 'B', 30, 0, 50, 0, 3, 4)],
    [
      sg(PIPE, 'pA', 0, 0, 20, 0, 1, 2),
      sg(PIPE, 'pGap', 20, 0, 30, 0, 2, 3),
      sg(PIPE, 'pB', 30, 0, 50, 0, 3, 4),
    ],
    [],
    [lineNo('LA', 10, 1, 'N100-1'), lineNo('LG', 25, 1, 'N100-1')],
  );
/** A run from E-101 whose other end meets nothing drawn, V-201 five units
 *  off: an end only near equipment (a NEAR connector). */
const nearSheet = () =>
  sheet(
    'PID-9401',
    [sg(M, 'A', 0, 0, 20, 0, 1, 2)],
    [],
    [
      { text: 'E-101', layer: 'EQUIP', x: -1, y: 0 },
      { text: 'V-201', layer: 'EQUIP', x: 25, y: 0 },
    ],
  );
const both = () => [joinSheet(), nearSheet()];

type Pid = {
  offpage: { text?: string }[];
  lines: Record<string, unknown>[];
  description: string;
};

describe('questions from the guesses', () => {
  it('an inferred join is a path question; an end near equipment a point question', () => {
    const s = both();
    const r = traceCircuit(C, s);
    const { questions, left } = questionsFor(r.sheets, r.links, s);
    expect(left).toBe(0);
    const join = questions.find((q) => q.kind === 'join')!;
    expect(join.key).toBe(joinKey(['pGap']));
    expect(join.item).toMatchObject({ kind: 'path', id: join.id, pad: 4 });
    const pts = (join.item as { points: [number, number][] }).points;
    expect(pts[0]).toEqual([20, 0]);
    expect(pts[pts.length - 1]).toEqual([30, 0]);
    expect(join.question).toMatch(/green rings/);
    const end = questions.find((q) => q.kind === 'end')!;
    expect(end.key).toBe(endKey('A', 20, 0));
    expect(end.question).toMatch(/V-201/);
    expect(end.item).toMatchObject({ kind: 'point', at: [20, 0] });
    expect(questions.map((q) => q.id)).toEqual(questions.map((_, i) => `q${i + 1}`));
  });

  it('kinds and max narrow the questions; the rest is counted', () => {
    const s = both();
    const r = traceCircuit(C, s);
    expect(questionsFor(r.sheets, r.links, s, { kinds: ['end'] }).questions).toHaveLength(1);
    const capped = questionsFor(r.sheets, r.links, s, { max: 1 });
    expect(capped.questions).toHaveLength(1);
    expect(capped.left).toBe(1);
  });

  it('a guessed sheet link is a point question at the end it leaves from', () => {
    const segs = [sg(M, 'A', 0, 0, 20, 0, 1, 2), sg(M, 'B', 30, 0, 50, 0, 3, 4)];
    const s1 = sheet(
      'PID-9511',
      segs,
      [
        ...segs.map((g) => ({ ...g, layer: PIPE, handle: `p${g.handle}` })),
        sg(PIPE, 'gap', 20, 0, 30, 0, 2, 3),
      ],
      [
        { text: 'CONT. ON PID-9512', layer: 'T', x: 51, y: 1 },
        { text: 'E-101', layer: 'EQUIP', x: -1, y: 0 },
      ],
      [{ ...lineNo('L1', 10, 1, 'N300-2'), attribs: { LINENO: 'N300-2', CIRCUIT: C } }],
    );
    const s2 = sheet(
      'PID-9512',
      [sg(M, 'X', 0, 0, 30, 0, 1, 2)],
      [],
      [{ text: 'CONT. FROM PID-9511', layer: 'T', x: -1, y: 1 }],
      [{ ...lineNo('L3', 15, 1, 'N300-2'), attribs: { LINENO: 'N300-2', CIRCUIT: C } }],
    );
    const r = traceCircuit(C, [s1, s2]);
    expect(r.links[0]!.guessed).toBe(true);
    const link = questionsFor(r.sheets, r.links, [s1, s2], { kinds: ['link'] }).questions;
    expect(link).toHaveLength(1);
    expect(link[0]!.key).toBe(linkKey('B', 50, 0));
    expect(link[0]!.question).toMatch(/PID-9512/);
  });
});

describe('a valve type read from a block name', () => {
  it('is a point question on the symbol, keyed by its handle', () => {
    const generic = JSON.parse(
      JSON.stringify(sheetOne()).replaceAll('GATE_VALVE', 'VALVE-GENERIC'),
    ) as SheetInput;
    const r = traceCircuit(CIRCUIT, [generic]);
    const { questions } = questionsFor(r.sheets, r.links, [generic], { kinds: ['valve'] });
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ kind: 'valve', key: 'valve:V1', handles: ['V1'] });
    expect(questions[0]!.question).toMatch(/gate valve/);
    expect(questions[0]!.item.kind).toBe('point');
  });
});

describe('answers', () => {
  it('parse yes, no and unsure; anything else is unsure and says why', () => {
    const text =
      'Here: {"answers":[{"id":"q1","answer":"Yes","reason":"one line"},{"id":"q2","answer":"no","reason":"two pipes"},{"id":"q3","answer":"maybe"},{"id":"zz","answer":"yes"}]}';
    const a = parseAnswers(text, ['q1', 'q2', 'q3', 'q4']);
    expect(a.get('q1')).toEqual({ verdict: 'yes', reason: 'one line' });
    expect(a.get('q2')).toEqual({ verdict: 'no', reason: 'two pipes' });
    expect(a.get('q3')!.verdict).toBe('unsure');
    expect(a.get('q3')!.reason).toMatch(/not yes, no or unsure \(maybe\)/);
    expect(a.get('q4')).toEqual({
      verdict: 'unsure',
      reason: 'the reply gave no answer to this question',
    });
    expect(a.has('zz')).toBe(false);
    expect(parseAnswers('not json', ['q1']).get('q1')).toEqual({
      verdict: 'unsure',
      reason: 'the reply did not parse',
    });
  });

  it('batches keep a question whole and count the overview once per request', () => {
    const s = both();
    const r = traceCircuit(C, s);
    const { questions } = questionsFor(r.sheets, r.links, s);
    const b = batchesFor('t', questions, (q) => (q.kind === 'join' ? 3 : 1), 4);
    expect(b.map((x) => x.images)).toEqual([4, 2]);
    expect(promptFor(b[0]!)).toMatch(/q1 \(images 2 to 4\)/);
    expect(promptFor(b[0]!, false)).toMatch(/q1 \(images 1 to 3\)/);
    expect(promptFor(b[0]!)).toMatch(/red is the main line, blue a branch, orange a deadleg/);
  });
});

const stored = (key: string, answer: string, revision = 'rev1'): StoredCheck => ({
  key,
  kind: '',
  answer,
  revision,
  checkedAt: '2026-10-25T10:00:00.000Z',
  model: 'm',
  reason: 'r',
  question: '',
  trust: '',
});

describe('the trace shows the checks', () => {
  const traced = (checks: StoredCheck[] | undefined) => {
    const s = both().map((x) => ({ ...x, ...(checks ? { checks } : {}) }));
    const applied: AppliedCheck[] = [];
    const limits: string[] = [];
    const r = traceCircuit(C, s, undefined, {
      checks: (sheets, links) => appliedChecks(sheets, links, s, applied, limits),
    });
    const pid = overviewOf(r.pid) as Pid;
    expect(validate('pid', r.pid).ok).toBe(true);
    const drawn = render('pid', r.pid, estimateMeasurer);
    expect(drawn.ok).toBe(true);
    return { pid, applied, limits, svg: drawn.ok ? drawn.svg : '' };
  };

  it('no checks: the drawing is as before', () => {
    const base = traceCircuit(C, both());
    const { pid } = traced(undefined);
    expect(pid).toEqual(overviewOf(base.pid));
  });

  it('a yes is CHECKED BY IMAGE, never certain', () => {
    const { pid, applied, svg } = traced([
      stored(joinKey(['pGap']), 'yes'),
      stored(endKey('A', 20, 0), 'yes'),
    ]);
    expect(pid.lines.map((l) => l.note)).toContain('INFERRED JOIN (CHECKED BY IMAGE)');
    expect(pid.offpage.map((o) => o.text)).toContain('NEAR V-201 (CHECKED BY IMAGE)');
    expect(pid.description).toMatch(/CHECKED BY IMAGE: a vision model saw the guess/);
    expect(svg).toContain('CHECKED BY IMAGE');
    expect(applied.map((a) => a.trust)).toEqual(['CHECKED BY IMAGE', 'CHECKED BY IMAGE']);
  });

  it('a no stays a GUESS and says the image disagreed; unsure stays a GUESS', () => {
    const { pid, applied } = traced([
      stored(joinKey(['pGap']), 'no'),
      stored(endKey('A', 20, 0), 'unsure'),
    ]);
    expect(pid.lines.map((l) => l.note)).toContain('INFERRED JOIN (GUESS, IMAGE: NO)');
    expect(pid.offpage.map((o) => o.text)).toContain('NEAR V-201 (GUESS)');
    expect(applied.map((a) => a.trust).sort()).toEqual([
      'GUESS (IMAGE SAYS NO)',
      'GUESS (IMAGE UNSURE)',
    ]);
  });

  it("an older revision's checks are kept but not applied; the latest of a key wins", () => {
    const later = { ...stored(joinKey(['pGap']), 'no'), checkedAt: '2026-10-26T00:00:00.000Z' };
    const { pid, limits } = traced([
      stored(endKey('A', 20, 0), 'yes', 'rev0'),
      stored(joinKey(['pGap']), 'yes'),
      later,
    ]);
    expect(pid.offpage.map((o) => o.text)).toContain('NEAR V-201 (GUESS)');
    expect(pid.lines.map((l) => l.note)).toContain('INFERRED JOIN (GUESS, IMAGE: NO)');
    expect(limits.join(' ')).toMatch(/PID-9401: 1 image check of an older revision/);
  });
});

describe('verifyCircuit with a fake sidecar, model and store', () => {
  const png = Buffer.from('png');
  function deps(over: Partial<VerifyDeps> = {}) {
    const calls = { crop: [] as DwgCropSpec[], ask: [] as { n: number; prompt: string }[] };
    const filed: CheckAnswer[] = [];
    const d: VerifyDeps = {
      readSheets: async () => ({ sheets: both(), limits: [] }),
      fileBytes: async () => Buffer.from('dxf'),
      crop: async (_b, spec) => {
        calls.crop.push(spec);
        return {
          ok: true,
          value: {
            converter: 'none',
            crops: spec.items.flatMap((it) =>
              (it.kind === 'path' ? [0, 1] : [0]).map((part, _i, all) => ({
                id: it.id,
                part,
                of: all.length,
                window: [0, 0, 1, 1] as [number, number, number, number],
                width: 100,
                height: 100,
                textPx: 14,
                png,
              })),
            ),
            overview: { window: [0, 0, 1, 1], png },
            capped: [],
          },
        };
      },
      worker: async () => ({
        ok: true,
        worker: { slug: 'drawing-check', provider: 'openrouter', model: 'gm', fellBack: false },
        multiImage: true,
      }),
      ask: async (images, prompt) => {
        calls.ask.push({ n: images.length, prompt });
        const ids = [...prompt.matchAll(/^(q\d+) \(/gm)].map((m) => m[1]);
        return {
          text: JSON.stringify({
            answers: ids.map((id) => ({ id, answer: 'yes', reason: 'one pipe' })),
          }),
          model: 'google/gemini-pro-x',
          tokensIn: 1000,
          tokensOut: 50,
        };
      },
      store: async (_o, _s, _c, answers) => {
        filed.push(...answers);
        return { stored: answers.length };
      },
      now: () => new Date('2026-10-25T12:00:00.000Z'),
      ...over,
    };
    return { d, calls, filed };
  }
  type Out = {
    summary: string;
    answers: { answer: string; trust: string; model: string; crops: number }[];
    usage: { requests: number; crops: number; tokens_in: number };
    limits: string[];
    not_asked?: { id: string; why: string }[];
    questions?: unknown[];
  };

  it('crops each sheet once, asks once per sheet, files every answer with its model and crops', async () => {
    const { d, calls, filed } = deps();
    const r = await verifyCircuit('o', { circuit: C }, d);
    expect(r.ok).toBe(true);
    const out = (r as { output: Out }).output;
    expect(calls.crop).toHaveLength(2);
    expect(calls.crop[0]!.overlay?.length).toBeGreaterThan(0);
    expect(calls.ask).toHaveLength(2);
    // Each sheet: its overview, then two crops of the join or one of the end.
    expect(calls.ask.map((a) => a.n)).toEqual([3, 2]);
    expect(out.answers.map((a) => [a.answer, a.trust, a.model, a.crops])).toEqual([
      ['yes', 'CHECKED BY IMAGE', 'google/gemini-pro-x', 2],
      ['yes', 'CHECKED BY IMAGE', 'google/gemini-pro-x', 1],
    ]);
    expect(out.usage).toMatchObject({ requests: 2, crops: 3, tokens_in: 2000 });
    expect(filed).toHaveLength(2);
    expect(out.summary).toMatch(/never certain/);
  });

  it('a dry run lists the questions and spends nothing', async () => {
    const { d, calls } = deps();
    const r = await verifyCircuit('o', { circuit: C, dryRun: true }, d);
    expect((r as { output: Out }).output.questions).toHaveLength(2);
    expect(calls.crop).toHaveLength(0);
    expect(calls.ask).toHaveLength(0);
  });

  it('the request cap is said, never silently dropped', async () => {
    const { d, calls } = deps({
      readSheets: async () => ({
        sheets: Array.from({ length: VERIFY_MAX.requests + 2 }, (_, i) => ({
          ...nearSheet(),
          tableId: `t-${i}`,
          title: `PID-92${i}`,
        })),
        limits: [],
      }),
    });
    const r = await verifyCircuit('o', { circuit: C, maxQuestions: 40 }, d);
    const out = (r as { output: Out }).output;
    expect(calls.ask.length).toBe(VERIFY_MAX.requests);
    expect(out.not_asked?.some((n) => /request cap/.test(n.why))).toBe(true);
  });

  it('a fallback worker is named; a provider without several images is refused', async () => {
    const fell = deps({
      worker: async () => ({
        ok: true,
        worker: { slug: 'vision-read', provider: 'openrouter', model: 'cheap', fellBack: true },
        multiImage: true,
      }),
    });
    const r = await verifyCircuit('o', { circuit: C }, fell.d);
    expect((r as { output: Out }).output.limits.join(' ')).toMatch(
      /no enabled drawing-check worker: the default vision worker 'vision-read' \(cheap\) answered/,
    );
    const single = deps({
      worker: async () => ({
        ok: true,
        worker: { slug: 'v', provider: 'anthropic', model: 'x', fellBack: false },
        multiImage: false,
      }),
    });
    const refused = await verifyCircuit('o', { circuit: C }, single.d);
    expect(refused.ok).toBe(false);
    expect(single.calls.crop).toHaveLength(0);
  });

  it('an unparseable reply is unsure for every question in it', async () => {
    const { d } = deps({
      ask: async () => ({ text: 'I think so', model: 'gm' }),
    });
    const r = await verifyCircuit('o', { circuit: C }, d);
    const out = (r as { output: Out }).output;
    expect(out.answers.every((a) => a.answer === 'unsure')).toBe(true);
  });

  it('a store that fails keeps the answers in the result and says so', async () => {
    const { d } = deps({ store: async () => ({ error: 'the table has an unsaved draft' }) });
    const r = await verifyCircuit('o', { circuit: C }, d);
    const out = (r as { output: Out }).output;
    expect(out.answers).toHaveLength(2);
    expect(out.limits.join(' ')).toMatch(/could not be stored in its Checks tab/);
  });
});
