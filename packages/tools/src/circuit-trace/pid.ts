/**
 * circuit_trace, the drawing: the traced circuit as `pid` template input.
 *
 * Every sheet's chains go into one graph: an end two sheets link is one
 * point there, and every end at a piece of equipment is that equipment. The
 * main line is the path along the real flow from the upstream equipment to
 * the downstream one (the register's from and to when it names them, else
 * the pair whose path crosses the most sheets on main layers); then the
 * branches hang off it on tees, then lines from the equipment on it, and the
 * deadlegs last. The template's line budget goes to them in that order:
 * deadlegs are grouped per parent line, the longest drawn first, and what
 * does not fit is counted in `limits`, never dropped silently.
 *
 * Pure: it reads the walk's output and writes the template's input.
 */
import type { SheetLink, TraceChain, TraceEnd, TraceSheet, TraceValve } from './walk';

/** The template's own hard limits (packages/diagram-templates pid schema). */
export const PID_MAX = { lines: 60, tees: 30, equipment: 30, offpage: 20, inline: 6 } as const;
/** Lines drawn: the guide's budget is 12 labelled process lines; a traced
 *  circuit gets 20 so a few deadlegs fit beside the main run and branches. */
export const PID_LINES = 20;
const CIRCUIT_ID = 24;

const norm = (t: string) => t.toUpperCase().replace(/[\s"'`]+/g, '');

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
  for (const s of sheets) {
    for (const run of s.runs) {
      for (const end of run.ends) {
        const k = keyOf(s, end.node);
        endAt.set(k, [...(endAt.get(k) ?? []), { sheet: s, end }]);
        if (end.equipment.length) join(k, `EQ:${end.equipment[0]!}`);
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
  for (const e of edges) {
    adj.set(e.a, [...(adj.get(e.a) ?? []), e]);
    if (e.b !== e.a) adj.set(e.b, [...(adj.get(e.b) ?? []), e]);
  }
  const far = (e: Edge, v: string) => (e.a === v ? e.b : e.a);
  const isEq = (v: string) => v.startsWith('EQ:');
  const eqTag = (v: string) => v.slice(3);

  // ------------------------------------------------------------ main path
  /** The cheapest path between two vertices that passes no other equipment;
   *  a deadleg chain costs twenty times its length. */
  const path = (from: string, to: string): Edge[] | null => {
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
        const w = far(e, v);
        const nc = best + e.length * (e.deadleg ? 20 : 1) + 1e-6;
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
        `the register's circuit ${side} ${name} is not at any end of the traced geometry; the main line is read from the drawing alone.`,
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
  type Main = { from: string; to: string; edges: Edge[]; score: number[] };
  let main: Main | null = null;
  const consider = (a: string, b: string) => {
    const p = path(a, b);
    if (!p?.length) return;
    // A main run crosses each sheet once: a path that leaves a sheet and
    // comes back to it is a loop through other lines, not the run.
    const order = p.map((e) => e.sheet.tableId).filter((t, i, a) => i === 0 || a[i - 1] !== t);
    const score = [
      Number(new Set(order).size === order.length),
      new Set(order).size,
      -p.filter((e) => e.deadleg).length,
      -turnsOf(a, p),
      p.reduce((x, e) => x + e.length, 0),
    ];
    const better = !main || lexGreater(score, main.score);
    if (better) main = { from: a, to: b, edges: p, score };
  };
  let mainBasis: string;
  if (regFrom && regTo && regFrom !== regTo) {
    consider(regFrom, regTo);
    mainBasis = `the register's circuit from ${input.register!.from} and to ${input.register!.to}`;
  } else {
    const pinned = regFrom ?? regTo;
    for (let i = 0; i < eqs.length; i++) {
      for (let k = i + 1; k < eqs.length; k++) {
        if (pinned && eqs[i] !== pinned && eqs[k] !== pinned) continue;
        consider(eqs[i]!, eqs[k]!);
      }
    }
    mainBasis = '';
  }
  const m = main as Main | null;
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
      `the main line runs ${eqTag(m.from)} to ${eqTag(m.to)}: the pair of equipment ends whose path crosses the most sheets, each once, on main layers, and goes straightest through its tees${regFrom || regTo ? `, one end fixed by the register` : ''}; its direction is read from the ${input.register?.sheets?.length ? "register's sheet order" : 'upload order of the sheets'}, not from flow arrows. Give the register's from and to to fix it.`,
    );
  }

  // ------------------------------------------------------ lines and tees
  const used = new Set<Edge>();
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
    for (const e of es) used.add(e);
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
  /** A branch from `v` along `first`: on through the next chain that keeps
   *  its line number, else the main-layer one, else the longest. */
  const grow = (v: string, first: Edge): Edge[] => {
    const es = [first];
    const seen = new Set([v]);
    let at = far(first, v);
    seen.add(at);
    for (;;) {
      if (isEq(at) || placed.has(at)) break;
      const last = es[es.length - 1]!;
      const nums = numbersOf(last);
      const next = (adj.get(at) ?? [])
        .filter((e) => !used.has(e) && !es.includes(e) && !seen.has(far(e, at)))
        .sort(
          (x, y) =>
            Number(numbersOf(y).some((k) => nums.includes(k))) -
              Number(numbersOf(x).some((k) => nums.includes(k))) ||
            Number(x.deadleg) - Number(y.deadleg) ||
            y.length - x.length,
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
  const drain = () => {
    while (queue.length) {
      const p = queue.shift()!;
      for (const v of p.verts) {
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
      }
    }
  };
  drain();
  // Whatever is not joined to the main line: from its equipment end, else
  // from an end that leaves the sheet, else from any end.
  for (;;) {
    const rest = edges.filter((e) => !used.has(e));
    if (!rest.length) break;
    const verts = [...new Set(rest.flatMap((e) => [e.a, e.b]))];
    const deg = (v: string) => (adj.get(v) ?? []).filter((e) => !used.has(e)).length;
    const start =
      verts.find(isEq) ??
      verts.find((v) => deg(v) === 1 && !rest.find((e) => e.a === v || e.b === v)!.deadleg) ??
      verts.find((v) => deg(v) === 1) ??
      verts[0]!;
    const first = (adj.get(start) ?? [])
      .filter((e) => !used.has(e))
      .sort((x, y) => Number(x.deadleg) - Number(y.deadleg) || y.length - x.length)[0]!;
    queue.push(plan(start, grow(start, first), 1));
    drain();
  }

  // ------------------------------------------------------------ the budget
  const byId = new Map(plans.map((p) => [p.id, p]));
  const chosen = new Set<string>();
  const parentOk = (p: Plan) => !p.parent || chosen.has(p.parent.line);
  // Lines on main layers: the main line, then those that carry a line
  // number (a named pipe), then the short unnamed pieces between them.
  const named = (p: Plan) => p.edges.some((e) => e.chain.lineNumbers.length > 0);
  for (const pass of [true, false]) {
    for (const p of plans) {
      if (chosen.size >= PID_LINES) break;
      if (p.deadleg || chosen.has(p.id) || (pass && p.depth > 0 && !named(p))) continue;
      if (parentOk(p)) chosen.add(p.id);
    }
  }
  const deadlegsOf = new Map<string, Plan[]>();
  for (const p of plans) {
    if (!p.deadleg) continue;
    const k = p.parent?.line ?? '-';
    deadlegsOf.set(k, [...(deadlegsOf.get(k) ?? []), p]);
  }
  for (const list of deadlegsOf.values()) list.sort((a, b) => b.length - a.length);
  // Round robin over the parents, main line first, the longest each time.
  for (let round = 0; chosen.size < PID_LINES; round++) {
    let took = false;
    for (const [k, list] of [...deadlegsOf].sort(
      (a, b) => (byId.get(a[0])?.depth ?? 99) - (byId.get(b[0])?.depth ?? 99),
    )) {
      const p = list[round];
      if (!p || chosen.size >= PID_LINES) continue;
      if (k !== '-' && !chosen.has(k)) continue;
      chosen.add(p.id);
      took = true;
    }
    if (!took) break;
  }
  const leftBranches = plans.filter((p) => !p.deadleg && !chosen.has(p.id));
  if (leftBranches.length) {
    limits.push(
      `the drawing holds ${PID_LINES} lines: ${leftBranches.length} more line${leftBranches.length === 1 ? '' : 's'} on main layers ${leftBranches.length === 1 ? 'is' : 'are'} left off it (${round(leftBranches.reduce((x, p) => x + p.length, 0))} drawing units); the trace JSON has every chain.`,
    );
  }
  const dlNotes: string[] = [];
  for (const [k, list] of deadlegsOf) {
    const drawn = list.filter((p) => chosen.has(p.id)).length;
    if (drawn === list.length) continue;
    const parentPlan = byId.get(k);
    const where = parentPlan ? `on ${lineName(parentPlan)}` : 'apart from the main line';
    dlNotes.push(`${list.length} ${where} (${drawn} drawn, the longest)`);
  }
  if (dlNotes.length) {
    limits.push(`deadlegs not all drawn, by the line they hang off: ${dlNotes.join('; ')}.`);
  }

  // ---------------------------------------------------------------- output
  const cuts = new Set<string>();
  const equipment = new Map<string, { id: string; type: string }>();
  const offpage: { id: string; direction: 'in' | 'out'; sheet: string; text?: string }[] = [];
  const tees: { id: string; on: string; at?: number }[] = [];
  const lines: Record<string, unknown>[] = [];
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
    if (equipment.size >= PID_MAX.equipment) {
      cuts.add(`equipment past ${PID_MAX.equipment}: an end drawn without its equipment`);
      return null;
    }
    const tag = eqTag(v);
    const id = unique(tagId(tag, `EQ-${equipment.size + 1}`));
    eqId.set(v, id);
    equipment.set(id, { id, type: input.equipmentType(tag) });
    return id;
  };
  const teeId = new Map<string, string>();
  const teeOn = (lineId: string, at: number, v: string) => {
    const known = teeId.get(v);
    if (known) return known;
    if (tees.length >= PID_MAX.tees) return null;
    const id = unique(`T-${tees.length + 1}`);
    tees.push({ id, on: lineId, at });
    teeId.set(v, id);
    return id;
  };
  const shortSheet = (t: string) => t.replace(/\s+/g, '').slice(0, 12) || '?';
  const connector = (text: string, dir: 'in' | 'out', sheet: string) => {
    if (offpage.length >= PID_MAX.offpage) {
      cuts.add(`connectors past ${PID_MAX.offpage}: ends drawn open`);
      return null;
    }
    const id = unique(`OPC-${offpage.length + 1}`);
    offpage.push({ id, direction: dir, sheet: shortSheet(sheet), text: text.slice(0, 40) });
    return id;
  };
  /** What a free end of a line becomes. */
  const endOf = (
    v: string,
    side: 'from' | 'to',
  ): { id: string } | { stop: 'open' | 'deadleg' } | null => {
    if (isEq(v)) {
      const id = equipmentOf(v);
      return id ? { id } : { stop: 'open' };
    }
    const at = endAt.get(v) ?? [...endAt].find(([k]) => find(k) === v)?.[1] ?? [];
    const guessedLink = (endAt.has(v) ? [v] : [...endAt.keys()].filter((k) => find(k) === v))
      .map((k) => linkAt.get(k))
      .find(Boolean);
    if (guessedLink) {
      const mark = ' (GUESS)';
      const head = `${side === 'from' ? 'FROM' : 'TO'} ${guessedLink.other}`;
      const id = connector(
        head.slice(0, 40 - mark.length) + mark,
        side === 'from' ? 'in' : 'out',
        guessedLink.other,
      );
      if (id) return { id };
    }
    for (const { sheet, end } of at) {
      if (end.meets.kind === 'circuit') {
        const id = connector(
          `CIRCUIT ${end.meets.circuit}`,
          side === 'from' ? 'in' : 'out',
          sheet.title,
        );
        if (id) return { id };
      }
      const label = end.labels.find((l) => !/^block /.test(l));
      if (label) {
        const named = /\b(COD|CONT\w*|SEE|TO|FROM)\b\s*(.*)$/i.exec(label);
        const other = named?.[2]?.trim() || label;
        const id = connector(
          `${side === 'from' ? 'FROM' : 'TO'} ${other}`,
          side === 'from' ? 'in' : 'out',
          other,
        );
        if (id) return { id };
      }
      if (end.deadleg) return { stop: 'deadleg' };
    }
    return { stop: 'open' };
  };
  const usedNumbers = new Set<string>();
  const numberFor = (p: Plan) => {
    const share = new Map<string, { number: string; length: number }>();
    for (const e of p.edges) {
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
    return pick[1].number.slice(0, 40);
  };
  const valvesOn = (p: Plan): TraceValve[] => {
    const out: TraceValve[] = [];
    p.edges.forEach((e, i) => {
      const forward = p.verts[i] === e.a;
      out.push(...(forward ? e.chain.valves : [...e.chain.valves].reverse()));
    });
    return out;
  };
  let inlineCut = 0;
  for (const p of plans) {
    if (!chosen.has(p.id)) continue;
    const start = p.verts[0]!;
    const stop = p.verts[p.verts.length - 1]!;
    let from: string | undefined;
    if (p.parent) {
      from = teeOn(p.parent.line, p.parent.at, start) ?? undefined;
    } else {
      const ep = endOf(start, 'from');
      if (ep && 'id' in ep) from = ep.id;
      else {
        from = connector('OPEN END', 'in', p.edges[0]!.sheet.title) ?? undefined;
        if (from) {
          limits.push(
            `${p.edges[0]!.sheet.title}: ${lineName(p)} starts at an end that meets nothing drawn; the pid input starts it at a connector marked OPEN END.`,
          );
        }
      }
    }
    if (!from) {
      cuts.add('lines with no room for their start: left off');
      continue;
    }
    let to: string | undefined;
    let end: 'open' | undefined;
    let deadleg = p.deadleg;
    const onLine = placed.get(stop);
    if (onLine && onLine.line !== p.id && chosen.has(onLine.line)) {
      to = teeOn(onLine.line, onLine.at, stop) ?? undefined;
      if (!to) end = 'open';
    } else {
      const ep = endOf(stop, 'to');
      if (ep && 'id' in ep) to = ep.id;
      else if (ep?.stop === 'deadleg') deadleg = true;
      else end = 'open';
    }
    if (to && to === from) {
      to = undefined;
      end = 'open';
    }
    const valves = valvesOn(p);
    // Up to six inline items: named ones before guessed ones, in path order.
    const keep = new Set(
      [...valves.keys()]
        .sort((a, b) => Number(valves[a]!.guessed) - Number(valves[b]!.guessed) || a - b)
        .slice(0, PID_MAX.inline),
    );
    inlineCut += valves.length - keep.size;
    const inline = valves.filter((_, i) => keep.has(i)).map((v) => ({ type: v.type }));
    const number = numberFor(p);
    lines.push({
      id: p.id,
      ...(number ? { number } : {}),
      from,
      ...(to ? { to } : {}),
      ...(!to && end ? { end } : {}),
      ...(deadleg && !to ? { deadleg: true } : {}),
      ...(p.depth > 0 ? { weight: 'secondary' } : {}),
      ...(inline.length ? { inline } : {}),
    });
  }
  if (cuts.size) {
    limits.push(
      `the pid input is cut at the template limits (${[...cuts].join('; ')}); the trace JSON has every chain.`,
    );
  }
  if (inlineCut) {
    limits.push(
      `${inlineCut} valve${inlineCut === 1 ? '' : 's'} or reducer${inlineCut === 1 ? '' : 's'} past six on one line ${inlineCut === 1 ? 'is' : 'are'} left off the drawing (guessed ones first); the trace JSON has them on its chains.`,
    );
  }
  if (!lines.length) limits.push('nothing on the circuit could be drawn.');

  const crossings = m ? new Set(m.edges.map((e) => e.sheet.title)).size - 1 : 0;
  const description = m
    ? `Circuit ${circuit}: main line ${eqTag(m.from)} to ${eqTag(m.to)}${mainBasis ? ` (${mainBasis})` : ''}, ${round(m.edges.reduce((x, e) => x + e.length, 0))} drawing units across ${crossings + 1} sheet${crossings ? 's' : ''}, ${lines.length} lines drawn, deadlegs on caps.${linkAt.size ? ' Some sheet links are guesses, marked GUESS.' : ''}`
    : `Circuit ${circuit} traced from ${sheets.length} uploaded drawing${sheets.length === 1 ? '' : 's'}; no main line between two pieces of equipment was found.`;
  const drawnLines = new Set(lines.map((l) => l.id as string));
  return {
    template: 'pid',
    title: `Circuit ${circuit}`.slice(0, 80),
    description: description.slice(0, 300),
    equipment: [...equipment.values()],
    offpage,
    lines,
    tees: tees.filter(
      (t) => drawnLines.has(t.on) && lines.some((l) => l.from === t.id || l.to === t.id),
    ),
    circuits: [
      {
        id: tagId(`CIRCUIT-${circuit}`, 'CIRCUIT', CIRCUIT_ID),
        label: circuit.slice(0, 40),
        lines: lines.map((l) => l.id as string),
        equipment: [...equipment.keys()],
      },
    ],
  };

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
