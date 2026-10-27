/**
 * DWG bones phase 6, the check side: a no from the image check also says
 * what the guess really is (a closed list per question), the answer is
 * stored and sealed with it, and the trace uses it: the right valve symbol,
 * an end re-picked when the image says the main line does not start there,
 * every correction labelled FROM IMAGE (never certain) while the raw
 * geometry and the first guess stay in the trace. Synthetic sheets only.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { honestImageChecks, imageCheckSummary, validate } from '@mantle/diagram-templates';
import { drawingSealHolds } from '@mantle/content/drawing-seal';
import {
  ALT_MAX,
  ALT_WORDS,
  altOf,
  appliedChecks,
  cropCellWords,
  cropIdsOf,
  parseAnswers,
  promptFor,
  questionsFor,
  sealFieldsOf,
  sealedRow,
  storedCheckOf,
  type AppliedCheck,
  type CheckQuestion,
  type StoredCheck,
} from './check';
import { sealedPid, sealOf } from './check-seal';
import {
  CIRCUIT,
  overviewOf,
  readingSheets,
  shown,
  genericValveSheet as genericValve,
} from './fixtures';
import { traceCircuit, type RegisterInput, type SheetInput } from './walk';

beforeAll(() => {
  process.env.MANTLE_MASTER_KEY ??= 'circuit-verify-test-key';
});

/** The question asked today about `kind` on the sheets (the first). */
function questionOf(sheets: SheetInput[], kind: CheckQuestion['kind'], node?: number) {
  const r = traceCircuit(CIRCUIT, sheets);
  const qs = questionsFor(r.sheets, r.links, sheets, { max: Infinity }).questions;
  const q = qs.find((x) => x.kind === kind && (node === undefined || x.node === node));
  if (!q) throw new Error(`no ${kind} question`);
  return q;
}

/** A sealed Checks row answering `q`, as circuit_verify files it. */
function row(
  q: CheckQuestion,
  answer: string,
  alt = '',
  crops = 'overview 00000000-0000-4000-8000-0000000000a1 00000000-0000-4000-8000-00000000c001 00000000-0000-4000-8000-00000000c002',
): StoredCheck {
  const r: StoredCheck = {
    key: q.key,
    kind: q.kind,
    answer,
    revision: 'rev1',
    checkedAt: '2026-10-26T09:00:00.000Z',
    model: 'test/vision-model',
    reason: 'what the crop shows',
    question: q.question,
    trust: '',
    circuit: CIRCUIT,
    crops,
    ...(alt ? { alt } : {}),
  };
  return { ...r, seal: sealOf(sealFieldsOf(q.tableId, r)) };
}

/** circuit_trace's way: stored checks applied before the drawing; its
 *  pid as the view draws it (the trust words from the marks). */
function traced(sheets: SheetInput[], register?: RegisterInput) {
  const applied: AppliedCheck[] = [];
  const limits: string[] = [];
  const r = traceCircuit(CIRCUIT, sheets, register, {
    checks: (w, l) => appliedChecks(w, l, sheets, applied, limits),
  });
  return { r: { ...r, pid: shown(r.pid) }, applied, limits };
}

describe('a no asks what it is then', () => {
  it('each question lists its alternatives, and the prompt asks for one only with a no', () => {
    const valve = questionOf([genericValve()], 'valve');
    expect(valve.alts).toContain('orifice');
    expect(valve.alts).not.toContain('gate');
    for (const w of ALT_WORDS.valve) expect(valve.alts).toContain(w);
    const end = questionOf(readingSheets(), 'end', 1);
    // The other equipment written near the end, then the end words.
    expect(end.alts[0]).toBe('P-150');
    expect(end.alts).not.toContain('E-101');
    for (const w of ALT_WORDS.end) expect(end.alts).toContain(w);
    const prompt = promptFor({
      tableId: valve.tableId,
      questions: [{ q: valve, crops: [0] }],
      images: 2,
    });
    expect(prompt).toContain(valve.question);
    expect(prompt).toMatch(/If no, give "alt"/);
    expect(prompt).toContain('"orifice"');
    expect(prompt).toMatch(/Give "alt" only with a "no"/);
  });

  it('a reply keeps an alt only after a no, and only one the question listed', () => {
    const alts = new Map([
      ['q1', ['orifice', 'globe', 'other']],
      ['q2', ['P-150', 'break']],
      ['q3', ['orifice']],
      ['q4', ['orifice']],
    ]);
    const text = JSON.stringify({
      answers: [
        { id: 'q1', answer: 'no', alt: 'Orifice', reason: 'a flow element' },
        { id: 'q2', answer: 'no', alt: 'p 150', reason: 'into the pump' },
        { id: 'q3', answer: 'no', alt: 'a ball valve, I think', reason: 'x' },
        { id: 'q4', answer: 'yes', alt: 'orifice', reason: 'y' },
      ],
    });
    const { answers } = parseAnswers(text, ['q1', 'q2', 'q3', 'q4'], undefined, alts);
    expect(answers.get('q1')).toEqual({ verdict: 'no', alt: 'orifice', reason: 'a flow element' });
    expect(answers.get('q2')!.alt).toBe('P-150');
    expect(answers.get('q3')!.alt).toBeUndefined();
    expect(answers.get('q4')!.alt).toBeUndefined();
    expect(altOf('three way', ['three-way'])).toBe('three-way');
  });
});

describe('the Checks tab keeps the alternative, sealed', () => {
  it('a row with an alternative seals it; a row without one seals as before phase 6', () => {
    const q = questionOf([genericValve()], 'valve');
    const withAlt = row(q, 'no', 'orifice');
    expect(sealedRow(q.tableId, withAlt)).toBe(true);
    // Changing or dropping the alternative breaks the seal.
    expect(sealedRow(q.tableId, { ...withAlt, alt: 'globe' })).toBe(false);
    expect(sealedRow(q.tableId, { ...withAlt, alt: '' })).toBe(false);
    // An old row (no Alternative column at all) still verifies, and adding
    // one by hand breaks it.
    const old = row(q, 'no');
    const read = storedCheckOf(
      Object.fromEntries(
        Object.entries({
          Key: old.key,
          Kind: old.kind,
          Circuit: old.circuit,
          Question: old.question,
          Answer: old.answer,
          Reason: old.reason,
          Model: old.model,
          'Checked at': old.checkedAt,
          Revision: old.revision,
          Crops: old.crops,
          Seal: old.seal,
        }),
      ),
    );
    expect(read.alt).toBe('');
    expect(sealedRow(q.tableId, read)).toBe(true);
    expect(sealedRow(q.tableId, { ...read, alt: 'orifice' })).toBe(false);
  });
});

describe('the trace corrects from the image', () => {
  it('a valve the image says is an orifice is drawn as one, FROM IMAGE; the raw read stays', () => {
    const q = questionOf([genericValve()], 'valve');
    const s = [{ ...genericValve(), checks: [row(q, 'no', 'orifice')] }];
    const { r, applied } = traced(s);
    expect(applied[0]).toMatchObject({ kind: 'valve', answer: 'no', alt: 'orifice' });
    const page = overviewOf(r.pid) as {
      lines: { inline?: { type: string; check?: unknown }[]; note?: string }[];
    };
    const item = page.lines.flatMap((l) => l.inline ?? []).find((i) => i.check)!;
    expect(item.type).toBe('orifice');
    expect(item.check).toMatchObject({
      kind: 'valve',
      state: 'corrected',
      answer: 'no',
      alt: 'orifice',
      model: 'test/vision-model',
      crops: ['00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000c002'],
      overview: '00000000-0000-4000-8000-0000000000a1',
    });
    expect((item.check as { guess: string }).guess).toMatch(/gate valve/);
    expect(page.lines.map((l) => l.note)).toContain('VALVE TYPE (FROM IMAGE)');
    expect(JSON.stringify(r.pid)).toMatch(/FROM IMAGE: drawn as a vision model read the drawing/);
    // The raw geometry's read is kept on the trace's own chains.
    const valves = r.sheets.flatMap((x) =>
      x.runs.flatMap((run) => run.chains.flatMap((c) => c.valves)),
    );
    expect(valves.map((v) => v.type)).toContain('gate');
    expect(validate('pid', r.pid).ok).toBe(true);
  });

  it("a row's crop hashes ride into the mark, sealed with it (M3)", () => {
    const q = questionOf([genericValve()], 'valve');
    const [a, b] = ['a'.repeat(64), 'b'.repeat(64)];
    const C1 = '00000000-0000-4000-8000-00000000c001';
    const C2 = '00000000-0000-4000-8000-00000000c002';
    const cell = `overview 00000000-0000-4000-8000-0000000000a1 ${cropCellWords(C1, a)} ${cropCellWords(C2, b)}`;
    expect(cropIdsOf(cell)).toEqual({
      overview: '00000000-0000-4000-8000-0000000000a1',
      crops: [C1, C2],
      cropSha: [a, b],
    });
    // A crop without its hash (a row filed before them, or a cell edited
    // by hand): no hashes at all, so no crop of it is embedded.
    expect(cropIdsOf(`${C1} ${cropCellWords(C2, b)}`).cropSha).toBeUndefined();
    const { r } = traced([{ ...genericValve(), checks: [row(q, 'yes', '', cell)] }]);
    const page = overviewOf(r.pid) as {
      lines: { inline?: { check?: Record<string, unknown> }[] }[];
    };
    const mark = page.lines.flatMap((l) => l.inline ?? []).find((i) => i.check)!.check!;
    expect(mark).toMatchObject({ state: 'checked', crops: [C1, C2], cropSha: [a, b] });
    expect(validate('pid', r.pid).ok).toBe(true);
    // The hashes are part of the mark's seal (circuit_trace seals the
    // drawing): a changed one leaves the mark unchecked on save.
    const sheets = [{ ...genericValve(), checks: [row(q, 'yes', '', cell)] }];
    const raw = traceCircuit(CIRCUIT, sheets, undefined, {
      checks: (w, l) => appliedChecks(w, l, sheets, [], []),
    });
    const sealed = sealedPid(raw.pid as Record<string, unknown>, [], []);
    const stateOf = (pid: unknown) =>
      (overviewOf(pid) as typeof page).lines.flatMap((l) => l.inline ?? []).find((i) => i.check)!
        .check!.state;
    expect(stateOf(honestImageChecks(sealed, drawingSealHolds))).toBe('checked');
    const forged = JSON.parse(JSON.stringify(sealed).replace(a, 'c'.repeat(64)));
    expect(stateOf(honestImageChecks(forged, drawingSealHolds))).toBe('unchecked');
  });

  it('a no without a usable alternative stays a contradicted guess', () => {
    const q = questionOf([genericValve()], 'valve');
    for (const alt of ['', 'not-a-valve']) {
      const s = [{ ...genericValve(), checks: [row(q, 'no', alt)] }];
      const { r } = traced(s);
      const page = overviewOf(r.pid) as {
        lines: { inline?: { type: string; check?: { state: string } }[]; note?: string }[];
      };
      const item = page.lines.flatMap((l) => l.inline ?? []).find((i) => i.check)!;
      expect(item.type).toBe('gate');
      expect(item.check!.state).toBe('contradicted');
      expect(page.lines.map((l) => l.note)).toContain('VALVE TYPE (GUESS, IMAGE: NO)');
    }
  });

  it('a no on the main-line start re-picks the start from the other ends', () => {
    const base = traced(readingSheets()).r;
    expect(base.guesses.join(' ')).toMatch(/main line runs near E-101 \(GUESS\) to V-201/);
    const startEnd = questionOf(readingSheets(), 'end', 1);
    const sheets = readingSheets();
    sheets[0]!.checks = [row(startEnd, 'no', 'break')];
    const { r, applied } = traced(sheets);
    expect(applied).toEqual([expect.objectContaining({ kind: 'end', node: 1, alt: 'break' })]);
    // The main line now starts at the other end near E-101 (node 7), and the
    // contradicted end is drawn as the break the image saw.
    const said = r.guesses.join(' ');
    expect(said).toMatch(
      /end #1 is not at E-101, the image check says \(it stops at a break symbol/,
    );
    expect(said).toMatch(/main line runs near E-101 \(GUESS\) to V-201/);
    const overview = overviewOf(r.pid) as {
      offpage: { text?: string; check?: { state: string } }[];
    };
    const brk = overview.offpage.find((o) => o.text === 'BREAK (FROM IMAGE)');
    expect(brk?.check?.state).toBe('corrected');
    // The main line (L1) starts at a connector: before, the end #1 reading;
    // now the end #7 one.
    type Page = { lines: { from: string }[]; offpage: { id: string; check?: { guess: string } }[] };
    const startOf = (p: Page) => p.offpage.find((o) => o.id === p.lines[0]!.from)!.check!.guess;
    expect(startOf(overviewOf(base.pid) as unknown as Page)).toMatch(/end #1 /);
    expect(startOf(overview as unknown as Page)).toMatch(/end #7 /);
    expect(validate('pid', r.pid).ok).toBe(true);
  });

  it('a no that names other equipment makes the end a reading of THAT tag, FROM IMAGE', () => {
    const startEnd = questionOf(readingSheets(), 'end', 1);
    const sheets = readingSheets();
    sheets[0]!.checks = [row(startEnd, 'no', 'P-150')];
    const { r } = traced(sheets);
    expect(r.guesses.join(' ')).toMatch(/main line runs P-150 \(FROM IMAGE\) to V-201/);
    const overview = overviewOf(r.pid) as {
      offpage: { text?: string; check?: { state: string; alt: string } }[];
    };
    const at = overview.offpage.find((o) => o.text === 'AT P-150 (FROM IMAGE)');
    expect(at?.check).toMatchObject({ state: 'corrected', alt: 'P-150' });
    expect(validate('pid', r.pid).ok).toBe(true);
  });
});

describe("a word answer's connector names no sheet (fix round 2, M-b)", () => {
  it('break, open and continues: the sheet box says the word, never the tag the image said no to', () => {
    const startEnd = questionOf(readingSheets(), 'end', 1);
    for (const [alt, text, sheet] of [
      ['break', 'BREAK (FROM IMAGE)', 'BRK'],
      ['open', 'OPEN END (FROM IMAGE)', 'OPEN'],
      ['continues', 'CONTINUES (FROM IMAGE)', 'CONT'],
    ] as const) {
      const sheets = readingSheets();
      sheets[0]!.checks = [row(startEnd, 'no', alt)];
      const { r } = traced(sheets);
      const pages = (r.pid as { pages?: { data: unknown }[] }).pages?.map((p) => p.data) ?? [r.pid];
      const conns = pages.flatMap(
        (p) => (p as { offpage: { text?: string; sheet: string }[] }).offpage,
      );
      const it = conns.find((o) => o.text === text);
      expect(it, alt).toBeDefined();
      expect(it!.sheet, alt).toBe(sheet);
      expect(conns.filter((o) => o.text === text).every((o) => o.sheet !== 'E-101')).toBe(true);
      expect(validate('pid', r.pid).ok).toBe(true);
    }
  });
});

describe('the unchecked count', () => {
  it('counts each guess once across a set, by state, from the drawing marks', () => {
    const sheets = readingSheets();
    const { r } = traced(sheets);
    const before = imageCheckSummary(r.pid)!;
    expect(before.unchecked).toBe(before.guesses);
    expect(before.guesses).toBeGreaterThan(0);
    const startEnd = questionOf(readingSheets(), 'end', 1);
    sheets[0]!.checks = [row(startEnd, 'no', 'break')];
    const after = imageCheckSummary(traced(sheets).r.pid)!;
    expect(after.corrected).toBe(1);
    expect(after.unchecked).toBe(before.unchecked - 1);
  });
});

describe('a no on an end the register names (fix round M1)', () => {
  it('the register is kept: the end stays at its tag, the no is said and kept on the check', () => {
    const startEnd = questionOf(readingSheets(), 'end', 1);
    const sheets = readingSheets();
    sheets[0]!.checks = [row(startEnd, 'no', 'break')];
    const register = { from: 'E-101', to: 'V-201' };
    const { r, applied } = traced(sheets, register);
    // The answer is applied (it stays in the trace's checks and the tab).
    expect(applied).toEqual([expect.objectContaining({ kind: 'end', node: 1, answer: 'no' })]);
    const said = r.guesses.join(' ');
    expect(said).toMatch(
      /end #1 is drawn at E-101: .*register's from or to names it\. The image check said no to it \(it saw a break symbol\); the register is kept, the no stays on the check\./,
    );
    // Never re-picked away from the register, never "not at any end".
    expect(said).not.toMatch(/end #1 is not at E-101/);
    expect(r.limits.join(' ')).not.toMatch(/not at any end/);
    expect(r.limits.join(' ')).not.toMatch(/image removed/);
    expect(JSON.stringify(r.pid)).not.toContain('BREAK (FROM IMAGE)');
    // The same drawing as with the register and no answer at all.
    const plain = traced(readingSheets(), register).r;
    const strip = (o: unknown): unknown =>
      JSON.parse(
        JSON.stringify(o, (k, v: unknown) => (k === 'check' || k === 'checks' ? undefined : v)),
      );
    expect(strip(r.pid)).toEqual(strip(plain.pid));
    expect(validate('pid', r.pid).ok).toBe(true);
  });

  it('without a register tag the end is dropped, and limits say plainly the image removed it', () => {
    const startEnd = questionOf(readingSheets(), 'end', 1);
    for (const [alt, tail] of [
      ['', /the image removed that reading\.$/],
      [
        'break',
        /the image removed that reading, and the end is drawn as a break symbol \(FROM IMAGE\)\.$/,
      ],
      [
        'P-150',
        /the image removed that reading, and the end is read as at P-150 instead \(FROM IMAGE\)\.$/,
      ],
    ] as const) {
      const sheets = readingSheets();
      sheets[0]!.checks = [row(startEnd, 'no', alt)];
      const { r } = traced(sheets);
      const line = r.limits.find((l) => /end #1 was read as near E-101/.test(l));
      expect(line, alt).toMatch(
        /the image check said no, so the drawing no longer takes that end as at E-101/,
      );
      expect(line, alt).toMatch(tail);
      expect(r.limits.join(' ')).not.toMatch(/not at any end/);
    }
  });
});

describe('the alternatives a no may name (fix round L1, L2)', () => {
  it('a reserved word wins over a sheet named the same, in any case', () => {
    expect(altOf('NONE', ['none', 'other'])).toBe('none');
    expect(altOf('Not a valve', ['orifice', 'not-a-valve'])).toBe('not-a-valve');
    // A sheet titled "None" or "OTHER" is never offered as a name.
    const sheets = readingSheets();
    sheets[1]!.title = 'None';
    const r = traceCircuit(CIRCUIT, sheets);
    for (const q of questionsFor(r.sheets, r.links, sheets, { max: Infinity }).questions)
      expect(q.alts.filter((a) => a.toUpperCase() === 'NONE').length).toBeLessThanOrEqual(1);
  });

  it('a name matches exactly first; on letters and digits only when one name does', () => {
    const alts = ['E-101', 'E101', 'P-150', 'break'];
    expect(altOf('E101', alts)).toBe('E101');
    expect(altOf('e-101', alts)).toBe('E-101');
    // "E 101" reads as both: a tie names nothing.
    expect(altOf('E 101', alts)).toBeUndefined();
    expect(altOf('p 150', alts)).toBe('P-150');
    expect(altOf('Break', alts)).toBe('break');
  });

  it('a sheet title past ALT_MAX is never offered, so a stored one is always whole', () => {
    const sheets = readingSheets();
    const long = `PID-${'9'.repeat(ALT_MAX)}`;
    sheets.push({ ...sheets[1]!, tableId: 'table-long', title: long, checks: [] });
    const r = traceCircuit(CIRCUIT, sheets);
    for (const q of questionsFor(r.sheets, r.links, sheets, { max: Infinity }).questions) {
      expect(q.alts).not.toContain(long);
      for (const a of q.alts) expect(a.length).toBeLessThanOrEqual(ALT_MAX);
    }
  });

  it('equipment near an end at the same distance is listed by the tag itself', () => {
    const sheets = readingSheets();
    // Two more tags at the same distance from end #1, the later one first.
    sheets[0]!.texts.push(
      { text: 'P-201', layer: 'EQUIP', x: 0, y: 8 },
      { text: 'P-200', layer: 'EQUIP', x: 0, y: -8 },
    );
    const end = questionOf(sheets, 'end', 1);
    const i = end.alts.indexOf('P-200');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(end.alts.indexOf('P-201')).toBe(i + 1);
  });
});
