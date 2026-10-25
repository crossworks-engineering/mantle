/**
 * circuit_verify, the pure part: every guess the trace made becomes a
 * narrow question on a close-up crop of the drawing, keyed by DWG handles
 * and coordinates (./check-keys.ts), never by pixels; the questions are
 * batched into a few vision requests; the answers are parsed into
 * yes / no / unsure.
 *
 * The kinds of guess asked about:
 *  - `join`: two pieces of the circuit joined through a line on another
 *    layer (an inferred join): one pipe or two? A path question, crops
 *    along the join.
 *  - `end`: an end only near a piece of equipment (a tag past the near
 *    distance, drawn as a NEAR connector): does the pipe connect to it?
 *  - `link`: a guessed link between sheets: does the end say the pipe
 *    continues on that sheet?
 *  - `valve`: a valve whose type was read from its block name: is it
 *    that type?
 * Not asked here (they are not a spot on the drawing): a deadleg layer read
 * from its -Dnn suffix, and an equipment type read from its tag letter.
 *
 * The image is a CHECK, never proof: a yes makes a guess "checked by
 * image" (CHECKED BY IMAGE on the drawing), never certain; a no keeps it a
 * guess and says the image disagreed; anything unclear is unsure.
 *
 * No I/O: the tool (builtins-circuits.ts) reads, crops, asks and stores.
 */
import type { DwgCropItem, DwgCropSpec } from '@mantle/files';
import { DWG_CHECKS_TAB } from '@mantle/files/dwg';
import { endKey, joinKey, linkKey, valveKey } from './check-keys';
import type { ChainRole, PidChecks, Verdict } from './pid';
import type { SegRow, SheetInput, SheetLink, TraceSheet } from './walk';

export type { Verdict } from './pid';
export type CheckKind = 'join' | 'end' | 'link' | 'valve';
export const CHECK_KINDS: readonly CheckKind[] = ['join', 'end', 'link', 'valve'];

/** The trust label a check gives its guess (the Checks tab's Trust). */
export const TRUST: Readonly<Record<Verdict, string>> = {
  yes: 'CHECKED BY IMAGE',
  no: 'GUESS (IMAGE SAYS NO)',
  unsure: 'GUESS (IMAGE UNSURE)',
};

/** Hard caps per circuit_verify call (the schema holds max_questions too). */
export const VERIFY_MAX = {
  questions: 40,
  /** Images per vision request, the sheet overview included. */
  imagesPerRequest: 16,
  requests: 8,
  /** Crops over the whole call (the sidecar caps a sheet at 48). */
  crops: 80,
} as const;

/** The colours the sidecar draws the trace in (dwg_crop.COLORS), named in
 *  every prompt. */
export const COLOR_NOTE =
  'The traced circuit is drawn over each crop in colour: red is the main line, blue a branch, orange a deadleg. A green ring marks the spot a question asks about; on the sheet overview, green boxes show where the crops are.';

export type CheckQuestion = {
  /** q1, q2...: the crop item id and the answer id in the prompt. */
  id: string;
  /** The stable key the Checks tab files it under. */
  key: string;
  kind: CheckKind;
  tableId: string;
  sheet: string;
  sourceFileId: string | null;
  /** The trace's node at the spot (for people reading the Checks tab). */
  node: number | null;
  handles: string[];
  /** What the trace guessed, in words. */
  guess: string;
  question: string;
  item: DwgCropItem;
  /** Where the drawing shows the answer: the end's `<tableId>:<node>` for
   *  `end` and `link`, the join key for `join`. */
  pidKey: string;
};

type Pt = [number, number];
/** A crop item before its id (a union: each kind keeps its own fields). */
type ItemBody = DwgCropItem extends infer T ? (T extends unknown ? Omit<T, 'id'> : never) : never;
const pt = (x: number, y: number): Pt => [x, y];
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Segment rows by handle (a polyline has several parts). */
function byHandle(rows: readonly SegRow[]): Map<string, SegRow[]> {
  const m = new Map<string, SegRow[]>();
  for (const r of rows) {
    if (!r.handle) continue;
    const l = m.get(r.handle);
    if (l) l.push(r);
    else m.set(r.handle, [r]);
  }
  return m;
}

/** A path through `segs` from `start`, nearest piece next: the order the
 *  crops follow along a join. */
function chainPoints(start: Pt | null, segs: readonly SegRow[], end: Pt | null): Pt[] {
  const left = segs.filter((g) => [g.x1, g.y1, g.x2, g.y2].every(Number.isFinite));
  const out: Pt[] = start ? [start] : [];
  let at: Pt | null = start;
  while (left.length) {
    let best = 0;
    let flip = false;
    let bestD = Infinity;
    left.forEach((g, i) => {
      const d1 = at ? dist(at, pt(g.x1, g.y1)) : 0;
      const d2 = at ? dist(at, pt(g.x2, g.y2)) : 0;
      if (d1 < bestD) [bestD, best, flip] = [d1, i, false];
      if (d2 < bestD) [bestD, best, flip] = [d2, i, true];
    });
    const g = left.splice(best, 1)[0]!;
    const a = flip ? pt(g.x2, g.y2) : pt(g.x1, g.y1);
    const b = flip ? pt(g.x1, g.y1) : pt(g.x2, g.y2);
    out.push(a, b);
    at = b;
  }
  if (end) out.push(end);
  // Drop repeats so the sidecar's tiling walks real length.
  return out.filter((p, i) => i === 0 || dist(p, out[i - 1]!) > 1e-9);
}

const round = (v: number) => Math.round(v * 10) / 10;
const sayType = (t: string) => t.replace(/-/g, ' ');

/**
 * The questions for a trace's guesses, in a stable order (sheet, then
 * kind, then position), at most `max`; `left` counts the guesses past it.
 */
export function questionsFor(
  sheets: readonly TraceSheet[],
  links: readonly SheetLink[],
  inputs: readonly SheetInput[],
  opts: { kinds?: readonly CheckKind[]; max?: number } = {},
): { questions: CheckQuestion[]; left: number } {
  const kinds = new Set(opts.kinds?.length ? opts.kinds : CHECK_KINDS);
  // `max: Infinity` is every guess (circuit_trace matching stored checks);
  // asking is capped at VERIFY_MAX.questions.
  const max =
    opts.max === Infinity
      ? Infinity
      : Math.max(0, Math.min(opts.max ?? VERIFY_MAX.questions, VERIFY_MAX.questions));
  const inputOf = new Map(inputs.map((s) => [s.tableId, s]));
  const all: Omit<CheckQuestion, 'id' | 'item'>[] = [];
  const items = new Map<string, ItemBody>();
  const seen = new Set<string>();
  const add = (q: Omit<CheckQuestion, 'id' | 'item'>, item: ItemBody) => {
    // Keys are a drawing's own (handles repeat across drawings).
    const k = `${q.tableId}|${q.key}`;
    if (seen.has(k)) return;
    seen.add(k);
    all.push(q);
    items.set(k, item);
  };

  for (const s of sheets) {
    const input = inputOf.get(s.tableId);
    if (!input) continue;
    const near = input.near > 0 ? input.near : 1;
    const nodeAt = new Map(input.nodes.map((n) => [n.id, pt(n.x, n.y)]));
    const net = byHandle([...input.segments, ...(input.network ?? [])]);
    const base = { tableId: s.tableId, sheet: s.title, sourceFileId: s.sourceFileId };
    /** The end of a run as its chain meets it: the segment handle there. */
    const endHandle = (node: number) => {
      for (const run of s.runs)
        for (const c of run.chains) {
          if (c.from === node) return c.handles[0] ?? '';
          if (c.to === node) return c.handles[c.handles.length - 1] ?? '';
        }
      return '';
    };

    if (kinds.has('join')) {
      for (const j of s.joins) {
        if (!j.inferred || !j.handles.length) continue;
        const a = nodeAt.get(j.from) ?? null;
        const b = nodeAt.get(j.to) ?? null;
        const segs = j.handles.flatMap((h) => net.get(h) ?? []);
        const points = chainPoints(a, segs, b);
        if (!points.length) continue;
        const marks = [a, b].filter((p): p is Pt => p !== null);
        add(
          {
            ...base,
            key: joinKey(j.handles),
            kind: 'join',
            node: j.from,
            handles: [...j.handles],
            guess: `pieces #${j.from} and #${j.to} of the circuit are one pipe, joined through ${round(j.length)} drawing units on layer ${j.layers.join(', ') || '(unnamed)'}`,
            question: `The trace joined two pieces of the circuit through a line drawn on another layer: the coloured path between the green rings. Is that one continuous pipe from one ring to the other (yes), or two separate pipes, a line that only crosses, or a gap (no)?`,
            pidKey: `${s.tableId}:${joinKey(j.handles)}`,
          },
          { kind: 'path', points, pad: 2 * near, marks },
        );
      }
    }
    for (const run of s.runs) {
      for (const e of run.ends) {
        const handle = endHandle(e.node);
        const at = pt(e.x, e.y);
        if (kinds.has('end') && e.equipmentUnconfirmed) {
          const far = e.reading?.distance ?? 0;
          const pad = Math.min(Math.max(4 * near, far * 1.25), 15 * near);
          add(
            {
              ...base,
              key: endKey(handle, e.x, e.y),
              kind: 'end',
              node: e.node,
              handles: handle ? [handle] : [],
              guess: `the pipe end #${e.node} belongs to ${e.equipmentUnconfirmed} (the nearest equipment tag, ${round(far)} drawing units off)`,
              question: `The trace guessed that the pipe end in the green ring belongs to the equipment tagged ${e.equipmentUnconfirmed}. Does the pipe end connect to that equipment (into its outline or a nozzle of it)? Yes, no (it ends somewhere else, or at other equipment), or unsure.`,
              pidKey: `${s.tableId}:${e.node}`,
            },
            { kind: 'point', at, pad, marks: [at] },
          );
        }
      }
    }
    if (kinds.has('link')) {
      for (const l of links) {
        if (!l.guessed || l.from.sheet !== s.title) continue;
        const other = l.to?.sheet ?? l.target;
        if (!other) continue;
        const end = s.runs.flatMap((r) => r.ends).find((x) => x.node === l.from.node);
        if (!end) continue;
        const handle = endHandle(end.node);
        const at = pt(end.x, end.y);
        add(
          {
            ...base,
            key: linkKey(handle, end.x, end.y),
            kind: 'link',
            node: end.node,
            handles: handle ? [handle] : [],
            guess: `the pipe at end #${end.node} continues on ${other} (${l.note})`,
            question: `The trace guessed that the pipe at the green ring continues on another drawing, ${other}. Does a label, arrow or off-page connector at that end say it continues on ${other}? Yes, no (it names another drawing, or nothing), or unsure.`,
            pidKey: `${s.tableId}:${end.node}`,
          },
          { kind: 'point', at, pad: 6 * near, marks: [at] },
        );
      }
    }
    if (kinds.has('valve')) {
      const insertOf = new Map(input.inserts.map((i) => [i.handle, i]));
      for (const run of s.runs)
        for (const c of run.chains)
          for (const v of c.valves) {
            if (!v.guessed || !v.handle || v.block === '(drawn as lines)') continue;
            const ins = insertOf.get(v.handle);
            if (!ins || !Number.isFinite(ins.x) || !Number.isFinite(ins.y)) continue;
            const half =
              ins.minX !== null && ins.maxX !== null && ins.minY !== null && ins.maxY !== null
                ? Math.hypot(ins.maxX - ins.minX, ins.maxY - ins.minY) / 2
                : 0;
            const cx = ins.minX !== null && ins.maxX !== null ? (ins.minX + ins.maxX) / 2 : ins.x;
            const cy = ins.minY !== null && ins.maxY !== null ? (ins.minY + ins.maxY) / 2 : ins.y;
            const at = pt(cx, cy);
            add(
              {
                ...base,
                key: valveKey(v.handle),
                kind: 'valve',
                node: null,
                handles: [v.handle],
                guess: `block ${v.block} is a ${sayType(v.type)} valve (read from its name)`,
                question: `The trace read the symbol in the green ring as a ${sayType(v.type)} valve from its block name. Is it drawn as a ${sayType(v.type)} valve? Yes, no (another valve or not a valve), or unsure.`,
                pidKey: valveKey(v.handle),
              },
              { kind: 'point', at, pad: Math.max(half * 1.6, 3 * near), marks: [at] },
            );
          }
    }
  }
  const order = (k: CheckKind) => CHECK_KINDS.indexOf(k);
  const sheetOrder = new Map(sheets.map((s, i) => [s.tableId, i]));
  all.sort(
    (a, b) =>
      sheetOrder.get(a.tableId)! - sheetOrder.get(b.tableId)! ||
      order(a.kind) - order(b.kind) ||
      a.key.localeCompare(b.key),
  );
  const kept = all.slice(0, max);
  return {
    questions: kept.map((q, i) => {
      const id = `q${i + 1}`;
      return { ...q, id, item: { ...items.get(`${q.tableId}|${q.key}`)!, id } as DwgCropItem };
    }),
    left: all.length - kept.length,
  };
}

/** The crop spec of one sheet: its questions' items and the trace drawn
 *  over it, each chain in its role's colour (joins in their chain's). */
export function cropSpecFor(
  sheet: TraceSheet,
  input: SheetInput,
  questions: readonly CheckQuestion[],
  roles: ReadonlyMap<string, ChainRole>,
): DwgCropSpec {
  const net = byHandle([...input.segments, ...(input.network ?? [])]);
  const groups: Record<ChainRole, [number, number, number, number][]> = {
    main: [],
    branch: [],
    deadleg: [],
  };
  const color = (role: ChainRole) => role;
  for (const run of sheet.runs)
    for (const c of run.chains) {
      const role: ChainRole =
        roles.get(`${sheet.tableId}:${c.id}`) ?? (c.role === 'deadleg' ? 'deadleg' : 'branch');
      const handles = [...c.handles, ...(c.joins ?? []).flatMap((j) => j.handles)];
      for (const h of new Set(handles))
        for (const g of net.get(h) ?? []) groups[role].push([g.x1, g.y1, g.x2, g.y2]);
    }
  return {
    items: questions.map((q) => q.item),
    overlay: (Object.keys(groups) as ChainRole[])
      .filter((r) => groups[r].length)
      .map((r) => ({ color: color(r), segs: groups[r] })),
    overview: true,
  };
}

/** One vision request: a sheet's overview, then its questions' crops. */
export type CheckBatch = {
  tableId: string;
  questions: { q: CheckQuestion; crops: number[] }[];
  /** Crop indexes into the sheet's crop list, in image order. */
  images: number;
};

/**
 * Questions of one sheet grouped into requests of at most
 * `imagesPerRequest` images, the overview counted once per request; a
 * question's crops are never split. `crops[i]` is how many crops question
 * i has (a question with none is left out).
 */
export function batchesFor(
  tableId: string,
  questions: readonly CheckQuestion[],
  cropCount: (q: CheckQuestion) => number,
  imagesPerRequest: number = VERIFY_MAX.imagesPerRequest,
): CheckBatch[] {
  const out: CheckBatch[] = [];
  let cur: CheckBatch | null = null;
  let index = 0;
  for (const q of questions) {
    const n = cropCount(q);
    if (n <= 0) continue;
    // A question with more crops than a request holds takes a request alone.
    if (!cur || cur.images + n > imagesPerRequest) {
      cur = { tableId, questions: [], images: 1 };
      out.push(cur);
    }
    cur.questions.push({ q, crops: Array.from({ length: n }, (_, k) => index + k) });
    cur.images += n;
    index += n;
  }
  return out;
}

/** The prompt of one request: what to do, the colours, each question with
 *  the images it is about (image 1 is the sheet overview), the reply shape. */
export function promptFor(batch: CheckBatch, overview = true): string {
  let image = overview ? 2 : 1;
  const lines = batch.questions.map(({ q, crops }) => {
    const from = image;
    image += crops.length;
    const which =
      crops.length === 1 ? `image ${from}` : `images ${from} to ${from + crops.length - 1}`;
    return `${q.id} (${which}): ${q.question}`;
  });
  return [
    `You check guesses a program made when it traced a piping circuit on an engineering drawing (a P&ID). Each question below is about one or more close-up crops of the drawing${overview ? '; image 1 is an overview of the whole sheet' : ''}.`,
    COLOR_NOTE,
    'Answer only from what the images show; do not guess. Answer "unsure" when the images do not show enough to tell.',
    'Reply with JSON only, no other text: {"answers":[{"id":"q1","answer":"yes","reason":"..."}]}, one entry per question, answer one of "yes", "no", "unsure", reason at most 25 words naming what you saw.',
    '',
    'Questions:',
    ...lines,
  ].join('\n');
}

export type ParsedAnswer = { verdict: Verdict; reason: string };

/** The answers in a model's reply, per question id. Anything that does not
 *  parse, an id it did not answer, or an answer that is not yes/no is
 *  unsure, with the reason saying so. */
export function parseAnswers(text: string, ids: readonly string[]): Map<string, ParsedAnswer> {
  const out = new Map<string, ParsedAnswer>();
  let list: unknown[] = [];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const body = JSON.parse(text.slice(start, end + 1)) as { answers?: unknown };
      if (Array.isArray(body.answers)) list = body.answers;
    } catch {
      list = [];
    }
  }
  for (const a of list) {
    if (!a || typeof a !== 'object') continue;
    const o = a as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    if (!ids.includes(id) || out.has(id)) continue;
    const said = typeof o.answer === 'string' ? o.answer.trim().toLowerCase() : '';
    const verdict: Verdict = said === 'yes' || said === 'no' ? said : 'unsure';
    const reason = (typeof o.reason === 'string' ? o.reason : '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .trim()
      .slice(0, 300);
    out.set(id, {
      verdict,
      reason:
        verdict === 'unsure' && said !== 'unsure'
          ? `the answer was not yes, no or unsure (${said.slice(0, 20) || 'empty'})${reason ? `: ${reason}` : ''}`
          : reason,
    });
  }
  for (const id of ids)
    if (!out.has(id))
      out.set(id, {
        verdict: 'unsure',
        reason: list.length
          ? 'the reply gave no answer to this question'
          : 'the reply did not parse',
      });
  return out;
}

/** The Checks tab a DWG's table gains: one row per answer, the evidence
 *  kept (question, crops, answer, model) so a miss can be traced later. */
export const CHECKS_TAB = DWG_CHECKS_TAB;
export const CHECK_COLUMNS = [
  'Key',
  'Kind',
  'Circuit',
  'Node',
  'Handles',
  'Guess',
  'Question',
  'Answer',
  'Reason',
  'Trust',
  'Model',
  'Checked at',
  'Revision',
  'File',
  'Crops',
] as const;
export type CheckColumn = (typeof CHECK_COLUMNS)[number];

/** A stored check as the Checks tab holds it (one row per answer). */
export type StoredCheck = {
  key: string;
  kind: string;
  answer: string;
  revision: string;
  checkedAt: string;
  model: string;
  reason: string;
  question: string;
  trust: string;
};

/**
 * The answers that apply to this trace: per question key, the latest
 * check of the drawing's current revision. Older revisions' checks are
 * kept in the tab but never applied (`stale` counts them).
 */
export function latestChecks(
  rows: readonly StoredCheck[],
  revision: string | null,
): { byKey: Map<string, StoredCheck>; stale: number } {
  const byKey = new Map<string, StoredCheck>();
  let stale = 0;
  for (const r of rows) {
    if (!revision || r.revision !== revision) {
      stale += 1;
      continue;
    }
    const had = byKey.get(r.key);
    if (!had || had.checkedAt < r.checkedAt) byKey.set(r.key, r);
  }
  return { byKey, stale };
}

const verdictOf = (a: string): Verdict => (a === 'yes' || a === 'no' ? a : 'unsure');

/** A stored check that applies to this trace's guess. */
export type AppliedCheck = {
  sheet: string;
  kind: CheckKind;
  node: number | null;
  guess: string;
  trust: string;
  answer: Verdict;
  reason: string;
  model: string;
  checkedAt: string;
};

/**
 * The stored checks that apply to a trace (circuit_trace): every guess's
 * question, matched by key to the latest check of its sheet's current
 * revision. Fills `applied` and `limits` (checks of an older revision are
 * kept in the tab, never applied) and returns the drawing's marks.
 */
export function appliedChecks(
  sheets: readonly TraceSheet[],
  links: readonly SheetLink[],
  inputs: readonly SheetInput[],
  applied: AppliedCheck[],
  limits: string[],
): PidChecks | undefined {
  const withChecks = inputs.filter((s) => s.checks?.length);
  if (!withChecks.length) return undefined;
  const latest = new Map<string, Map<string, StoredCheck>>();
  for (const s of withChecks) {
    const { byKey, stale } = latestChecks(s.checks!, s.revision ?? null);
    latest.set(s.tableId, byKey);
    if (stale)
      limits.push(
        `${s.title}: ${stale} image check${stale === 1 ? '' : 's'} of ${s.revision ? 'an older revision of the drawing are' : 'a drawing whose revision could not be read are'} kept in its Checks tab but not applied.`,
      );
  }
  const { questions } = questionsFor(sheets, links, inputs, { max: Infinity });
  const near = new Map<string, Verdict>();
  const link = new Map<string, Verdict>();
  const joins = new Map<string, Verdict>();
  for (const q of questions) {
    const c = latest.get(q.tableId)?.get(q.key);
    if (!c) continue;
    const v = verdictOf(c.answer);
    if (q.kind === 'end') near.set(q.pidKey, v);
    else if (q.kind === 'link') link.set(q.pidKey, v);
    else if (q.kind === 'join') joins.set(q.pidKey, v);
    applied.push({
      sheet: q.sheet,
      kind: q.kind,
      node: q.node,
      guess: q.guess,
      trust: TRUST[v],
      answer: v,
      reason: c.reason,
      model: c.model,
      checkedAt: c.checkedAt,
    });
  }
  return { near, link, joins };
}
