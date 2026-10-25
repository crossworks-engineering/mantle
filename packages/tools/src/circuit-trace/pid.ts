/**
 * circuit_trace, the drawing: the traced circuit as `pid` template input,
 * a linked drawing set (or one drawing, when one page holds it all).
 *
 * Every sheet's chains go into one graph: an end two sheets link is one
 * point there, and every end at a piece of equipment is that equipment. The
 * main line is the path along the real flow from the upstream equipment to
 * the downstream one (the register's from and to when it names them, else
 * the pair whose path crosses the most sheets), never through a deadleg
 * chain (when the only path does, no main line is drawn and that is said in
 * `limits`; the deadleg stays a deadleg); then the branches hang off it on
 * tees, then lines from the equipment on it, and the deadlegs last.
 *
 * Page 1, the overview, draws the main line and as many lines after it as
 * fit the line budget (`PID_LINES`); a line's deadlegs all go on it or none
 * do, and a "+N" marker links to the page that holds what it leaves out.
 * Then a page per sheet holds that sheet's lines; a sheet over the budget
 * is split (pages.ts), never cut. The set holds `SET_LIMITS.pages` pages:
 * past that, every page keeps within the template's hard limits and the
 * chains on no page are counted in `limits`, per sheet. A circuit that fits
 * one page is one plain drawing, not a set.
 *
 * Pure: it reads the walk's output and writes the template's input.
 */
import type { SheetLink, TraceChain, TraceEnd, TraceSheet, TraceValve } from './walk';
import { clipText, PID_LIMITS, SET_LIMITS } from '@mantle/diagram-templates';
import { splitPages, type SplitPage } from './pages';

/** Lines drawn: the guide's budget is 12 labelled process lines; a traced
 *  circuit gets 20 so a few deadlegs fit beside the main run and branches. */
export const PID_LINES = 20;
const CIRCUIT_ID = 24;
/** The template's text limits, in characters. */
const TEXT = PID_LIMITS.text;
/** A page's name in the set: its sheet's name, kept short. */
const clipTitle = (t: string) => clipText(t, SET_LIMITS.pageTitle);

const norm = (t: string) => t.toUpperCase().replace(/[\s"'`]+/g, '');
/** Register text echoed into limits and guesses is cut to this length. */
const ECHO_MAX = 40;
export const clip = (t: string) => clipText(t, ECHO_MAX);
/** The legend's names for the line weights: the main line, and every other
 *  line of the circuit (a branch or a deadleg of a process circuit is a
 *  process line, never a utility line). */
export const LEGEND_NAMES = { main: 'Main process line', secondary: 'Process branch or deadleg' };

export function tagId(raw: string, fallback: string, max = 32): string {
  const t = raw
    .replace(/[^A-Za-z0-9_./-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, max);
  return t || fallback;
}

/** The tag without its revision suffix (E-101/R1 -> E-101). */
const baseTag = (tag: string) => tag.toUpperCase().replace(/\s*\/.*$/, '');

type Pt = { x: number; y: number };
/** A turn under this many degrees at a tee is straight on. */
const STRAIGHT_DEG = 20;

type Edge = {
  a: string;
  b: string;
  sheet: TraceSheet;
  chain: TraceChain;
  length: number;
  deadleg: boolean;
};

type Plan = {
  id: string;
  edges: Edge[];
  verts: string[];
  /** Where it starts: equipment, a tee on a parent line, or an end. */
  parent?: { line: string; at: number };
  depth: number;
  deadleg: boolean;
  length: number;
};

export type PidInput = {
  circuit: string;
  sheets: TraceSheet[];
  links: SheetLink[];
  equipmentType: (tag: string) => string;
  /** Per `<tableId>:<chain id>`: the unit direction leaving the chain's
   *  `from` node into it, and leaving its `to` node into it. */
  dirs?: Map<string, { from: Pt; to: Pt }>;
  register?: { from?: string; to?: string; sheets?: string[] };
};

export function buildPid(
  input: PidInput,
  guesses: string[],
  limits: string[],
): Record<string, unknown> {
  const { circuit, sheets, links } = input;

  // ------------------------------------------------------------- the graph
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    if (r !== k) parent.set(k, r);
    return r;
  };
  const join = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    // Equipment stays the root, so the vertex keeps its name.
    if (ra === rb) return;
    if (rb.startsWith('EQ:')) parent.set(ra, rb);
    else parent.set(rb, ra);
  };
  const keyOf = (sheet: TraceSheet, node: number) => `${sheet.tableId}:${node}`;
  const sheetByTitle = new Map(sheets.map((s) => [s.title, s]));
  const endAt = new Map<string, { sheet: TraceSheet; end: TraceEnd }[]>();
  // An unconfirmed tag (a reading past the near distance) is equipment only
  // when the register's from or to names it; else its end is a marked guess.
  const registerTags = [input.register?.from, input.register?.to]
    .filter((t): t is string => !!t?.trim())
    .map((t) => baseTag(t.trim()));
  const unconfirmed = new Map<string, string>();
  for (const s of sheets) {
    for (const run of s.runs) {
      for (const end of run.ends) {
        const k = keyOf(s, end.node);
        const list = endAt.get(k);
        if (list) list.push({ sheet: s, end });
        else endAt.set(k, [{ sheet: s, end }]);
        if (end.equipment.length) join(k, `EQ:${end.equipment[0]!}`);
        else if (end.equipmentUnconfirmed) {
          if (registerTags.includes(baseTag(end.equipmentUnconfirmed))) {
            join(k, `EQ:${end.equipmentUnconfirmed}`);
            guesses.push(
              `${s.title}: end #${end.node} is drawn at ${end.equipmentUnconfirmed}: the tag is past the near distance, and the register's from or to names it.`,
            );
          } else unconfirmed.set(k, end.equipmentUnconfirmed);
        }
      }
    }
  }
  // A certain link makes its two ends one point; a guessed one stays two
  // ends, each drawn as a connector marked GUESS.
  const linkAt = new Map<string, { other: string; guessed: boolean }>();
  for (const l of links) {
    const a = sheetByTitle.get(l.from.sheet);
    if (!a) continue;
    const b = l.to ? sheetByTitle.get(l.to.sheet) : undefined;
    if (b && l.to && !l.guessed) {
      join(keyOf(a, l.from.node), keyOf(b, l.to.node));
      continue;
    }
    const other = l.to?.sheet ?? l.target;
    if (!other) continue;
    linkAt.set(keyOf(a, l.from.node), { other, guessed: true });
    if (b && l.to) linkAt.set(keyOf(b, l.to.node), { other: l.from.sheet, guessed: true });
  }
  const edges: Edge[] = [];
  for (const s of sheets) {
    for (const run of s.runs) {
      for (const c of run.chains) {
        edges.push({
          a: find(keyOf(s, c.from)),
          b: find(keyOf(s, c.to)),
          sheet: s,
          chain: c,
          length: c.length,
          deadleg: c.role === 'deadleg',
        });
      }
    }
  }
  const adj = new Map<string, Edge[]>();
  const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  for (const e of edges) {
    push(adj, e.a, e);
    if (e.b !== e.a) push(adj, e.b, e);
  }
  const far = (e: Edge, v: string) => (e.a === v ? e.b : e.a);
  const isEq = (v: string) => v.startsWith('EQ:');
  const eqTag = (v: string) => v.slice(3);

  // ------------------------------------------------------------ main path
  /** The cheapest path between two vertices that passes no other equipment
   *  and, unless `deadlegs`, no deadleg chain (a main line never runs
   *  through one). */
  const path = (from: string, to: string, deadlegs = false): Edge[] | null => {
    const cost = new Map<string, number>([[from, 0]]);
    const via = new Map<string, Edge>();
    const open = new Set([from]);
    while (open.size) {
      let v = '';
      let best = Infinity;
      for (const o of open) {
        const c = cost.get(o)!;
        if (c < best) {
          best = c;
          v = o;
        }
      }
      open.delete(v);
      if (v === to) break;
      if (v !== from && isEq(v)) continue;
      for (const e of adj.get(v) ?? []) {
        if (e.deadleg && !deadlegs) continue;
        const w = far(e, v);
        const nc = best + e.length + 1e-6;
        if (nc < (cost.get(w) ?? Infinity)) {
          cost.set(w, nc);
          via.set(w, e);
          open.add(w);
        }
      }
    }
    if (!via.has(to)) return null;
    const out: Edge[] = [];
    for (let v = to; v !== from;) {
      const e = via.get(v)!;
      out.unshift(e);
      v = far(e, v);
    }
    return out;
  };
  /** The unit direction leaving vertex `v` into edge `e` on its sheet. */
  const dirAt = (e: Edge, v: string): Pt | null => {
    const d = input.dirs?.get(`${e.sheet.tableId}:${e.chain.id}`);
    if (!d) return null;
    if (e.a === v && e.b !== v) return d.from;
    if (e.b === v && e.a !== v) return d.to;
    return null;
  };
  /** How many times a path turns off straight at a vertex on one sheet (a
   *  header runs straight on through its tees; a branch turns off it). */
  const turnsOf = (start: string, p: Edge[]) => {
    let turns = 0;
    let v = start;
    for (let i = 0; i < p.length - 1; i++) {
      const e = p[i]!;
      const next = p[i + 1]!;
      v = far(e, v);
      if (e.sheet !== next.sheet || (adj.get(v)?.length ?? 0) < 3) continue;
      const back = dirAt(e, v);
      const out = dirAt(next, v);
      if (!back || !out) continue;
      const dot = -back.x * out.x + -back.y * out.y;
      const deg = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
      if (deg >= STRAIGHT_DEG) turns += 1;
    }
    return turns;
  };
  const eqs = [...new Set(edges.flatMap((e) => [e.a, e.b]).filter(isEq))];
  /** Main-layer ends that are only NEAR an equipment tag (a reading past the
   *  near distance): a main-line end only as a marked guess, and only when
   *  it carries the main line across more sheets (two at least) than
   *  confirmed equipment alone does. */
  const readingAt = new Map<string, string>();
  /** How each reading was taken (walk.ts): its distance ranks readings. */
  const readingOf = new Map<string, NonNullable<TraceEnd['reading']>>();
  for (const [k, tag] of unconfirmed) {
    const v = find(k);
    if (isEq(v) || !adj.has(v)) continue;
    const at = endAt.get(k) ?? [];
    if (at.every(({ end }) => end.deadleg)) continue;
    readingAt.set(v, tag);
    const by = at.find(({ end }) => end.reading)?.end.reading;
    if (by) readingOf.set(v, by);
  }
  /** A reading in words: how far its tag is, or the outline it sits on. */
  const readingWords = (v: string): string => {
    const r = readingOf.get(v);
    const tag = readingAt.get(v);
    if (r?.kind === 'outline') {
      const more = r.count > r.tags.length ? ', ...' : '';
      return r.count > 1
        ? `only on an outline too wide to be one piece of equipment that holds ${r.count} equipment tags (${r.tags.join(', ')}${more}), ${tag} nearest, ${r.distance} drawing units off`
        : `only on an outline too wide to be one piece of equipment that holds ${tag}`;
    }
    return r
      ? `only near ${tag}, ${r.distance} drawing units off, past the ${r.near} near distance`
      : `only near ${tag}, past the near distance`;
  };
  /** A vertex's name in the words the trace writes. */
  const vname = (v: string) =>
    isEq(v) ? eqTag(v) : readingAt.has(v) ? `near ${readingAt.get(v)} (GUESS)` : v;
  const matchEq = (name?: string) => {
    if (!name?.trim()) return undefined;
    const n = baseTag(name.trim());
    return (
      eqs.find((v) => baseTag(eqTag(v)) === n) ?? eqs.find((v) => norm(eqTag(v)) === norm(name))
    );
  };
  const regFrom = matchEq(input.register?.from);
  const regTo = matchEq(input.register?.to);
  for (const [side, name, hit] of [
    ['from', input.register?.from, regFrom],
    ['to', input.register?.to, regTo],
  ] as const) {
    if (name?.trim() && !hit) {
      limits.push(
        `the register's circuit ${side} ${clip(name.trim())} is not at any end of the traced geometry; the main line is read from the drawing alone.`,
      );
    }
  }
  const sheetRank = (s: TraceSheet) => {
    const order = input.register?.sheets ?? [];
    const i = order.findIndex(
      (o) => norm(s.title).startsWith(norm(o)) || norm(o).startsWith(norm(s.title)),
    );
    return i >= 0 ? i : order.length + sheets.indexOf(s);
  };
  type Main = { from: string; to: string; edges: Edge[]; score: number[]; tie: boolean };
  let main: Main | null = null;
  /** A pair joined only through a deadleg chain (no main line there). */
  let blocked: { a: string; b: string } | null = null;
  const consider = (a: string, b: string, readingD?: number) => {
    const p = path(a, b);
    if (!p?.length) {
      // Kept to say why there is no main line: a path only through a deadleg.
      if (!blocked && isEq(a) && isEq(b) && path(a, b, true)?.length) blocked = { a, b };
      return;
    }
    // A main run crosses each sheet once: a path that leaves a sheet and
    // comes back to it is a loop through other lines, not the run.
    const order = p.map((e) => e.sheet.tableId).filter((t, i, a) => i === 0 || a[i - 1] !== t);
    const score = [
      Number(new Set(order).size === order.length),
      new Set(order).size,
      -turnsOf(a, p),
      // Between readings the closer tag ranks first, before length.
      ...(readingD === undefined ? [] : [-readingD]),
      p.reduce((x, e) => x + e.length, 0),
    ];
    const cur = main as Main | null;
    if (!cur || lexGreater(score, cur.score))
      main = { from: a, to: b, edges: p, score, tie: false };
    else if (!lexGreater(cur.score, score)) cur.tie = true;
  };
  /** The sheets a main line crosses, each once (0 when it crosses one twice). */
  const sheetsOf = (x: Main | null) => (x && x.score[0] === 1 ? x.score[1]! : 0);
  let mainBasis: string;
  /** What the confirmed pairs reach, said when a reading takes the main
   *  line: the sheets the best of them crosses (each once), 0 when it
   *  crosses one twice, null when no confirmed pair is joined at all. */
  let confirmedReach: number | null = null;
  let pinnedEq: string | undefined;
  if (regFrom && regTo && regFrom !== regTo) {
    consider(regFrom, regTo);
    mainBasis = `the register's circuit from ${clip(input.register!.from!.trim())} and to ${clip(input.register!.to!.trim())}`;
    if (!main) {
      limits.push(
        `the register's circuit from ${clip(input.register!.from!.trim())} and to ${clip(input.register!.to!.trim())} are both at ends of the traced geometry, but no path that keeps off deadlegs joins them (${blocked ? 'the only path runs through a deadleg chain, and a main line never does: the deadleg is drawn as a deadleg' : 'an unjoined piece, or other equipment between'}); no main line is drawn.`,
      );
    }
  } else {
    const pinned = regFrom ?? regTo;
    pinnedEq = pinned;
    for (let i = 0; i < eqs.length; i++) {
      for (let k = i + 1; k < eqs.length; k++) {
        if (pinned && eqs[i] !== pinned && eqs[k] !== pinned) continue;
        consider(eqs[i]!, eqs[k]!);
      }
    }
    // One end a reading, the other confirmed equipment (never two readings):
    // taken only when it crosses more sheets, each once, than the confirmed
    // pairs do, and at least two (on one sheet a reading is never a main end).
    const confirmed = main as Main | null;
    main = null;
    for (const v of eqs) {
      if (pinned && v !== pinned) continue;
      for (const r of readingAt.keys()) consider(v, r, readingOf.get(r)?.distance ?? Infinity);
    }
    const reading = main as Main | null;
    confirmedReach = confirmed ? sheetsOf(confirmed) : null;
    // A tie between two readings is kept: the sentence says so.
    main =
      reading && sheetsOf(reading) >= 2 && sheetsOf(reading) > sheetsOf(confirmed)
        ? reading
        : confirmed;
    mainBasis = '';
  }
  const m = main as Main | null;
  const cut = blocked as { a: string; b: string } | null;
  if (!m && cut && !(regFrom && regTo && regFrom !== regTo)) {
    limits.push(
      `${vname(cut.a)} and ${vname(cut.b)} are joined only through a deadleg chain; a main line never runs through a deadleg, so no main line is drawn and the deadleg is drawn as a deadleg.`,
    );
  }
  /** Inferred joins on the main line's chains. */
  const mainInferred = m
    ? m.edges.reduce((x, e) => x + (e.chain.joins ?? []).filter((j) => j.inferred).length, 0)
    : 0;
  if (m && !(regFrom && regTo)) {
    // Which end is upstream: the register's, else the one on the sheet the
    // register (or the upload order) lists first.
    const first = (v: string) =>
      Math.min(...(adj.get(v) ?? []).map((e) => sheetRank(e.sheet)), Infinity);
    const flip =
      (regTo && m.from === regTo) ||
      (regFrom && m.to === regFrom) ||
      (!regFrom && !regTo && first(m.to) < first(m.from));
    if (flip) {
      m.edges.reverse();
      [m.from, m.to] = [m.to, m.from];
    }
    mainBasis =
      regFrom || regTo ? `the register's circuit ${regFrom ? 'from' : 'to'} and the drawing` : '';
    guesses.push(
      `the main line runs ${vname(m.from)} to ${vname(m.to)}: the pair of equipment ends whose path crosses the most sheets, each once, never through a deadleg${mainInferred ? ` (${mainInferred} inferred join${mainInferred === 1 ? '' : 's'} through process lines on it)` : ''}, and goes straightest through its tees${regFrom || regTo ? `, one end fixed by the register` : ''}${m.tie ? `; another pair scores the same (a tie, broken by the order the equipment was found)` : ''}; its direction is read from the ${input.register?.sheets?.length ? "register's sheet order" : 'upload order of the sheets'}, not from flow arrows${[
        m.from,
        m.to,
      ]
        .filter((v) => !isEq(v))
        .map(
          (v) =>
            `; its ${v === m.from ? 'from' : 'to'} end is ${readingWords(v)} (a reading, drawn as a NEAR connector marked GUESS, never as the equipment), taken because it carries the main line across ${sheetsOf(m)} sheets, each once, while ${confirmedReach === null ? (pinnedEq ? `no path that keeps off deadlegs joins ${vname(pinnedEq)} to other confirmed equipment` : 'no path that keeps off deadlegs joins two pieces of confirmed equipment') : confirmedReach === 0 ? 'the best path between confirmed equipment crosses a sheet twice' : `the best path between confirmed equipment crosses ${confirmedReach} sheet${confirmedReach === 1 ? '' : 's'}`}${readingAt.size > 1 ? '; between readings the one whose tag is closer to its end ranks first, before length' : ''}`,
        )
        .join('')}. Give the register's from and to to fix it.`,
    );
  }

  // ------------------------------------------------------ lines and tees
  const used = new Set<Edge>();
  /** Unused edges with an equipment end. */
  let eqLeft = edges.filter((e) => isEq(e.a) || isEq(e.b)).length;
  const plans: Plan[] = [];
  /** Where a vertex sits on a planned line (its fraction along it). */
  const placed = new Map<string, { line: string; at: number }>();
  let n = 0;
  const vertsOf = (start: string, es: Edge[]) => {
    const vs = [start];
    let v = start;
    for (const e of es) {
      v = far(e, v);
      vs.push(v);
    }
    return vs;
  };
  const plan = (
    start: string,
    es: Edge[],
    depth: number,
    attach?: { line: string; at: number },
  ): Plan => {
    for (const e of es) {
      if (!used.has(e) && (isEq(e.a) || isEq(e.b))) eqLeft -= 1;
      used.add(e);
    }
    n += 1;
    const id = `L${n}`;
    const verts = vertsOf(start, es);
    const length = es.reduce((x, e) => x + e.length, 0);
    let cum = 0;
    verts.forEach((v, i) => {
      if (i > 0) cum += es[i - 1]!.length;
      if (i === 0 || isEq(v) || placed.has(v)) return;
      if (i === verts.length - 1 && (adj.get(v)?.length ?? 0) <= 1) return;
      placed.set(v, { line: id, at: length > 0 ? Math.round((cum / length) * 100) / 100 : 0 });
    });
    const p: Plan = {
      id,
      edges: es,
      verts,
      depth,
      deadleg: es.every((e) => e.deadleg),
      length,
      ...(attach ? { parent: attach } : {}),
    };
    plans.push(p);
    return p;
  };
  const numbersOf = (e: Edge) => e.chain.lineNumbers.map((l) => norm(l.number));
  /** A branch from `v` along `first`: on through the next chain of the same
   *  role that keeps its line number, else the longest. */
  const grow = (v: string, first: Edge): Edge[] => {
    const es = [first];
    const seen = new Set([v]);
    let at = far(first, v);
    seen.add(at);
    for (;;) {
      if (isEq(at) || placed.has(at)) break;
      const last = es[es.length - 1]!;
      const nums = numbersOf(last);
      // A line keeps its role: a deadleg is its own line, never part of a
      // main-layer one, and the other way round.
      const next = (adj.get(at) ?? [])
        .filter(
          (e) =>
            !used.has(e) && !es.includes(e) && !seen.has(far(e, at)) && e.deadleg === first.deadleg,
        )
        .sort(
          (x, y) =>
            Number(numbersOf(y).some((k) => nums.includes(k))) -
              Number(numbersOf(x).some((k) => nums.includes(k))) || y.length - x.length,
        )[0];
      if (!next) break;
      es.push(next);
      at = far(next, at);
      seen.add(at);
    }
    return es;
  };
  const queue: Plan[] = [];
  if (m) queue.push(plan(m.from, m.edges, 0));
  /** Vertices whose every edge is used (the drain grew them all). */
  const drained = new Set<string>();
  let taken = 0;
  const drain = () => {
    while (taken < queue.length) {
      const p = queue[taken++]!;
      for (const v of p.verts) {
        if (drained.has(v)) continue;
        const there = isEq(v) ? undefined : placed.get(v);
        if (!isEq(v) && !there) continue;
        // Main-layer branches first, the longest first; deadlegs after.
        const out = (adj.get(v) ?? [])
          .filter((e) => !used.has(e))
          .sort((x, y) => Number(x.deadleg) - Number(y.deadleg) || y.length - x.length);
        for (const e of out) {
          if (used.has(e)) continue;
          const es = grow(v, e);
          queue.push(plan(v, es, p.depth + 1, there));
        }
        drained.add(v);
      }
    }
  };
  drain();
  // Whatever is not joined to the main line: from its equipment end, else
  // from an end that leaves the sheet, else from any end. In the order of
  // the unused edges and their ends: the first equipment end, else the
  // first end of one unused edge that is no deadleg, else the first end of
  // one, else the first end. Each read stops at its first find, from the
  // first unused edge; the equipment read only while such an edge is left.
  let lo = 0;
  const deg = (v: string) => (adj.get(v) ?? []).filter((e) => !used.has(e)).length;
  const firstEnd = (ok: (v: string, e: Edge) => boolean): string | undefined => {
    for (let i = lo; i < edges.length; i++) {
      const e = edges[i]!;
      if (used.has(e)) continue;
      if (ok(e.a, e)) return e.a;
      if (ok(e.b, e)) return e.b;
    }
    return undefined;
  };
  for (;;) {
    while (lo < edges.length && used.has(edges[lo]!)) lo++;
    if (lo === edges.length) break;
    // An end with one unused edge: that edge is the first it is on.
    const start =
      (eqLeft > 0 ? firstEnd(isEq) : undefined) ??
      firstEnd((v, e) => !e.deadleg && deg(v) === 1) ??
      firstEnd((v) => deg(v) === 1) ??
      edges[lo]!.a;
    const first = (adj.get(start) ?? [])
      .filter((e) => !used.has(e))
      .sort((x, y) => Number(x.deadleg) - Number(y.deadleg) || y.length - x.length)[0]!;
    queue.push(plan(start, grow(start, first), 1));
    drain();
  }

  // -------------------------------------------------------------- pieces
  /** A line as one page draws it: a whole planned line on the overview; on
   *  a sheet page its stretch on that sheet, cut again where it carries
   *  more valves than one drawn line holds. `prev`/`next` are the stretches
   *  before and after it (a sheet crossing, or a valve cut). */
  type Piece = {
    id: string;
    plan: Plan;
    edges: Edge[];
    verts: string[];
    length: number;
    sheet?: TraceSheet;
    parent?: { piece: Piece; at: number; cont?: true };
    prev?: Piece;
    next?: Piece;
  };
  const along = (pc: Piece, v: string) => {
    let cum = 0;
    for (let i = 0; i < pc.verts.length; i++) {
      if (i > 0) cum += pc.edges[i - 1]!.length;
      if (pc.verts[i] === v) return pc.length > 0 ? Math.round((cum / pc.length) * 100) / 100 : 0;
    }
    return 0;
  };
  const planById = new Map(plans.map((p) => [p.id, p]));
  const sheetPieces: Piece[] = [];
  const piecesOf = new Map<Plan, Piece[]>();
  for (const p of plans) {
    const runs: { edges: Edge[]; verts: string[]; cont: boolean }[] = [];
    p.edges.forEach((e, i) => {
      const last = runs[runs.length - 1];
      const n = e.chain.valves.length;
      const valves = last ? last.edges.reduce((x, f) => x + f.chain.valves.length, 0) : 0;
      if (last && last.edges[last.edges.length - 1]!.sheet === e.sheet) {
        if (valves + n <= PID_LIMITS.inline) {
          last.edges.push(e);
          last.verts.push(p.verts[i + 1]!);
          return;
        }
        // More valves than one line draws: the stretch goes on as a new
        // line, joined to it by a pair of CONTINUES connectors.
        runs.push({ edges: [e], verts: [p.verts[i]!, p.verts[i + 1]!], cont: true });
        return;
      }
      runs.push({ edges: [e], verts: [p.verts[i]!, p.verts[i + 1]!], cont: false });
    });
    const list = runs.map((r, i): Piece => ({
      id: runs.length === 1 ? p.id : `${p.id}-${i + 1}`,
      plan: p,
      edges: r.edges,
      verts: r.verts,
      length: r.edges.reduce((x, e) => x + e.length, 0),
      sheet: r.edges[0]!.sheet,
    }));
    list.forEach((pc, i) => {
      if (i > 0) {
        pc.prev = list[i - 1]!;
        list[i - 1]!.next = pc;
        if (runs[i]!.cont) pc.parent = { piece: list[i - 1]!, at: 1, cont: true };
        return;
      }
      if (!p.parent) return;
      const v = pc.verts[0]!;
      const theirs = (piecesOf.get(planById.get(p.parent.line)!) ?? []).filter((q) =>
        q.verts.includes(v),
      );
      const q = theirs.find((x) => x.sheet === pc.sheet) ?? theirs[0];
      if (q) pc.parent = { piece: q, at: along(q, v) };
    });
    piecesOf.set(p, list);
    sheetPieces.push(...list);
  }

  // --------------------------------------------------- where a vertex sits
  /** Where each vertex sits on the lines of one page (its fraction along
   *  the first line that passes it), as `plan` placed them. */
  const placeOn = (all: Piece[]) => {
    const at = new Map<string, { piece: Piece; at: number }>();
    for (const pc of all) {
      pc.verts.forEach((v, i) => {
        if (i === 0 || isEq(v) || at.has(v)) return;
        if (i === pc.verts.length - 1 && (adj.get(v)?.length ?? 0) <= 1) return;
        at.set(v, { piece: pc, at: along(pc, v) });
      });
    }
    return at;
  };
  /** Where each vertex sits on its sheet's lines, whatever page they are
   *  on: a line that ends on a line drawn on another page joins it there. */
  const sheetPlace = new Map(
    sheets.map((s) => [s, placeOn(sheetPieces.filter((pc) => pc.sheet === s))] as const),
  );
  /** The sheet stretches through each vertex, in plan order. */
  const piecesAt = new Map<string, Piece[]>();
  for (const pc of sheetPieces) for (const v of new Set(pc.verts)) push(piecesAt, v, pc);
  /** A stretch on another sheet that passes `v`: where a line crosses. */
  const crossAt = (v: string, pc: Piece): Piece | undefined => {
    if (isEq(v) || !pc.sheet) return undefined;
    const there = (piecesAt.get(v) ?? []).filter((q) => q.sheet !== pc.sheet);
    return there.find((q) => q.plan === pc.plan) ?? there[0];
  };

  // ------------------------------------------------------------ the ends
  /** What a free end of a line becomes: equipment, a connector (text,
   *  direction, sheet), or a stop. The one rule for every page. */
  type EndPlan =
    | { eq: string }
    | { conn: string; dir: 'in' | 'out'; sheet: string; guess?: 'link' | 'near' }
    | { stop: 'open' | 'deadleg' };
  /** The ends joined into each vertex (read once: the graph is built). */
  const endKeys = new Map<string, string[]>();
  for (const k of endAt.keys()) push(endKeys, find(k), k);
  const endPlans = new Map<string, EndPlan>();
  const endPlan = (v: string, side: 'from' | 'to'): EndPlan => {
    const key = `${side}|${v}`;
    let e = endPlans.get(key);
    if (!e) {
      e = endPlanOf(v, side);
      endPlans.set(key, e);
    }
    return e;
  };
  function endPlanOf(v: string, side: 'from' | 'to'): EndPlan {
    if (isEq(v)) return { eq: v };
    const dir = side === 'from' ? 'in' : 'out';
    const keys = endAt.has(v) ? [v] : (endKeys.get(v) ?? []);
    const at = keys.flatMap((k) => endAt.get(k) ?? []);
    const near = keys.map((k) => unconfirmed.get(k)).find(Boolean);
    const mark = ' (GUESS)';
    // Off-page style: an end that is not drawn as the equipment it is near.
    if (near) {
      return {
        conn: `NEAR ${near}`.slice(0, TEXT.connector - mark.length) + mark,
        dir,
        sheet: near,
        guess: 'near',
      };
    }
    const guessedLink = keys.map((k) => linkAt.get(k)).find(Boolean);
    if (guessedLink) {
      const head = `${side === 'from' ? 'FROM' : 'TO'} ${guessedLink.other}`;
      return {
        conn: head.slice(0, TEXT.connector - mark.length) + mark,
        dir,
        sheet: guessedLink.other,
        guess: 'link',
      };
    }
    for (const { sheet, end } of at) {
      if (end.meets.kind === 'circuit')
        return { conn: `CIRCUIT ${end.meets.circuit}`, dir, sheet: sheet.title };
      const label = end.labels.find((l) => !/^block /.test(l));
      if (label) {
        const named = /\b(COD|CONT\w*|SEE|TO|FROM)\b\s*(.*)$/i.exec(label);
        const other = named?.[2]?.trim() || label;
        return { conn: `${side === 'from' ? 'FROM' : 'TO'} ${other}`, dir, sheet: other };
      }
      if (end.deadleg) return { stop: 'deadleg' };
    }
    return { stop: 'open' };
  }

  // ------------------------------------------------------------ the budget
  type Page = SplitPage<Piece>;
  /** What a page holds, counted the way `emit` draws it. */
  const costOf = (pg: Page) => {
    const all = pg.context ? [pg.context, ...pg.items] : pg.items;
    const on = new Set(all);
    const placed = placeOn(all);
    const eq = new Set<string>();
    let conn = 0;
    let tees = 0;
    for (const pc of all) {
      const a = pc.verts[0]!;
      const b = pc.verts[pc.verts.length - 1]!;
      if (pc !== pg.context && pc.parent && !pc.parent.cont && on.has(pc.parent.piece)) tees += 1;
      else if (isEq(a)) eq.add(a);
      else conn += 1;
      const onLine = placed.get(b);
      const elsewhere = pc.sheet ? sheetPlace.get(pc.sheet)?.get(b) : undefined;
      if (pc !== pg.context && !pc.next && onLine && onLine.piece !== pc) tees += 1;
      else if (isEq(b)) eq.add(b);
      else if (
        pc === pg.context ||
        pc.next ||
        (elsewhere && elsewhere.piece !== pc) ||
        crossAt(b, pc) ||
        'conn' in endPlan(b, 'to')
      )
        conn += 1;
    }
    return { lines: all.length, eq: eq.size, conn, tees };
  };
  const over = (pg: Page) => {
    const c = costOf(pg);
    return (
      c.lines > PID_LINES ||
      c.eq > PID_LIMITS.equipment ||
      c.conn > PID_LIMITS.offpage ||
      c.tees > PID_LIMITS.tees
    );
  };
  /** Within the template's hard limits: what a page the cap leaves over
   *  the budget keeps (pages.ts). */
  const fits = (pg: Page) => {
    const c = costOf(pg);
    return (
      c.lines <= PID_LIMITS.lines &&
      c.eq <= PID_LIMITS.equipment &&
      c.conn <= PID_LIMITS.offpage &&
      c.tees <= PID_LIMITS.tees
    );
  };
  const nameOf = (pc: Piece) => {
    const ln = pc.edges.flatMap((e) => e.chain.lineNumbers)[0]?.number;
    return clip(ln ? `line ${ln}` : `line ${pc.id}`);
  };

  // ------------------------------------------------------------ the overview
  // The overview draws the main line, then the lines that carry a line
  // number, then the short pieces between them, while it stays within the
  // budget (lines, equipment, connectors). A line's deadlegs all go on it,
  // or none do: then they are on the sheet pages, and the line carries a
  // marker that counts them and links there.
  const ovPieces: Piece[] = [];
  const ovOf = new Map<string, Piece>();
  const chosen = new Set<string>();
  const parentOk = (p: Plan) => !p.parent || chosen.has(p.parent.line);
  const named = (p: Plan) => p.edges.some((e) => e.chain.lineNumbers.length > 0);
  /** Lines onto the overview, all of them or none. */
  const take = (ps: Plan[]): boolean => {
    if (ovPieces.length + ps.length > PID_LINES) return false;
    const pcs = ps.map((p): Piece => {
      const parentPiece = p.parent ? ovOf.get(p.parent.line) : undefined;
      return {
        id: p.id,
        plan: p,
        edges: p.edges,
        verts: p.verts,
        length: p.length,
        ...(parentPiece && p.parent ? { parent: { piece: parentPiece, at: p.parent.at } } : {}),
      };
    });
    if (over({ key: 'overview', title: '', items: [...ovPieces, ...pcs] })) return false;
    for (const pc of pcs) {
      ovPieces.push(pc);
      ovOf.set(pc.id, pc);
      chosen.add(pc.plan.id);
    }
    return true;
  };
  for (const pass of [true, false]) {
    for (const p of plans) {
      if (ovPieces.length >= PID_LINES) break;
      if (p.deadleg || chosen.has(p.id) || (pass && p.depth > 0 && !named(p))) continue;
      if (parentOk(p)) take([p]);
    }
  }
  const deadlegsOf = new Map<string, Plan[]>();
  for (const p of plans) {
    if (!p.deadleg) continue;
    push(deadlegsOf, p.parent?.line ?? '-', p);
  }
  for (const [k, list] of [...deadlegsOf].sort(
    (a, b) => (planById.get(a[0])?.depth ?? 99) - (planById.get(b[0])?.depth ?? 99),
  )) {
    if (k === '-' || chosen.has(k)) take(list);
  }
  // A line hanging off a deadleg line (the far side of a deadleg between two
  // main-layer pieces), once its parent is drawn.
  for (const p of plans) {
    if (ovPieces.length >= PID_LINES) break;
    if (!p.deadleg && !chosen.has(p.id) && parentOk(p)) take([p]);
  }
  // Drawn in the order they were planned: the main line first.
  const planIndex = new Map(plans.map((p, i) => [p, i]));
  ovPieces.sort((x, y) => planIndex.get(x.plan)! - planIndex.get(y.plan)!);

  // Valves past six on one overview line are on its sheet page.
  const valveCut = new Map<Piece, number>();
  for (const pc of ovPieces) {
    const n = pc.edges.reduce((x, e) => x + e.chain.valves.length, 0);
    if (n > PID_LIMITS.inline) valveCut.set(pc, n - PID_LIMITS.inline);
  }
  const hiddenPlans = plans.filter((p) => !chosen.has(p.id));
  const sheetsUsed = sheets
    .filter((s) => sheetPieces.some((pc) => pc.sheet === s))
    .sort((a, b) => sheetRank(a) - sheetRank(b));
  const needSheets = sheetsUsed.length > 1 || hiddenPlans.length > 0 || valveCut.size > 0;

  // ------------------------------------------------------------ the pages
  const pages: { page: Page; title: string; sheet?: TraceSheet }[] = [];
  const markersOn = new Map<string, Map<Piece, { text: string; page: string; focus: string }>>();
  const homeOf = new Map<Piece, string>();
  const titleOf = new Map<string, string>();
  let capped = false;
  if (needSheets) {
    sheetsUsed.forEach((s, i) => {
      const items = sheetPieces.filter((pc) => pc.sheet === s);
      const split = splitPages<Piece>(
        { key: `sheet-${i + 1}`, title: clipTitle(s.title), items },
        { parentOf: (pc) => pc.parent?.piece, over, fits, budget: PID_LINES, nameOf },
        pages.length + 1,
      );
      capped ||= split.capped;
      for (const pg of split.pages) {
        pages.push({ page: pg, title: pg.title, sheet: s });
        titleOf.set(pg.key, pg.title);
        for (const pc of pg.items) homeOf.set(pc, pg.key);
      }
      for (const mk of split.markers) {
        const m = markersOn.get(mk.page) ?? new Map();
        m.set(mk.on, { text: countText(mk.items, 0), page: mk.to, focus: mk.on.id });
        markersOn.set(mk.page, m);
      }
    });
  }
  // The overview's markers: what hangs off a drawn line but is not drawn
  // there (and the valves past six on it), with the page that holds most
  // of it.
  const kidsOf = new Map<string, Plan[]>();
  for (const p of plans) {
    if (p.parent) push(kidsOf, p.parent.line, p);
  }
  const below = (p: Plan): Plan[] => [p, ...(kidsOf.get(p.id) ?? []).flatMap(below)];
  const ovMarkers = new Map<Piece, { text: string; page: string; focus: string }>();
  if (needSheets) {
    for (const pc of ovPieces) {
      const hidden = (kidsOf.get(pc.plan.id) ?? []).filter((k) => !chosen.has(k.id)).flatMap(below);
      const valves = valveCut.get(pc) ?? 0;
      if (!hidden.length && !valves) continue;
      const firsts = hidden.length
        ? hidden.map((h) => piecesOf.get(h)![0]!)
        : [
            [...(piecesOf.get(pc.plan) ?? [])].sort(
              (a, b) =>
                b.edges.reduce((x, e) => x + e.chain.valves.length, 0) -
                a.edges.reduce((x, e) => x + e.chain.valves.length, 0),
            )[0]!,
          ];
      const votes = new Map<string, number>();
      for (const f of firsts) {
        const h = homeOf.get(f);
        if (h) votes.set(h, (votes.get(h) ?? 0) + 1);
      }
      const page = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (!page) continue;
      const focus = firsts.find((f) => homeOf.get(f) === page)!;
      const counted = hidden.flatMap((h) => piecesOf.get(h)!.slice(0, 1));
      ovMarkers.set(pc, { text: countText(counted, valves), page, focus: focus.id });
    }
  }

  // ------------------------------------------------------------ drawing
  const typeOf = new Map<string, string>();
  const typeFor = (tag: string) => {
    if (!typeOf.has(tag)) typeOf.set(tag, input.equipmentType(tag));
    return typeOf.get(tag)!;
  };
  const said = new Set<string>();
  const once = (text: string) => {
    if (said.has(text)) return;
    said.add(text);
    limits.push(text);
  };
  type Mark = 'link' | 'inferred' | 'near';
  /** The guess kinds drawn on each page, and on the whole set. */
  const marksOf = new Map<string, Set<Mark>>();
  const allMarks = new Set<Mark>();
  const valvesOn = (pc: Piece): TraceValve[] => {
    const out: TraceValve[] = [];
    pc.edges.forEach((e, i) => {
      const forward = pc.verts[i] === e.a;
      out.push(...(forward ? e.chain.valves : [...e.chain.valves].reverse()));
    });
    return out;
  };

  /** One page's `pid` data: the lines it owns (and its context line). */
  const emit = (
    pg: Page,
    pageTitle: string,
    markers: Map<Piece, { text: string; page: string; focus: string }>,
    sheetMode: boolean,
  ): { drawn: Piece[]; cuts: string[]; inlineCut: number; data: Record<string, unknown> } => {
    const all = pg.context ? [pg.context, ...pg.items] : pg.items;
    const onPage = new Set(all);
    const placed = placeOn(all);
    const cuts = new Set<string>();
    const marks = new Set<Mark>();
    marksOf.set(pg.key, marks);
    const equipment = new Map<string, { id: string; type: string }>();
    const offpage: {
      id: string;
      direction: 'in' | 'out';
      sheet: string;
      text?: string;
      link?: string;
      focus?: string;
    }[] = [];
    const tees: { id: string; on: string; at?: number }[] = [];
    const lines: Record<string, unknown>[] = [];
    /** The pieces drawn here, in the order their lines are. */
    const drawn: Piece[] = [];
    const taken = new Set<string>();
    const unique = (base: string) => {
      let id = base;
      for (let k = 2; taken.has(id); k++) id = `${base.slice(0, 28)}-${k}`;
      taken.add(id);
      return id;
    };
    const eqId = new Map<string, string>();
    const equipmentOf = (v: string) => {
      const known = eqId.get(v);
      if (known) return known;
      if (equipment.size >= PID_LIMITS.equipment) {
        cuts.add(`equipment past ${PID_LIMITS.equipment}: an end drawn without its equipment`);
        return null;
      }
      const tag = eqTag(v);
      const id = unique(tagId(tag, `EQ-${equipment.size + 1}`));
      eqId.set(v, id);
      equipment.set(id, { id, type: typeFor(tag) });
      return id;
    };
    const teeId = new Map<string, string>();
    const teeOn = (lineId: string, at: number, v: string) => {
      const known = teeId.get(v);
      if (known) return known;
      if (tees.length >= PID_LIMITS.tees) return null;
      const id = unique(`T-${tees.length + 1}`);
      tees.push({ id, on: lineId, at });
      teeId.set(v, id);
      return id;
    };
    const shortSheet = (t: string) => t.replace(/\s+/g, '').slice(0, 12) || '?';
    const connector = (text: string, dir: 'in' | 'out', sheet: string, to?: Piece) => {
      if (offpage.length >= PID_LIMITS.offpage) {
        cuts.add(`connectors past ${PID_LIMITS.offpage}: ends drawn open`);
        return null;
      }
      const id = unique(`OPC-${offpage.length + 1}`);
      const home = to ? homeOf.get(to) : undefined;
      offpage.push({
        id,
        direction: dir,
        sheet: shortSheet(sheet),
        text: text.slice(0, TEXT.connector),
        ...(home && to ? { link: home, focus: to.id } : {}),
      });
      return id;
    };
    /** A free end as `endPlan` says, or a connector to the sheet a line
     *  crosses to (a sheet page). */
    const endOf = (pc: Piece, v: string, side: 'from' | 'to') => {
      const cross = sheetMode ? crossAt(v, pc) : undefined;
      if (cross) {
        const id = connector(
          `${side === 'from' ? 'FROM' : 'TO'} ${cross.sheet!.title}`,
          side === 'from' ? 'in' : 'out',
          cross.sheet!.title,
          cross,
        );
        if (id) return { id };
      }
      const e = endPlan(v, side);
      if ('eq' in e) {
        const id = equipmentOf(v);
        return id ? { id } : { stop: 'open' as const };
      }
      if ('conn' in e) {
        if (e.guess) marks.add(e.guess);
        const id = connector(e.conn, e.dir, e.sheet);
        if (id) return { id };
        return { stop: 'open' as const };
      }
      return e;
    };
    const usedNumbers = new Set<string>();
    const numberFor = (pc: Piece) => {
      const share = new Map<string, { number: string; length: number }>();
      for (const e of pc.edges) {
        for (const ln of e.chain.lineNumbers) {
          const k = norm(ln.number);
          const s = share.get(k) ?? { number: ln.number, length: 0 };
          s.length += e.length;
          share.set(k, s);
        }
      }
      const ranked = [...share].sort((a, b) => b[1].length - a[1].length);
      const pick = ranked.find(([k]) => !usedNumbers.has(k));
      if (!pick) return undefined;
      usedNumbers.add(pick[0]);
      return pick[1].number.slice(0, TEXT.lineNumber);
    };
    /** The page that owns the context line (none: the cap left it off). */
    const contextHome = pg.context ? homeOf.get(pg.context) : undefined;
    const homeTitle = contextHome ? (titleOf.get(contextHome) ?? contextHome) : '';
    let inlineCut = 0;
    for (const pc of all) {
      const start = pc.verts[0]!;
      const stop = pc.verts[pc.verts.length - 1]!;
      const isContext = pc === pg.context;
      let from: string | undefined;
      let to: string | undefined;
      let end: 'open' | undefined;
      let deadleg = pc.plan.deadleg;
      if (isContext) {
        // The line its children hang off, drawn again here: its ends lead
        // back to the page that draws it, or say no other page does.
        const back = (v: string, dir: 'in' | 'out') =>
          (isEq(v) ? equipmentOf(v) : null) ??
          (contextHome
            ? connector(`SEE ${homeTitle}`, dir, homeTitle, pc)
            : connector('ON NO OTHER PAGE', dir, pc.sheet?.title ?? '?')) ??
          undefined;
        from = back(start, 'in');
        to = back(stop, 'out');
        if (!to) end = 'open';
        deadleg = false;
      } else {
        if (pc.prev) {
          const crossing = pc.prev.sheet !== pc.sheet;
          from =
            connector(
              crossing ? `FROM ${pc.prev.sheet!.title}` : 'CONTINUED',
              'in',
              (crossing ? pc.prev.sheet! : pc.sheet!).title,
              pc.prev,
            ) ?? undefined;
        } else if (pc.parent && onPage.has(pc.parent.piece)) {
          from = teeOn(pc.parent.piece.id, pc.parent.at, start) ?? undefined;
        } else if (pc.parent) {
          const home = homeOf.get(pc.parent.piece);
          from =
            connector(
              `FROM ${home ? (titleOf.get(home) ?? home) : pc.parent.piece.id}`,
              'in',
              pc.parent.piece.sheet?.title ?? '?',
              pc.parent.piece,
            ) ?? undefined;
        } else {
          const ep = endOf(pc, start, 'from');
          if ('id' in ep) from = ep.id;
          else {
            from = connector('OPEN END', 'in', pc.edges[0]!.sheet.title) ?? undefined;
            if (from) {
              once(
                `${pc.edges[0]!.sheet.title}: ${lineName(pc.plan)} starts at an end that meets nothing drawn; the pid input starts it at a connector marked OPEN END.`,
              );
            }
          }
        }
        if (pc.next) {
          const crossing = pc.next.sheet !== pc.sheet;
          to =
            connector(
              crossing ? `TO ${pc.next.sheet!.title}` : 'CONTINUES',
              'out',
              (crossing ? pc.next.sheet! : pc.sheet!).title,
              pc.next,
            ) ?? undefined;
          if (!to) end = 'open';
          deadleg = false;
        } else {
          const onLine = placed.get(stop);
          const elsewhere = pc.sheet ? sheetPlace.get(pc.sheet)?.get(stop) : undefined;
          if (onLine && onLine.piece !== pc) {
            to = teeOn(onLine.piece.id, onLine.at, stop) ?? undefined;
            if (!to) end = 'open';
          } else if (
            sheetMode &&
            elsewhere &&
            elsewhere.piece !== pc &&
            homeOf.has(elsewhere.piece)
          ) {
            // It ends on a line this page does not draw: a connector to it.
            const home = homeOf.get(elsewhere.piece)!;
            to =
              connector(
                `JOINS ${elsewhere.piece.id} ON ${titleOf.get(home) ?? home}`,
                'out',
                pc.sheet!.title,
                elsewhere.piece,
              ) ?? undefined;
            if (!to) end = 'open';
          } else {
            const ep = endOf(pc, stop, 'to');
            if ('id' in ep) to = ep.id;
            else if (ep.stop === 'deadleg') deadleg = true;
            else end = 'open';
          }
        }
      }
      if (!from) {
        cuts.add('lines with no room for their start: left off');
        continue;
      }
      if (to && to === from) {
        to = undefined;
        end = 'open';
      }
      const valves = valvesOn(pc);
      // Up to six inline items: named ones before guessed ones, in path order.
      const keep = new Set(
        [...valves.keys()]
          .sort((a, b) => Number(valves[a]!.guessed) - Number(valves[b]!.guessed) || a - b)
          .slice(0, PID_LIMITS.inline),
      );
      if (!(sheetMode === false && valveCut.has(pc))) inlineCut += valves.length - keep.size;
      const inline = valves.filter((_, i) => keep.has(i)).map((v) => ({ type: v.type }));
      const number = numberFor(pc);
      // A process-line join on the line is an inference: marked on every
      // page that draws it.
      const inferred = pc.edges.reduce(
        (x, e) => x + (e.chain.joins ?? []).filter((j) => j.inferred).length,
        0,
      );
      if (inferred) marks.add('inferred');
      const mk = markers.get(pc);
      drawn.push(pc);
      lines.push({
        id: pc.id,
        ...(number ? { number } : {}),
        ...(inferred
          ? {
              note: inferred === 1 ? 'INFERRED JOIN (GUESS)' : `${inferred} INFERRED JOINS (GUESS)`,
            }
          : {}),
        from,
        ...(to ? { to } : {}),
        ...(!to && end ? { end } : {}),
        ...(deadleg && !to ? { deadleg: true } : {}),
        ...(pc.plan.depth > 0 ? { weight: 'secondary' } : {}),
        ...(inline.length ? { inline } : {}),
        ...(mk ? { more: { text: mk.text, link: mk.page, focus: mk.focus } } : {}),
      });
    }
    const drawnLines = new Set(lines.map((l) => l.id as string));
    for (const k of marks) allMarks.add(k);
    return {
      drawn,
      cuts: [...cuts],
      inlineCut,
      data: {
        lines,
        equipment: [...equipment.values()],
        offpage,
        tees: tees.filter(
          (t) => drawnLines.has(t.on) && lines.some((l) => l.from === t.id || l.to === t.id),
        ),
        circuits: [
          {
            id: tagId(`CIRCUIT-${circuit}`, 'CIRCUIT', CIRCUIT_ID),
            label: circuit.slice(0, TEXT.circuitLabel),
            lines: lines.map((l) => l.id as string),
            equipment: [...equipment.keys()],
          },
        ],
      },
    };
  };

  const ovOut = emit(
    { key: 'overview', title: 'Overview', items: ovPieces },
    'the overview',
    ovMarkers,
    false,
  );
  const ov = ovOut.data;
  const ovLines = (ov.lines as unknown[]).length;
  const sheetData = pages.map(({ page, title, sheet }) => {
    const out = emit(page, title, markersOn.get(page.key) ?? new Map(), true);
    return { page, title, sheet, out, data: out.data };
  });
  // A link's focus names a line the target page drew; a line left off at a
  // cap is not there, so the link shows the page alone.
  const drawnOn = new Map<string, Set<string>>(
    sheetData.map(({ page, data }) => [
      page.key,
      new Set((data.lines as { id: string }[]).map((l) => l.id)),
    ]),
  );
  for (const [key, d] of [
    ['overview', ov] as const,
    ...sheetData.map((x) => [x.page.key, x.data] as const),
  ]) {
    const fix = (o: { link?: string; focus?: string }) => {
      if (o.link && o.focus && !drawnOn.get(o.link)?.has(o.focus)) delete o.focus;
      // A link to its own page is only for the element it shows.
      if (o.link === key && !o.focus) delete o.link;
    };
    for (const o of d.offpage as { link?: string; focus?: string }[]) fix(o);
    for (const l of d.lines as { more?: { link?: string; focus?: string } }[]) {
      if (l.more) fix(l.more);
    }
  }

  // Every chain is drawn on a page that owns it: counted, per sheet, when
  // one is not (the page cap, or a page cut at the template limits).
  const owned = new Set(
    (needSheets ? sheetData.flatMap((x) => x.out.drawn) : ovOut.drawn).flatMap((pc) => pc.edges),
  );
  const lostBy = new Map<TraceSheet, number>();
  for (const e of edges) if (!owned.has(e)) lostBy.set(e.sheet, (lostBy.get(e.sheet) ?? 0) + 1);
  const lost = [...lostBy.values()].reduce((a, b) => a + b, 0);
  const plural = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`;

  // What each page could not draw, in page order.
  const sheetInlineCut = sheetData.reduce((a, x) => a + x.out.inlineCut, 0);
  if (ovOut.cuts.length) {
    once(
      needSheets
        ? `the overview is cut at the template limits (${ovOut.cuts.join('; ')}); ${lost ? 'its lines are on the sheet pages, but for the chains on no page counted here' : 'the sheet pages draw every line'}.`
        : `the overview: the page is cut at the template limits (${ovOut.cuts.join('; ')}); the trace JSON has every chain.`,
    );
  }
  const valvesCut = (where: string, k: number) =>
    `${where}: ${k} valve${k === 1 ? '' : 's'} or reducer${k === 1 ? '' : 's'} past six on one chain ${k === 1 ? 'is' : 'are'} left off the drawing (guessed ones first); the trace JSON has them on its chains.`;
  if (ovOut.inlineCut) once(valvesCut('the overview', ovOut.inlineCut));
  for (const { title, out } of sheetData) {
    if (out.cuts.length) {
      once(
        `${title}: the page is cut at the template limits (${out.cuts.join('; ')}); the trace JSON has every chain.`,
      );
    }
    if (out.inlineCut) once(valvesCut(title, out.inlineCut));
  }
  if (!ovLines) limits.push('nothing on the circuit could be drawn.');
  if (lost) {
    const named = sheets.filter((x) => lostBy.has(x));
    const list = named
      .slice(0, 4)
      .map((x) => (named.length === 1 ? clip(x.title) : `${clip(x.title)} (${lostBy.get(x)})`))
      .join(', ');
    const more = named.length > 4 ? ` and ${named.length - 4} more` : '';
    limits.push(
      `${plural(lost, 'chain')} of sheet${named.length === 1 ? '' : 's'} ${list}${more} ${lost === 1 ? 'is' : 'are'} on no page of the drawing${needSheets ? ' set' : ''}${capped ? `: a set holds at most ${SET_LIMITS.pages} pages, each within the template's limits, and ${lost === 1 ? 'it does' : 'they do'} not fit` : ''}; the trace JSON has every chain.`,
    );
  }
  const heavy = sheetData.filter((x) => (x.data.lines as unknown[]).length > PID_LINES);
  if (capped && heavy.length) {
    limits.push(
      `a drawing set holds at most ${SET_LIMITS.pages} pages: ${plural(heavy.length, 'page')} past the cap draw${heavy.length === 1 ? 's' : ''} more than the ${PID_LINES}-line budget, within the template's limits (${heavy
        .slice(0, 4)
        .map((x) => clip(x.title))
        .join(', ')}${heavy.length > 4 ? ` and ${heavy.length - 4} more` : ''}).`,
    );
  }

  const guessNoteOf = (ms: Set<Mark>) => {
    const words = [
      ms.has('link') ? 'sheet links' : '',
      ms.has('inferred') ? 'joins through process lines' : '',
      ms.has('near') ? 'ends only near equipment' : '',
    ].filter(Boolean);
    return words.length ? ` Guesses are marked GUESS (${words.join(', ')}).` : '';
  };
  const total = plans.length;
  const rest = lost
    ? `every other line but ${plural(lost, 'chain')} on no page (see limits)`
    : sheetInlineCut
      ? 'every line and deadleg'
      : 'every line, deadleg and valve';
  const setNote = needSheets
    ? ` ${pages.length + 1} pages: the overview draws ${ovLines} of ${plural(total, 'line')}; the sheet pages draw ${rest}.`
    : '';
  const crossings = m ? new Set(m.edges.map((e) => e.sheet.title)).size - 1 : 0;
  // The first sentence is cut to fit, never the set's count or the guesses.
  const about = (note: string) =>
    noted(
      m
        ? `Circuit ${circuit}: main line ${vname(m.from)} to ${vname(m.to)}${mainBasis ? ` (${mainBasis})` : ''}, ${round(m.edges.reduce((x, e) => x + e.length, 0))} drawing units across ${crossings + 1} sheet${crossings ? 's' : ''}.`
        : `Circuit ${circuit} traced from ${sheets.length} uploaded drawing${sheets.length === 1 ? '' : 's'}; no main line between two pieces of equipment was found.`,
      setNote + note,
    );
  const head = `Circuit ${circuit}`.slice(0, TEXT.title);
  // One page holds it all: one plain drawing, no set around it.
  if (!needSheets) {
    return {
      template: 'pid',
      title: head,
      description: about(guessNoteOf(allMarks)),
      legendNames: LEGEND_NAMES,
      ...ov,
    };
  }
  return {
    template: 'pid',
    title: head,
    description: about(guessNoteOf(allMarks)),
    legendNames: LEGEND_NAMES,
    pages: [
      {
        id: 'overview',
        title: 'Overview',
        data: {
          title: head,
          description: about(guessNoteOf(marksOf.get('overview') ?? new Set())),
          ...ov,
        },
      },
      ...sheetData.map(({ page, title, sheet, data }) => {
        const n = (data.lines as { more?: unknown }[]).length;
        const more = (data.lines as { more?: unknown }[]).some((l) => l.more);
        // Said once a sheet, on its first page.
        const lostHere =
          sheet && sheetData.find((x) => x.sheet === sheet)?.page === page
            ? (lostBy.get(sheet) ?? 0)
            : 0;
        const note = guessNoteOf(marksOf.get(page.key) ?? new Set());
        return {
          id: page.key,
          title: clipTitle(title),
          data: {
            title: `${head}: ${title}`.slice(0, TEXT.title),
            description: noted(
              page.context
                ? `Detail of ${sheet?.title ?? title}: the lines off ${nameOf(page.context)}, ${homeOf.has(page.context) ? 'drawn again here' : 'drawn only here: at the page cap it is on no other page'}.`
                : `Sheet ${sheet?.title ?? title} of circuit ${circuit}: ${plural(n, 'line')} drawn here${more ? '; a +N marker links to the page that holds what a line leaves out' : ''}${lostHere ? `; ${plural(lostHere, 'chain')} of this sheet ${lostHere === 1 ? 'is' : 'are'} on no page (see limits)` : ''}.`,
              note,
            ),
            ...data,
          },
        };
      }),
    ],
  };

  /** A description within the template's limit: `text` is cut to fit,
   *  `rest` (the guess note last) never is. */
  function noted(text: string, rest: string): string {
    return clipText(text, TEXT.description - rest.length) + rest;
  }

  /** A count of what moved: "+3 LINES, 5 DEADLEGS", and valves past six. */
  function countText(items: Piece[], valves: number): string {
    const dl = items.filter((pc) => pc.plan.deadleg).length;
    const ln = items.length - dl;
    const s = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 'S'}`;
    const long = [
      ln ? s(ln, 'LINE') : '',
      dl ? s(dl, 'DEADLEG') : '',
      valves ? s(valves, 'VALVE') : '',
    ]
      .filter(Boolean)
      .join(', ');
    const short = [ln ? `${ln} LN` : '', dl ? `${dl} DL` : '', valves ? `${valves} VLV` : '']
      .filter(Boolean)
      .join(', ');
    return `+${long}`.length <= TEXT.marker ? `+${long}` : `+${short}`.slice(0, TEXT.marker);
  }

  function lineName(p: Plan): string {
    const ln = p.edges.flatMap((e) => e.chain.lineNumbers)[0]?.number;
    return ln ? `line ${ln}` : `the line from ${p.edges[0]!.sheet.title}`;
  }
}

function round(v: number) {
  return Math.round(v * 10) / 10;
}

/** Whether `a` beats `b` compared field by field. */
function lexGreater(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return false;
}
