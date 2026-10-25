/**
 * Draws a P&ID from checked data.
 *
 * 1. Columns: dagre ranks equipment left to right along the process flow.
 * 2. Baseline: vessels stand on a common baseline, machines (pumps,
 *    compressors) sit below it, exchangers and filters above; items in one
 *    column stack.
 * 3. Ports: each pipe leaves and enters on a real side of the symbol (liquid
 *    out of a vessel's bottom to its pump, discharge from the pump's
 *    tangential nozzle), spread 16px apart, on the drawn outline.
 * 4. Off-page connectors line up with the pipe they end, on the sheet edge.
 * 5. Pipes are routed on the grid (main lines first), never through a symbol
 *    or a label, never on top of each other.
 * 6. Valves and inline items go on the longest straight run of their pipe;
 *    the line number goes on a free stretch, above a horizontal run.
 * 7. Instruments: a bubble with `on` sits beside what it measures with a
 *    straight connection; controllers and other room instruments sit in a
 *    band above the process, over their loop.
 * 8. Signals are routed last, crossing pipes at right angles with a hop.
 */
import * as dagre from '@dagrejs/dagre';
import { GridRouter, NORMAL, STEP, type Side } from '../../runtime/grid-router.ts';
import {
  hopsFor,
  budgetWarnings,
  inflate,
  overlaps,
  polylineBox,
  qa,
  segmentHitsBox,
  segments,
  union,
  type Box,
  type QaItem,
} from '../../runtime/geom.ts';
import {
  el,
  endDir,
  arrowHead,
  num,
  orthoPath,
  simplify,
  textEl,
  type Pt,
} from '../../runtime/svg.ts';
import { PALETTE, SPACE, gridUp, resolveColour } from '../../runtime/style.ts';
import { measure, type Measurer } from '../../runtime/text.ts';
import { legendStrip, lineSwatch, boxSwatch, type LegendEntry } from '../../runtime/legend.ts';
import { slugify, svgDocument } from '../../runtime/export.ts';
import type { RenderResult } from '../../types.ts';
import { SERVICE_NAMES } from './profile.ts';
import {
  BAND,
  BUBBLE_R,
  OPC_SIZE,
  drawBubble,
  drawEquipment,
  drawInline,
  drawOffPage,
  equipmentSize,
  inlineExtent,
  inlineNotes,
  pumpCasing,
  signalMarks,
  signalStyle,
} from './symbols.ts';
import {
  PID_VERSION,
  type Equipment,
  type Toward,
  type InlineItem,
  type Instrument,
  type Line,
  type PidData,
  type Port,
  type SignalType,
} from './schema.ts';

const snap = (n: number) => Math.round(n / STEP) * STEP;
const snapOut = (n: number, dir: number) =>
  dir > 0 ? Math.ceil(n / STEP) * STEP : Math.floor(n / STEP) * STEP;

type Node = {
  id: string;
  eq?: Equipment;
  opc?: PidData['offpage'][number];
  w: number;
  h: number;
  box: Box;
};
type End = {
  line: Line;
  end: 'from' | 'to';
  node: string;
  side: Port;
  at?: Pt;
  stub?: Pt;
  join?: boolean;
};

/** The point on a symbol's drawn outline for a port on `side` at cross
 *  coordinate `c` (x for top/bottom, y for left/right). */
function surface(n: Node, side: Port, c: number): Pt {
  const b = n.box;
  const t = n.eq?.type;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const ell = (half: number, off: number) => Math.sqrt(Math.max(0, 1 - (off / half) ** 2));
  if ((t === 'vertical-vessel' || t === 'column') && (side === 'top' || side === 'bottom')) {
    const cap = b.w / 4;
    const k = ell(b.w / 2, c - cx);
    return { x: c, y: side === 'top' ? b.y + cap - cap * k : b.y + b.h - cap + cap * k };
  }
  if (t === 'horizontal-drum' && (side === 'left' || side === 'right')) {
    const cap = b.h / 4;
    const k = ell(b.h / 2, c - cy);
    return { x: side === 'left' ? b.x + cap - cap * k : b.x + b.w - cap + cap * k, y: c };
  }
  if ((t === 'centrifugal-pump' || t === 'pd-pump') && side === 'left') {
    const p = pumpCasing(b);
    return { x: p.cx - p.r * ell(p.r, c - p.cy), y: c };
  }
  if (t === 'exchanger' && (side === 'left' || side === 'right')) {
    const r = b.w / 2;
    const dx = r * ell(r, c - cy);
    return { x: side === 'left' ? cx - dx : cx + dx, y: c };
  }
  if (t === 'shell-tube-exchanger' && (side === 'left' || side === 'right')) {
    const r = b.h / 2;
    const dx = r - r * ell(r, c - cy);
    return { x: side === 'left' ? b.x + dx : b.x + b.w - dx, y: c };
  }
  if (t === 'tank' && side === 'top')
    return { x: c, y: b.y + 16 * Math.min(1, Math.abs(c - cx) / (b.w / 2)) };
  if (t === 'air-cooler' && side === 'top') return { x: c, y: b.y + 16 };
  switch (side) {
    case 'top':
      return { x: c, y: b.y };
    case 'bottom':
      return { x: c, y: b.y + b.h };
    case 'left':
      return { x: b.x, y: c };
    case 'right':
      return { x: b.x + b.w, y: c };
  }
}

/** Where on a side the ports gather, and how far they may spread. */
function sideRange(n: Node, side: Port): { anchor: number; lo: number; hi: number } {
  const b = n.box;
  const t = n.eq?.type;
  if (side === 'top' || side === 'bottom')
    return { anchor: b.x + b.w / 2, lo: b.x + 8, hi: b.x + b.w - 8 };
  let lo = b.y + 8;
  let hi = b.y + b.h - 8;
  let anchor = b.y + b.h / 2;
  if (t === 'vertical-vessel' || t === 'column') {
    lo = b.y + b.w / 4 + 8;
    hi = b.y + b.h - b.w / 4 - 8;
    // Feed in high, liquid out low.
    anchor = side === 'left' ? b.y + b.h * 0.3 : b.y + b.h * 0.7;
  } else if (t === 'centrifugal-pump' || t === 'pd-pump') {
    const p = pumpCasing(b);
    // Discharge on the tangential nozzle, suction at the casing centre.
    if (side === 'right') return { anchor: b.y + 8, lo: b.y + 8, hi: b.y + 8 };
    return { anchor: p.cy, lo: p.cy - 8, hi: p.cy + 8 };
  } else if (t === 'tank') {
    lo = b.y + 24;
    anchor = side === 'left' ? b.y + 32 : b.y + b.h - 16;
  } else if (t === 'air-cooler') {
    lo = b.y + 24;
    anchor = b.y + 32;
  }
  return { anchor, lo, hi };
}

/** The band an item is placed in: its type's, unless the data says `row`. */
function bandOf(e: Equipment): 'vessel' | 'machine' | 'inline' {
  if (e.row === 'base') return 'vessel';
  if (e.row === 'below') return 'machine';
  return BAND[e.type];
}

function defaultSide(nodes: Map<string, Node>, l: Line & { to: string }, end: 'from' | 'to'): Port {
  const me = nodes.get(end === 'from' ? l.from : l.to)!;
  const other = nodes.get(end === 'from' ? l.to : l.from)!;
  if (end === 'from' && l.fromPort) return l.fromPort;
  if (end === 'to' && l.toPort) return l.toPort;
  if (me.opc) return me.opc.direction === 'in' ? 'right' : 'left';
  const band = bandOf(me.eq!);
  if (end === 'from') {
    if (band === 'vessel' && other.eq && bandOf(other.eq) === 'machine') return 'bottom';
    return 'right';
  }
  return 'left';
}

const TOWARD_VEC: Record<Toward, Pt> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};
const TOWARD_SIDE: Record<Toward, Port> = {
  up: 'top',
  down: 'bottom',
  left: 'left',
  right: 'right',
};

/** A pipe cap: the D at the end of a line that stops, bulging along `dir`. */
function drawCap(tip: Pt, dir: Pt, stroke: string, width: number): string {
  const across = { x: -dir.y, y: dir.x };
  const a = { x: tip.x + across.x * 6, y: tip.y + across.y * 6 };
  const b = { x: tip.x - across.x * 6, y: tip.y - across.y * 6 };
  return el('path', {
    d: `M${num(a.x)} ${num(a.y)}L${num(b.x)} ${num(b.y)}A6 6 0 0 1 ${num(a.x)} ${num(a.y)}`,
    fill: 'none',
    stroke,
    'stroke-width': width,
    'data-part': 'cap',
  });
}

/** A bubble shrunk into a legend slot, without letters. */
function miniBubble(kind: Pick<Instrument, 'location' | 'display'>) {
  return (x: number, y: number) => {
    const inst: Instrument = { tag: 'legend', letters: '', loop: '', focal: false, ...kind };
    const cx = x + 14;
    const cy = y + 6;
    return el(
      'g',
      { transform: `translate(${cx} ${cy}) scale(0.3) translate(${-cx} ${-cy})` },
      drawBubble(inst, cx, cy, PALETTE.ink),
    );
  };
}

export function renderPid(data: PidData, m: Measurer): RenderResult {
  const P = data.profile;
  const warnings: string[] = [];

  // Plain lines run between two nodes (equipment, connectors). A branch has
  // a tee, an instrument or a free end at one end: it is routed after the
  // lines it hangs from, so data without tees takes the plain path only.
  const teeOf = new Map(data.tees.map((t) => [t.id, t]));
  const nodeIds = new Set([...data.equipment.map((e) => e.id), ...data.offpage.map((o) => o.id)]);
  const isPlain = (l: Line): l is Line & { to: string } =>
    !!l.to && nodeIds.has(l.from) && nodeIds.has(l.to);
  const plain = data.lines.filter(isPlain);
  const branches = data.lines.filter((l) => !isPlain(l));
  const lineOf = new Map(data.lines.map((l) => [l.id, l]));
  /** The node a branch end stands in for, for the column layout: upstream of
   *  a tee is its parent's start, downstream its parent's end. */
  const anchorNode = (
    id: string | undefined,
    role: 'from' | 'to',
    depth = 0,
  ): string | undefined => {
    if (!id || depth > 30) return undefined;
    if (nodeIds.has(id)) return id;
    const t = teeOf.get(id);
    if (!t) return undefined;
    const parent = lineOf.get(t.on)!;
    if (role === 'to' && parent.to) return anchorNode(parent.to, 'to', depth + 1);
    return anchorNode(parent.from, 'from', depth + 1);
  };
  // Connectors reached only through tees are placed once their tee is.
  const deferred = new Set(
    data.offpage
      .filter((o) => {
        const ls = data.lines.filter((l) => l.from === o.id || l.to === o.id);
        return (
          ls.length > 0 &&
          ls.every((l) => !isPlain(l) && teeOf.has((l.from === o.id ? l.to : l.from) ?? ''))
        );
      })
      .map((o) => o.id),
  );

  // ---------------------------------------------------------- 1. columns
  const nodes = new Map<string, Node>();
  for (const e of data.equipment) {
    const s = equipmentSize(e.type, P);
    nodes.set(e.id, { id: e.id, eq: e, w: s.w, h: s.h, box: { x: 0, y: 0, ...s } });
  }
  for (const o of data.offpage)
    nodes.set(o.id, {
      id: o.id,
      opc: o,
      w: OPC_SIZE.w,
      h: OPC_SIZE.h,
      box: { x: 0, y: 0, ...OPC_SIZE },
    });
  // Room along a pipe: its line number, then its valves, plus the stubs.
  const labelW = (l: Line) => (l.number ? gridUp(measure(m, l.number, 'sublabel') + 8) : 0);
  const itemsW = (l: Line) => l.inline.reduce((s, it) => s + 2 * inlineExtent(it).half + 24, 0);
  // A pipe that another one tees into needs room for the tee between its valves.
  const shared = (id: string | undefined) =>
    data.offpage.some((o) => o.id === id) &&
    data.lines.filter((x) => x.from === id || x.to === id).length > 1;
  // Each tee on a pipe takes a stretch of it too.
  const teeRoom = (l: Line) => 24 * data.tees.filter((t) => t.on === l.id).length;
  const need = (l: Line) =>
    labelW(l) + itemsW(l) + 72 + (shared(l.to) || shared(l.from) ? 56 : 0) + teeRoom(l);
  const ranksep = Math.min(480, Math.max(152, ...data.lines.map(need)));
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: 'LR', nodesep: 96, ranksep, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  // Utility connectors (every pipe on them a utility line) are placed beside
  // their equipment later, so they do not drag the process layout around.
  const utilityOpc = new Set(
    data.offpage
      .filter((o) => {
        const ls = data.lines.filter((l) => l.from === o.id || l.to === o.id);
        return ls.length > 0 && ls.every((l) => l.weight === 'secondary');
      })
      .map((o) => o.id),
  );
  for (const n of nodes.values())
    if (!utilityOpc.has(n.id)) g.setNode(n.id, { width: n.w, height: n.h });
  for (const l of plain) {
    if (l.weight === 'secondary' && (!nodes.get(l.from)!.eq || !nodes.get(l.to)!.eq)) continue;
    g.setEdge(l.from, l.to, { minlen: 1, weight: l.weight === 'main' ? 2 : 1 }, l.id);
  }
  // A branch ranks what it reaches after the start of the line it leaves.
  for (const l of branches) {
    const a = anchorNode(l.from, 'from');
    const b = anchorNode(l.to, 'to');
    if (!a || !b || a === b || !g.hasNode(a) || !g.hasNode(b)) continue;
    if (l.weight === 'secondary' && (!nodes.get(a)!.eq || !nodes.get(b)!.eq)) continue;
    // One ranking edge per pair (either way round): a branch only says what
    // it reaches lies downstream, and dagre fails on some of the cycles
    // repeated pairs make ("Not possible to find intersection").
    if (g.outEdges(a, b)?.length || g.outEdges(b, a)?.length) continue;
    g.setEdge(a, b, { minlen: 1, weight: 1 }, l.id);
  }
  dagre.layout(g);

  // ---------------------------------------------------------- 2. baseline
  const BASE = 0;
  // Columns from dagre's ranks, then the data's `column` hints.
  const rankXs = [
    ...new Set([...nodes.values()].filter((n) => n.eq).map((n) => snap(g.node(n.id).x ?? 0))),
  ].sort((a, b) => a - b);
  const columnX = (k: number) =>
    rankXs[k] ?? (rankXs[rankXs.length - 1] ?? 0) + (k - rankXs.length + 1) * ranksep;
  const cols = new Map<number, Node[]>();
  for (const n of nodes.values()) {
    if (!n.eq) continue;
    const key = n.eq.column !== undefined ? columnX(n.eq.column) : snap(g.node(n.id).x ?? 0);
    cols.set(key, [...(cols.get(key) ?? []), n]);
  }
  const colX = new Map<string, number>();
  for (const [cx, members] of cols) {
    members.sort((a, b) => (g.node(a.id).y ?? 0) - (g.node(b.id).y ?? 0));
    for (const n of members) colX.set(n.id, cx);
    const xOf = (n: Node) => snap(cx - n.w / 2);
    let bottom = BASE;
    for (const n of members.filter((n) => bandOf(n.eq!) === 'vessel').reverse()) {
      n.box = { x: xOf(n), y: bottom - n.h, w: n.w, h: n.h };
      bottom = n.box.y - 64;
    }
    let top = BASE + 72;
    for (const n of members.filter((n) => bandOf(n.eq!) === 'machine')) {
      n.box = { x: xOf(n), y: top, w: n.w, h: n.h };
      top += n.h + 64;
    }
  }
  // Exchangers, coolers and filters sit at the height of the pipes they
  // join: a condenser up by the column top, a reboiler down by its bottom.
  const sideOf = (l: Line & { to: string }, end: 'from' | 'to') => defaultSide(nodes, l, end);
  const portY = (n: Node, side: Port) =>
    side === 'top' ? n.box.y : side === 'bottom' ? n.box.y + n.box.h : sideRange(n, side).anchor;
  const fixed = new Set(data.equipment.filter((e) => bandOf(e) !== 'inline').map((e) => e.id));
  for (const e of data.equipment.filter((x) => bandOf(x) === 'inline')) {
    const n = nodes.get(e.id)!;
    const ys: number[] = [];
    for (const l of plain) {
      if (l.from === e.id && fixed.has(l.to)) ys.push(portY(nodes.get(l.to)!, sideOf(l, 'to')));
      if (l.to === e.id && fixed.has(l.from)) ys.push(portY(nodes.get(l.from)!, sideOf(l, 'from')));
    }
    const want = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : BASE - 96;
    const cx = colX.get(e.id) ?? 0;
    const room = (b: Box) => inflate({ ...b, h: b.h + 32 }, 24);
    const others = () =>
      [...fixed]
        .map((id) => nodes.get(id)!)
        .filter(
          (o) =>
            colX.get(o.id) === cx ||
            overlaps(room(o.box), room({ x: cx - n.w / 2, y: want - n.h / 2, w: n.w, h: n.h })),
        );
    let y = snap(want - n.h / 2);
    for (let k = 0; k < 80; k++) {
      const dy = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 8;
      const b = { x: snap(cx - n.w / 2), y: snap(want - n.h / 2) + dy, w: n.w, h: n.h };
      if (!others().some((o) => overlaps(room(o.box), room(b)))) {
        y = b.y;
        break;
      }
    }
    n.box = { x: snap(cx - n.w / 2), y, w: n.w, h: n.h };
    fixed.add(e.id);
  }

  // ---------------------------------------------------------- 3. ports
  const ends: End[] = [];
  for (const l of plain) {
    ends.push({ line: l, end: 'from', node: l.from, side: defaultSide(nodes, l, 'from') });
    ends.push({ line: l, end: 'to', node: l.to, side: defaultSide(nodes, l, 'to') });
  }
  // A second pipe to or from the same off-page connector joins the first
  // with a tee (a header), rather than crowding the connector.
  for (const o of data.offpage) {
    ends
      .filter((e) => e.node === o.id)
      .slice(1)
      .forEach((e) => (e.join = true));
  }
  // A branch's end at a node gets a port like any pipe (never a join).
  for (const l of branches) {
    for (const end of ['from', 'to'] as const) {
      const id = end === 'from' ? l.from : l.to;
      if (!id || !nodeIds.has(id)) continue;
      const n = nodes.get(id)!;
      const port = end === 'from' ? l.fromPort : l.toPort;
      const side: Port =
        port ??
        (end === 'from' && l.toward && !l.to
          ? TOWARD_SIDE[l.toward]
          : n.opc
            ? n.opc.direction === 'in'
              ? 'right'
              : 'left'
            : end === 'from'
              ? 'right'
              : 'left');
      ends.push({ line: l, end, node: id, side });
    }
  }
  const otherCentre = (e: End): Pt => {
    const other = e.end === 'from' ? e.line.to : e.line.from;
    const id =
      other && nodes.has(other) ? other : anchorNode(other, e.end === 'from' ? 'to' : 'from');
    const o = id ? nodes.get(id)!.box : nodes.get(e.node)!.box;
    return { x: o.x + o.w / 2, y: o.y + o.h / 2 };
  };
  const placePorts = (onlyEquipment: boolean, only?: string) => {
    const bySide = new Map<string, End[]>();
    for (const e of ends) {
      const n = nodes.get(e.node)!;
      if (onlyEquipment ? !n.eq : !n.opc) continue;
      if (e.join) continue;
      if (only !== undefined ? e.node !== only : deferred.has(e.node)) continue;
      bySide.set(`${e.node}|${e.side}`, [...(bySide.get(`${e.node}|${e.side}`) ?? []), e]);
    }
    for (const [k, list] of bySide) {
      const [id, side] = k.split('|') as [string, Port];
      const n = nodes.get(id)!;
      const horiz = side === 'top' || side === 'bottom';
      list.sort((a, b) =>
        horiz ? otherCentre(a).x - otherCentre(b).x : otherCentre(a).y - otherCentre(b).y,
      );
      const r = sideRange(n, side);
      list.forEach((e, i) => {
        let c = r.anchor + (i - (list.length - 1) / 2) * 16;
        c = Math.min(r.hi, Math.max(r.lo, c));
        c = snap(c);
        e.at = surface(n, side, c);
        const nrm = NORMAL[side];
        const b = n.box;
        const edge =
          side === 'top' ? b.y : side === 'bottom' ? b.y + b.h : side === 'left' ? b.x : b.x + b.w;
        const out = snapOut(edge + (horiz ? nrm.y : nrm.x) * 16, horiz ? nrm.y : nrm.x);
        e.stub = horiz ? { x: c, y: out } : { x: out, y: c };
      });
      if (list.length > 1 && (r.hi - r.lo) / 16 + 1 < list.length) {
        warnings.push(
          `layout: ${list.length} lines meet the ${side} of '${id}', more than fit 16px apart; give some a fromPort or toPort.`,
        );
      }
    }
  };
  placePorts(true);

  // ---------------------------------------------------------- labels of equipment
  const tagLabels: { id: string; box: Box; svg: string }[] = [];
  for (const e of data.equipment) {
    const b = nodes.get(e.id)!.box;
    const bottomPorts = ends
      .filter((x) => x.node === e.id && x.side === 'bottom')
      .map((x) => x.at!.x);
    const tw = Math.max(
      measure(m, e.id, 'nodeName'),
      e.service ? measure(m, e.service, 'sublabel') : 0,
    );
    const h = e.service ? 30 : 16;
    let x = b.x + b.w / 2;
    let anchor: 'middle' | 'start' = 'middle';
    // Keep clear of pipes leaving the bottom.
    if (bottomPorts.length) {
      x = Math.max(...bottomPorts) + 12;
      anchor = 'start';
    }
    const left = anchor === 'middle' ? x - tw / 2 : x;
    const top = b.y + b.h + 8;
    const colour = e.focal ? PALETTE.accent : PALETTE.ink;
    tagLabels.push({
      id: e.id,
      box: { x: left - 2, y: top, w: tw + 4, h },
      svg:
        textEl('nodeName', x, top + 12, e.id, { 'text-anchor': anchor, fill: colour }) +
        (e.service
          ? textEl('sublabel', x, top + 25, e.service, {
              'text-anchor': anchor,
              fill: PALETTE.soft,
            })
          : ''),
    });
  }

  // ---------------------------------------------------------- 4. off-page
  const eqBoxes = data.equipment.map((e) => nodes.get(e.id)!.box);
  const eqExtent = union(eqBoxes.length ? eqBoxes : [{ x: 0, y: 0, w: 0, h: 0 }]);
  const usedOpc: Box[] = [];
  for (const o of data.offpage) {
    if (deferred.has(o.id)) continue;
    const n = nodes.get(o.id)!;
    const e = ends.find((x) => x.node === o.id);
    const partner = e ? ends.find((x) => x.line === e.line && x !== e) : undefined;
    if (utilityOpc.has(o.id) && partner?.at) {
      // Beside its equipment: out along the port, far enough for the pipe's
      // line number and valves; above or below a top or bottom port.
      const p = partner.at;
      const run = need(e!.line);
      const into = o.direction === 'in';
      const cands: Box[] = [];
      for (let k = 0; k < 6; k++) {
        const far = run + k * 48;
        if (partner.side === 'left' || partner.side === 'right') {
          const x = partner.side === 'left' ? snap(p.x - far) - n.w : snap(p.x + far);
          cands.push({ x, y: p.y - n.h / 2, w: n.w, h: n.h });
        } else {
          // Above or below the port, on the flow side first, then the other.
          const dy = partner.side === 'top' ? -72 - k * 24 : 72 + k * 24;
          const near = into ? snap(p.x - run) - n.w : snap(p.x + run);
          const far = into ? snap(p.x + run) : snap(p.x - run) - n.w;
          cands.push(
            { x: near, y: snap(p.y + dy) - n.h / 2, w: n.w, h: n.h },
            { x: far, y: snap(p.y + dy) - n.h / 2, w: n.w, h: n.h },
          );
        }
      }
      // Clear of equipment and the tag label under each.
      const taken = [
        ...[...nodes.values()].filter((x) => x.eq).map((x) => inflate(x.box, 24)),
        ...tagLabels.map((t) => inflate(t.box, 8)),
      ];
      // Other connectors with the text line under them.
      const opcRoom = (u: Box) => inflate({ ...u, h: u.h + 20 }, 12);
      const box =
        cands.find(
          (c) =>
            !taken.some((t) => overlaps(t, opcRoom(c))) &&
            !usedOpc.some((u) => overlaps(opcRoom(u), opcRoom(c))),
        ) ?? cands[cands.length - 1]!;
      usedOpc.push(box);
      n.box = box;
      continue;
    }
    let y = partner?.at ? partner.at.y : BASE - 80;
    if (partner && (partner.side === 'top' || partner.side === 'bottom'))
      y = partner.at!.y + (partner.side === 'top' ? -56 : 56);
    // Far enough out for the pipe's line number and valves on one run.
    const gap = Math.max(
      160,
      ...data.lines.filter((l) => l.from === o.id || l.to === o.id).map(need),
    );
    const x =
      o.direction === 'in' ? snap(eqExtent.x - gap) - n.w : snap(eqExtent.x + eqExtent.w + gap);
    let box: Box = { x, y: y - n.h / 2, w: n.w, h: n.h };
    while (usedOpc.some((u) => overlaps(inflate(u, 8), box))) box = { ...box, y: box.y + 48 };
    usedOpc.push(box);
    n.box = box;
  }
  placePorts(false);

  // ---------------------------------------------------------- 5. pipes
  let allBoxes = [...nodes.values()].filter((n) => !deferred.has(n.id)).map((n) => n.box);
  // Branches may reach past the drawing (a stub, a connector off a tee).
  const world = inflate(
    union([...allBoxes, ...tagLabels.map((t) => t.box)]),
    branches.length ? 480 : 240,
  );
  const pipes = new GridRouter(world);
  for (const n of nodes.values()) if (!deferred.has(n.id)) pipes.block(inflate(n.box, 8));
  for (const t of tagLabels) pipes.block(inflate(t.box, 4));
  const routed = new Map<string, Pt[]>();
  const joins: Pt[] = [];
  const joined = new Set<string>();
  type Placed = { item: InlineItem; at: Pt; dir: Pt; box: Box; line: string };
  const placed: Placed[] = [];
  const notes: { box: Box; svg: string; id: string }[] = [];
  const isH = (s: [Pt, Pt]) => Math.abs(s[0].y - s[1].y) < 0.01;
  const len = (s: [Pt, Pt]) => Math.abs(s[1].x - s[0].x) + Math.abs(s[1].y - s[0].y);

  /**
   * A tee on the pipe already at `node`. Walking in from that end, the first
   * grid point clear of the host's valves and corners; joining INTO a pipe
   * that carries a control valve, the tee goes upstream of it (a header
   * feeds the control valve).
   */
  const teeOn = (node: string, end: 'from' | 'to'): { at: Pt; along: Pt } | null => {
    const host = data.lines.find(
      (x) => routed.has(x.id) && (end === 'to' ? x.to === node : x.from === node),
    );
    if (!host) return null;
    const pts = end === 'to' ? [...routed.get(host.id)!].reverse() : routed.get(host.id)!;
    const items = placed.filter((p) => p.line === host.id);
    let walked = 0;
    let mustPass = 0;
    if (end === 'to') {
      for (const it of items.filter((p) => p.item.type === 'control')) {
        // Distance from the end to this control valve, along the pipe.
        let d = 0;
        for (const [a, b] of segments(pts)) {
          if (segmentHitsBox(a, b, { x: it.at.x - 1, y: it.at.y - 1, w: 2, h: 2 }, 0)) {
            d += Math.abs(it.at.x - a.x) + Math.abs(it.at.y - a.y);
            break;
          }
          d += len([a, b]);
        }
        mustPass = Math.max(mustPass, d + 28);
      }
    }
    for (const [a, b] of segments(pts)) {
      const L0 = len([a, b]);
      const d = { x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y) };
      for (let k = 24; k <= L0 - 16; k += 8) {
        if (walked + k < Math.max(24, mustPass)) continue;
        const p = { x: snap(a.x + d.x * k), y: snap(a.y + d.y * k) };
        if (items.some((it) => Math.abs(it.at.x - p.x) + Math.abs(it.at.y - p.y) < 24)) continue;
        return { at: p, along: d };
      }
      walked += L0;
    }
    return null;
  };

  const routeLine = (l: Line) => {
    const f = ends.find((e) => e.line === l && e.end === 'from')!;
    const t = ends.find((e) => e.line === l && e.end === 'to')!;
    const fJoin = f.join ? teeOn(f.node, 'from') : null;
    const tJoin = t.join ? teeOn(t.node, 'to') : null;
    const fromPt = fJoin?.at ?? f.stub!;
    const toPt = tJoin?.at ?? t.stub!;
    const into = NORMAL[t.side];
    // A branch leaves, and a join arrives, square to the host pipe.
    const square = (along: Pt, from: Pt, to: Pt): Pt =>
      along.x !== 0
        ? { x: 0, y: Math.sign(to.y - from.y) || 1 }
        : { x: Math.sign(to.x - from.x) || 1, y: 0 };
    const fromDir = fJoin ? square(fJoin.along, fJoin.at, toPt) : NORMAL[f.side];
    const toDir = tJoin ? square(tJoin.along, fromPt, tJoin.at) : { x: -into.x, y: -into.y };
    const path = pipes.route(fromPt, fromDir, toPt, toDir);
    const head = fJoin ? [] : [f.at!];
    const tail = tJoin ? [] : [t.at!];
    let pts: Pt[];
    if (path) pts = simplify([...head, ...path, ...tail]);
    else {
      warnings.push(
        `layout: no clear route for line '${l.id}'; drawn direct. Try other ports or split the sheet.`,
      );
      pts = simplify([...head, fromPt, { x: toPt.x, y: fromPt.y }, toPt, ...tail]);
    }
    if (fJoin) joins.push(fJoin.at);
    if (tJoin) {
      joins.push(tJoin.at);
      joined.add(l.id);
    }
    pipes.occupy(pts);
    routed.set(l.id, pts);
  };

  // ---------------------------------------------------------- 6. inline items
  const placeItems = (l: Line) => {
    if (!l.inline.length) return;
    const segs = segments(routed.get(l.id)!);
    const room = itemsW(l) + 24;
    const withLabel = room + labelW(l) + 16;
    const seg =
      segs.filter((s) => isH(s) && len(s) >= withLabel).sort((a, b) => len(b) - len(a))[0] ??
      segs.filter((s) => isH(s) && len(s) >= room).sort((a, b) => len(b) - len(a))[0] ??
      [...segs].sort((a, b) => len(b) - len(a))[0]!;
    const vertical = !isH(seg);
    const n = l.inline.length;
    // Leave the upstream end of the run free for the line number.
    const reserve = !vertical && l.number && len(seg) >= withLabel ? labelW(l) + 16 : 0;
    const segLen = len(seg);
    const dir = { x: Math.sign(seg[1].x - seg[0].x), y: Math.sign(seg[1].y - seg[0].y) };
    // On a pipe that will take a tee, keep a 56px slot before its control
    // valve so the header joins between the check valve and the control valve.
    const teeSlot = shared(l.to) && l.inline.some((it) => it.type === 'control') ? 56 : 0;
    const firstControl = l.inline.findIndex((it) => it.type === 'control');
    const others = [...routed].filter(([id]) => id !== l.id).flatMap(([, p]) => segments(p));
    l.inline.forEach((it, i) => {
      const span = segLen - reserve - teeSlot;
      const t0 =
        reserve + (span * (i + 1)) / (n + 1) + (teeSlot && i >= firstControl ? teeSlot : 0);
      const ex = inlineExtent(it);
      const boxAt = (at: Pt) =>
        vertical
          ? { x: at.x - ex.below, y: at.y - ex.half, w: ex.above + ex.below, h: 2 * ex.half }
          : { x: at.x - ex.half, y: at.y - ex.above, w: 2 * ex.half, h: ex.above + ex.below };
      const pointAt = (t: number) => {
        const raw = { x: seg[0].x + dir.x * t, y: seg[0].y + dir.y * t };
        return vertical ? { x: raw.x, y: snap(raw.y) } : { x: snap(raw.x), y: raw.y };
      };
      // Slide along the run, nearest first, to keep the symbol (and its
      // actuator) off other pipes and other symbols.
      let at = pointAt(t0);
      for (let k = 0; k < 24; k++) {
        const t = t0 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 8;
        if (t < 16 || t > segLen - 16) continue;
        const cand = pointAt(t);
        const b = boxAt(cand);
        if (others.some(([a, z]) => segmentHitsBox(a, z, b, 0))) continue;
        if (placed.some((p) => overlaps(inflate(p.box, 4), b))) continue;
        at = cand;
        break;
      }
      const box = boxAt(at);
      placed.push({ item: it, at, dir, box, line: l.id });
      const id = it.tag ?? `${l.id} ${it.type}`;
      const extra = inlineNotes(it, P);
      if (it.type === 'control' && it.tag) {
        // Tag beside the actuator, failure position under the body.
        const tx = vertical ? at.x + ex.above + 4 : at.x + 14;
        const ty = vertical ? at.y - 8 : at.y - 18;
        const tw = measure(m, it.tag, 'sublabel');
        notes.push({
          id,
          box: { x: tx - 2, y: ty - 9, w: tw + 4, h: 12 },
          svg: textEl('sublabel', tx, ty, it.tag, {
            fill: it.focal ? PALETTE.accent : PALETTE.ink,
          }),
        });
        if (extra.length) {
          const s = extra.join(' ');
          const sx = vertical ? at.x + ex.above + 4 : at.x;
          const sy = vertical ? at.y + 8 : at.y + 18;
          const sw = measure(m, s, 'eyebrow');
          notes.push({
            id: `${id} note`,
            box: { x: vertical ? sx - 2 : sx - sw / 2 - 2, y: sy - 8, w: sw + 4, h: 10 },
            svg: textEl('eyebrow', sx, sy, s, {
              'text-anchor': vertical ? 'start' : 'middle',
              fill: PALETTE.muted,
            }),
          });
        }
      } else if (it.tag || extra.length) {
        const s = [it.tag, ...extra].filter(Boolean).join(' ');
        const sw = measure(m, s, 'sublabel');
        const sx = vertical ? at.x + 12 : at.x;
        const sy = vertical ? at.y + 3 : at.y + ex.below + 10;
        notes.push({
          id,
          box: { x: vertical ? sx - 2 : sx - sw / 2 - 2, y: sy - 9, w: sw + 4, h: 12 },
          svg: textEl('sublabel', sx, sy, s, {
            'text-anchor': vertical ? 'start' : 'middle',
            fill: PALETTE.ink,
          }),
        });
      }
    });
  };

  // Pipes to equipment first (main, then utility), with their valves; then
  // the pipes that join them, so a tee can keep clear of those valves.
  const isJoin = (l: Line) => ends.some((e) => e.line === l && e.join);
  const byWeight = (a: Line, b: Line) => (a.weight === b.weight ? 0 : a.weight === 'main' ? -1 : 1);
  for (const l of plain.filter((x) => !isJoin(x)).sort(byWeight)) routeLine(l);
  for (const l of plain.filter((x) => !isJoin(x))) placeItems(l);
  for (const l of plain.filter(isJoin).sort(byWeight)) {
    routeLine(l);
    placeItems(l);
  }

  // ---------------------------------------------------------- 6b. tees and branches
  // A tee is a grid point ON its parent's routed pipe, chosen after the
  // parent and its valves are down, so the junction dot can only sit on the
  // line. Branches are routed in depth order (a branch off a branch after
  // its parent) on the same grid, so they keep out of equipment, labels and
  // other pipes like any pipe.
  type TeePt = { at: Pt; along: Pt };
  const teePts = new Map<string, TeePt>();
  const tipBubbles = new Map<string, Pt>();
  const capEnds = new Map<string, { tip: Pt; d: Pt }>();
  const manhattan = (a: Pt, b: Pt) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  const branchDepth = new Map<string, number>();
  const depthOf = (l: Line, guard = 0): number => {
    const known = branchDepth.get(l.id);
    if (known !== undefined) return known;
    let d = 0;
    for (const e of [l.from, l.to]) {
      const t = e ? teeOf.get(e) : undefined;
      if (t && guard < 30) d = Math.max(d, depthOf(lineOf.get(t.on)!, guard + 1) + 1);
    }
    branchDepth.set(l.id, d);
    return d;
  };
  /** Pick a tee's spot: the best-scoring clear grid point on the parent
   *  pipe that `accept` takes (a stub needs room beside it), else the best. */
  const teeFor = (id: string, target?: Pt, spacing = 0, accept?: (c: TeePt) => boolean): TeePt => {
    const have = teePts.get(id);
    if (have) return have;
    const t = teeOf.get(id)!;
    const pts = routed.get(t.on)!;
    const items = placed.filter((p) => p.line === t.on);
    const siblings = [...teePts].filter(([k]) => teeOf.get(k)!.on === t.on).map(([, v]) => v.at);
    const others = [...routed].filter(([k]) => k !== t.on).flatMap(([, p]) => segments(p));
    const total = segments(pts).reduce((s, sg) => s + len(sg), 0);
    const cands: { at: Pt; along: Pt; score: number }[] = [];
    let walked = 0;
    for (const sg of segments(pts)) {
      const [a, b] = sg;
      const L0 = len(sg);
      const d = { x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y) };
      // Clear of the corners at both ends of the run.
      for (let k = 24; k <= L0 - 24; k += 8) {
        const p =
          d.x !== 0 ? { x: snap(a.x + d.x * k), y: a.y } : { x: a.x, y: snap(a.y + d.y * k) };
        const dot = { x: p.x - 4, y: p.y - 4, w: 8, h: 8 };
        if (items.some((it) => overlaps(inflate(it.box, 6), dot))) continue;
        if (siblings.some((q) => manhattan(q, p) < 32)) continue;
        if (pipes.isBlocked(p)) continue;
        if (others.some(([u, v]) => segmentHitsBox(u, v, inflate(dot, 4), 0))) continue;
        const along = walked + manhattan(a, p);
        const score =
          t.at !== undefined
            ? Math.abs(along - t.at * total)
            : t.near === 'from'
              ? along
              : t.near === 'to'
                ? total - along
                : spacing && siblings.length
                  ? Math.min(...siblings.map((q) => Math.abs(manhattan(q, p) - spacing)))
                  : target
                    ? manhattan(p, target)
                    : Math.abs(along - total / 2);
        cands.push({ at: p, along: d, score });
      }
      walked += L0;
    }
    cands.sort((x, y) => x.score - y.score);
    let pick: TeePt | undefined = (accept && cands.find(accept)) || cands[0];
    if (!pick) {
      // No clear spot: the middle of the longest run, still on the line.
      const sg = [...segments(pts)].sort((x, y) => len(y) - len(x))[0]!;
      const d = { x: Math.sign(sg[1].x - sg[0].x), y: Math.sign(sg[1].y - sg[0].y) };
      const at =
        d.x !== 0
          ? { x: snap((sg[0].x + sg[1].x) / 2), y: sg[0].y }
          : { x: sg[0].x, y: snap((sg[0].y + sg[1].y) / 2) };
      pick = { at, along: d };
      warnings.push(
        `layout: no clear spot on line '${t.on}' for tee '${id}' (valves, corners or crossings in the way); it sits mid-run. Move it with near: 'from' or 'to', or give the line fewer valves.`,
      );
    }
    const out = { at: pick.at, along: pick.along };
    teePts.set(id, out);
    return out;
  };
  const square = (along: Pt, from: Pt, to: Pt): Pt =>
    along.x !== 0
      ? { x: 0, y: Math.sign(to.y - from.y) || 1 }
      : { x: Math.sign(to.x - from.x) || 1, y: 0 };
  /** A connector reached only through a tee: on the sheet edge, level with
   *  the tee (or a step off a horizontal parent). */
  const placedLate = new Set<string>();
  /** Where a connector reached through a tee stands: the sheet edge. */
  const edgeX = (id: string, l: Line) => {
    const n = nodes.get(id)!;
    const gap = Math.max(160, need(l));
    return n.opc!.direction === 'in'
      ? snap(eqExtent.x - gap) - n.w
      : snap(eqExtent.x + eqExtent.w + gap);
  };
  const placeDeferred = (id: string, T: TeePt, l: Line) => {
    if (!deferred.has(id) || placedLate.has(id)) return;
    placedLate.add(id);
    const n = nodes.get(id)!;
    // Off a horizontal run: a step down (or up) and straight on into it.
    // Off a vertical run: level with the tee, on the sheet edge.
    const x =
      T.along.x === 0
        ? edgeX(id, l)
        : n.opc!.direction === 'in'
          ? snap(T.at.x - 48) - n.w
          : snap(T.at.x + 48);
    const ys =
      T.along.x !== 0 ? [56, -56, 104, -104, 152, -152].map((dy) => T.at.y + dy) : [T.at.y];
    const fits = (b: Box) =>
      !usedOpc.some((u) => overlaps(inflate(u, 8), b)) &&
      ![...nodes.values()].some((x) => x.eq && overlaps(inflate(x.box, 16), b));
    const at = (y: number): Box => ({ x, y: snap(y) - n.h / 2, w: n.w, h: n.h });
    let box = ys.map(at).find(fits) ?? at(ys[0]!);
    for (let k = 0; k < 40 && !fits(box); k++) box = { ...box, y: box.y + 48 };
    n.box = box;
    usedOpc.push(box);
    pipes.block(inflate(box, 8));
    placePorts(false, id);
  };
  /** Is a straight run from `from` (leaving it) to `tip` clear of symbols,
   *  labels, valves and every pipe? */
  const runClear = (from: Pt, tip: Pt): boolean => {
    const d = { x: Math.sign(tip.x - from.x), y: Math.sign(tip.y - from.y) };
    const n = manhattan(from, tip) / STEP;
    for (let k = 1; k <= n; k++) {
      if (pipes.isBlocked({ x: from.x + d.x * k * STEP, y: from.y + d.y * k * STEP })) return false;
    }
    const a = { x: from.x + d.x * 8, y: from.y + d.y * 8 };
    const run = {
      x: Math.min(a.x, tip.x) - 3,
      y: Math.min(a.y, tip.y) - 3,
      w: Math.abs(a.x - tip.x) + 6,
      h: Math.abs(a.y - tip.y) + 6,
    };
    if (
      [...routed.values()].some((p) => segments(p).some(([u, v]) => segmentHitsBox(u, v, run, 0)))
    )
      return false;
    return ![...placed, ...notes].some((p) => overlaps(p.box, run, 0));
  };
  const endFree = (b: Box): boolean =>
    ![...nodes.values()].some(
      (x) => (!deferred.has(x.id) || placedLate.has(x.id)) && overlaps(inflate(x.box, 8), b),
    ) &&
    !tagLabels.some((t) => overlaps(t.box, b)) &&
    ![...placed, ...notes].some((p) => overlaps(p.box, b)) &&
    ![...tipBubbles.values()].some((c) => overlaps(inflate(boxAround(c, BUBBLE_R), 4), b)) &&
    ![...routed.values()].some((p) => segments(p).some(([u, v]) => segmentHitsBox(u, v, b, 0)));
  const boxAround = (c: Pt, r: number): Box => ({ x: c.x - r, y: c.y - r, w: 2 * r, h: 2 * r });

  /** A line that stops (a stub, a cap, a dead leg) or ends at a bubble: a
   *  straight run square off its tee (or out of its port), on the first
   *  side with room. */
  const routeStub = (l: Line, fe: End | undefined) => {
    const inst = l.to && !nodeIds.has(l.to) && !teeOf.has(l.to) ? l.to : undefined;
    const lengthFor = (d: Pt) =>
      gridUp(Math.max(48, itemsW(l) + 32, d.y === 0 && l.number ? labelW(l) + 40 : 0));
    const endBox = (tip: Pt, d: Pt): Box =>
      inst
        ? boxAround({ x: tip.x + d.x * BUBBLE_R, y: tip.y + d.y * BUBBLE_R }, BUBBLE_R + 4)
        : boxAround(tip, 8);
    const fit = (S: Pt, dirs: Pt[]): { tip: Pt; d: Pt } | undefined => {
      for (const d of dirs) {
        for (const extra of [0, 24, 48, 96]) {
          const L0 = lengthFor(d) + extra;
          const tip = { x: S.x + d.x * L0, y: S.y + d.y * L0 };
          if (runClear(S, tip) && endFree(endBox(tip, d))) return { tip, d };
        }
      }
      return undefined;
    };
    // Off a tee: square to the parent run, the way `toward` says, else the
    // first side with room.
    // `toward` along the parent run cannot be drawn: square to it instead.
    const alongParent = (T: TeePt) =>
      !!l.toward && (TOWARD_VEC[l.toward].x !== 0) === (T.along.x !== 0);
    const dirsAt = (T: TeePt): Pt[] => {
      const both =
        T.along.x !== 0 ? [TOWARD_VEC.up, TOWARD_VEC.down] : [TOWARD_VEC.right, TOWARD_VEC.left];
      return !l.toward || alongParent(T) ? both : [TOWARD_VEC[l.toward]];
    };
    let S: Pt;
    let head: Pt[] = [];
    let dirs: Pt[];
    if (fe) {
      S = fe.stub!;
      head = [fe.at!];
      dirs = [NORMAL[fe.side]];
    } else {
      const T = teeFor(l.from, undefined, 0, (c) => !!fit(c.at, dirsAt(c)));
      S = T.at;
      dirs = dirsAt(T);
      if (alongParent(T))
        warnings.push(
          `layout: line '${l.id}' cannot leave tee '${l.from}' ${l.toward}, along its parent line; it leaves square to it. Use ${dirs[0]!.y !== 0 ? "'up' or 'down'" : "'left' or 'right'"}.`,
        );
    }
    let chosen = fit(S, dirs);
    if (!chosen && l.toward && !fe) {
      // No room the way the data asks: the other side, said aloud.
      const v = TOWARD_VEC[l.toward];
      chosen = fit(
        S,
        [TOWARD_VEC.up, TOWARD_VEC.down, TOWARD_VEC.left, TOWARD_VEC.right].filter(
          (d) => d.x === -v.x && d.y === -v.y,
        ),
      );
      if (chosen)
        warnings.push(
          `layout: no room for line '${l.id}' ${l.toward} of tee '${l.from}'; it leaves the other way.`,
        );
    }
    if (!chosen) {
      const d = dirs[0]!;
      const L0 = lengthFor(d);
      chosen = { tip: { x: S.x + d.x * L0, y: S.y + d.y * L0 }, d };
      warnings.push(
        `layout: no clear room for line '${l.id}' off '${l.from}'; it is drawn ${l.toward ?? 'square to its parent'} anyway. Try another toward, or move the tee with near.`,
      );
    }
    const pts = simplify([...head, S, chosen.tip]);
    pipes.occupy(pts);
    routed.set(l.id, pts);
    if (inst) {
      const c = {
        x: chosen.tip.x + chosen.d.x * BUBBLE_R,
        y: chosen.tip.y + chosen.d.y * BUBBLE_R,
      };
      tipBubbles.set(inst, c);
      pipes.block(boxAround(c, BUBBLE_R + 4));
    } else {
      if (l.end === 'cap') capEnds.set(l.id, chosen);
      pipes.block(boxAround(chosen.tip, 8));
    }
  };

  /** A branch to equipment, a connector or another tee: routed on the grid
   *  from its tee, leaving (and joining) square to the parent pipe. */
  const routeBranch = (l: Line) => {
    const fe = ends.find((e) => e.line === l && e.end === 'from');
    const te = ends.find((e) => e.line === l && e.end === 'to');
    const toTee = !!l.to && teeOf.has(l.to);
    if (!te && !toTee) return routeStub(l, fe);
    // A connector reached through a tee is placed by the tee first.
    if (te && deferred.has(te.node) && teeOf.has(l.from))
      placeDeferred(te.node, teeFor(l.from, { x: edgeX(te.node, l), y: BASE }), l);
    if (fe && deferred.has(fe.node) && toTee)
      placeDeferred(fe.node, teeFor(l.to!, { x: edgeX(fe.node, l), y: BASE }), l);
    let fromPt: Pt;
    let fromDir: Pt;
    let head: Pt[] = [];
    let fromT: TeePt | undefined;
    if (fe) {
      fromPt = fe.stub!;
      fromDir = NORMAL[fe.side];
      head = [fe.at!];
    } else {
      fromT = teeFor(l.from, te?.stub);
      fromPt = fromT.at;
      fromDir = { x: 0, y: 1 }; // set below, once the far end is known
    }
    let toPt: Pt;
    let toDir: Pt;
    let tail: Pt[] = [];
    if (te) {
      toPt = te.stub!;
      const into = NORMAL[te.side];
      toDir = { x: -into.x, y: -into.y };
      tail = [te.at!];
    } else {
      // Into a tee: a bypass back onto the same line keeps its length clear.
      const sameParent = fromT && teeOf.get(l.from)!.on === teeOf.get(l.to!)!.on;
      const T = teeFor(l.to!, fromPt, sameParent ? Math.max(96, itemsW(l) + 48) : 0);
      toPt = T.at;
      toDir = square(T.along, fromPt, T.at);
    }
    if (fromT) fromDir = square(fromT.along, fromT.at, toPt);
    // Leaving and joining on one side of a line: down off it, up back into it.
    if (!te && fromT && Math.sign(toPt.y - fromPt.y) === 0 && fromDir.y !== 0)
      toDir = { x: 0, y: -fromDir.y };
    if (!te && fromT && Math.sign(toPt.x - fromPt.x) === 0 && fromDir.x !== 0)
      toDir = { x: -fromDir.x, y: 0 };
    const path = pipes.route(fromPt, fromDir, toPt, toDir);
    let pts: Pt[];
    if (path) pts = simplify([...head, ...path, ...tail]);
    else {
      warnings.push(
        `layout: no clear route for line '${l.id}'; drawn direct. Try other ports, move its tee with near, or split the sheet.`,
      );
      pts = simplify([...head, fromPt, { x: toPt.x, y: fromPt.y }, toPt, ...tail]);
    }
    if (toTee) joined.add(l.id);
    pipes.occupy(pts);
    routed.set(l.id, pts);
  };

  // Branches keep off the valves and their notes, as well as the symbols.
  if (branches.length) for (const b of [...placed, ...notes]) pipes.block(b.box);
  for (const l of [...branches].sort((a, b) => depthOf(a) - depthOf(b) || byWeight(a, b))) {
    const before = placed.length;
    routeBranch(l);
    placeItems(l);
    for (const it of placed.slice(before)) pipes.block(it.box);
  }
  const usedTees = data.tees.filter((t) => teePts.has(t.id));
  if (placedLate.size) allBoxes = [...nodes.values()].map((n) => n.box);

  // A dead leg carries DL beside its far end.
  for (const l of data.lines) {
    if (!l.deadleg) continue;
    const segs = segments(routed.get(l.id)!).reverse();
    const s = segs.find((x) => len(x) >= 24) ?? segs[0]!;
    const h = isH(s);
    const d = { x: Math.sign(s[1].x - s[0].x), y: Math.sign(s[1].y - s[0].y) };
    const c = { x: s[1].x - d.x * 16, y: s[1].y - d.y * 16 };
    const tw = measure(m, 'DL', 'sublabel') + 4;
    const cands: Box[] = h
      ? [
          { x: c.x - tw / 2, y: c.y - 20, w: tw, h: 12 },
          { x: c.x - tw / 2, y: c.y + 8, w: tw, h: 12 },
        ]
      : [
          { x: c.x + 8, y: c.y - 6, w: tw, h: 12 },
          { x: c.x - 8 - tw, y: c.y - 6, w: tw, h: 12 },
        ];
    const box = cands.find((b) => endFree(b)) ?? cands[0]!;
    notes.push({
      id: `${l.id} DL`,
      box,
      svg: textEl('sublabel', box.x + 2, box.y + 9, 'DL', { fill: PALETTE.ink }),
    });
  }
  // A line's note (an honesty mark) beside the middle of its longest run.
  for (const l of data.lines) {
    if (!l.note) continue;
    const segs = segments(routed.get(l.id)!);
    const s = [...segs].sort((a, b) => len(b) - len(a))[0]!;
    const h = isH(s);
    const c = { x: (s[0].x + s[1].x) / 2, y: (s[0].y + s[1].y) / 2 };
    const tw = measure(m, l.note, 'sublabel') + 4;
    const cands: Box[] = h
      ? [
          { x: c.x - tw / 2, y: c.y + 8, w: tw, h: 12 },
          { x: c.x - tw / 2, y: c.y - 20, w: tw, h: 12 },
        ]
      : [
          { x: c.x + 8, y: c.y - 6, w: tw, h: 12 },
          { x: c.x - 8 - tw, y: c.y - 6, w: tw, h: 12 },
        ];
    const box = cands.find((b) => endFree(b)) ?? cands[0]!;
    notes.push({
      id: `${l.id} note`,
      box,
      svg: textEl('sublabel', box.x + 2, box.y + 9, l.note, { fill: PALETTE.ink }),
    });
  }
  // The junction dot is the tee: it must sit on its parent pipe.
  for (const t of usedTees) {
    const at = teePts.get(t.id)!.at;
    const on = segments(routed.get(t.on)!).some(([a, b]) =>
      Math.abs(a.y - b.y) < 0.01
        ? Math.abs(at.y - a.y) < 0.5 && at.x >= Math.min(a.x, b.x) && at.x <= Math.max(a.x, b.x)
        : Math.abs(at.x - a.x) < 0.5 && at.y >= Math.min(a.y, b.y) && at.y <= Math.max(a.y, b.y),
    );
    if (!on) warnings.push(`layout: tee '${t.id}' is off its line '${t.on}'.`);
  }

  // ---------------------------------------------------------- line numbers
  const lineLabels: { id: string; box: Box; svg: string }[] = [];
  const blockers = (): Box[] => [
    ...[...nodes.values()].map((n) => inflate(n.box, 4)),
    ...tagLabels.map((t) => t.box),
    ...placed.map((p) => p.box),
    ...notes.map((n) => n.box),
    ...lineLabels.map((l) => l.box),
  ];
  for (const l of data.lines) {
    if (!l.number) continue;
    const segs = segments(routed.get(l.id)!);
    const tw = gridUp(measure(m, l.number, 'sublabel') + 8);
    const th = 12;
    const cands = [
      ...segs.filter(isH).sort((a, b) => len(b) - len(a)),
      ...segs.filter((s) => !isH(s)).sort((a, b) => len(b) - len(a)),
    ];
    let chosen: { box: Box; x: number; y: number; anchor: 'middle' | 'end' } | null = null;
    for (const s of cands) {
      const h = isH(s);
      const lo = h ? Math.min(s[0].x, s[1].x) : Math.min(s[0].y, s[1].y);
      const hi = h ? Math.max(s[0].x, s[1].x) : Math.max(s[0].y, s[1].y);
      const mid = (lo + hi) / 2;
      for (let off = 0; off <= (hi - lo) / 2; off += 8) {
        for (const c of off ? [mid - off, mid + off] : [mid]) {
          const box = h
            ? { x: c - tw / 2, y: s[0].y - 6 - th, w: tw, h: th }
            : { x: s[0].x - 8 - tw, y: c - th / 2, w: tw, h: th };
          if (
            h ? box.x < lo + 8 || box.x + box.w > hi - 8 : box.y < lo + 8 || box.y + box.h > hi - 8
          )
            continue;
          if (blockers().some((b) => overlaps(b, box, 0))) continue;
          if (
            [...routed.values()].some((p) =>
              segments(p).some(([a, b]) => segmentHitsBox(a, b, box, 0)),
            )
          )
            continue;
          chosen = h
            ? { box, x: c, y: s[0].y - 9, anchor: 'middle' }
            : { box, x: s[0].x - 12, y: c + 3, anchor: 'end' };
          break;
        }
        if (chosen) break;
      }
      if (chosen) break;
    }
    if (!chosen) {
      warnings.push(
        `layout: no free stretch on line '${l.id}' for its line number; it is drawn on the first run.`,
      );
      const s = segs[0]!;
      const c = { x: (s[0].x + s[1].x) / 2, y: (s[0].y + s[1].y) / 2 };
      chosen = {
        box: { x: c.x - tw / 2, y: c.y - 6 - th, w: tw, h: th },
        x: c.x,
        y: c.y - 9,
        anchor: 'middle',
      };
    }
    lineLabels.push({
      id: l.id,
      box: chosen.box,
      svg:
        el('rect', {
          x: chosen.box.x,
          y: chosen.box.y,
          width: chosen.box.w,
          height: chosen.box.h,
          fill: PALETTE.paper,
        }) +
        textEl('sublabel', chosen.anchor === 'end' ? chosen.x : chosen.x, chosen.y, l.number, {
          'text-anchor': chosen.anchor,
          fill: PALETTE.ink,
        }),
    });
  }

  // ---------------------------------------------------------- 7. instruments
  const bubbles = new Map<string, Pt>(tipBubbles);
  const connections: { id: string; pts: Pt[]; ends: string[] }[] = [];
  const bubbleBox = (c: Pt) => ({
    x: c.x - BUBBLE_R - 4,
    y: c.y - BUBBLE_R - 4,
    w: 2 * BUBBLE_R + 8,
    h: 2 * BUBBLE_R + 8,
  });
  const pipeHits = (b: Box) =>
    [...routed.values()].some((p) => segments(p).some(([a, c]) => segmentHitsBox(a, c, b, 0)));
  const free = (b: Box) =>
    !blockers().some((x) => overlaps(x, b, 0)) &&
    ![...bubbles.values()].some((c) => overlaps(bubbleBox(c), b, 0)) &&
    !pipeHits(b);
  const segFree = (a: Pt, b: Pt, except: string[]) =>
    ![...nodes.values()].some((n) => !except.includes(n.id) && segmentHitsBox(a, b, n.box, 0)) &&
    ![...bubbles.values()].some((c) =>
      segmentHitsBox(
        a,
        b,
        { x: c.x - BUBBLE_R, y: c.y - BUBBLE_R, w: 2 * BUBBLE_R, h: 2 * BUBBLE_R },
        0,
      ),
    ) &&
    !placed.some((p) => segmentHitsBox(a, b, p.box, 0)) &&
    !tagLabels.some((t) => segmentHitsBox(a, b, t.box, 0)) &&
    !lineLabels.some((t) => segmentHitsBox(a, b, t.box, 0));

  for (const inst of data.instruments) {
    if (!inst.on) continue;
    if (inst.on.kind === 'equipment') {
      const n = nodes.get(inst.on.id)!;
      const b = n.box;
      const cands: { c: Pt; conn: () => [Pt, Pt] }[] = [];
      for (const far of [56, 104, 152]) {
        for (let k = 0; k < 8; k++) {
          const yR = snap(b.y + 24 + k * 32);
          if (yR > b.y + b.h - 8) break;
          const xr = snap(b.x + b.w + far);
          const xl = snap(b.x - far);
          cands.push({
            c: { x: xr, y: yR },
            conn: () => [{ x: xr - BUBBLE_R, y: yR }, surface(n, 'right', yR)],
          });
          cands.push({
            c: { x: xl, y: yR },
            conn: () => [{ x: xl + BUBBLE_R, y: yR }, surface(n, 'left', yR)],
          });
        }
      }
      for (const dx of [0, 48, -48]) {
        const x = snap(b.x + b.w / 2 + dx);
        if (x < b.x + 4 || x > b.x + b.w - 4) continue;
        const y = snap(b.y - 64);
        cands.push({ c: { x, y }, conn: () => [{ x, y: y + BUBBLE_R }, surface(n, 'top', x)] });
      }
      const ok = cands.find((cd) => {
        if (!free(bubbleBox(cd.c))) return false;
        const [a, z] = cd.conn();
        return (
          segFree(a, z, [n.id]) &&
          !pipeHits({
            x: Math.min(a.x, z.x) - 1,
            y: Math.min(a.y, z.y) - 1,
            w: Math.abs(a.x - z.x) + 2,
            h: Math.abs(a.y - z.y) + 2,
          })
        );
      });
      const pick = ok ?? cands[0]!;
      if (!ok) warnings.push(`layout: no clear spot beside '${n.id}' for '${inst.tag}'.`);
      bubbles.set(inst.tag, pick.c);
      connections.push({ id: `${inst.tag} connection`, pts: pick.conn(), ends: [inst.tag, n.id] });
    } else {
      const pts = routed.get(inst.on.id)!;
      const segs = segments(pts).sort((a, b) => Number(isH(b)) - Number(isH(a)) || len(b) - len(a));
      let done = false;
      for (const s of segs) {
        const h = isH(s);
        const lo = h ? Math.min(s[0].x, s[1].x) : Math.min(s[0].y, s[1].y);
        const hi = h ? Math.max(s[0].x, s[1].x) : Math.max(s[0].y, s[1].y);
        const mid = snap((lo + hi) / 2);
        for (let off = 0; off <= (hi - lo) / 2 - 24 && !done; off += 16) {
          for (const c of off ? [mid - off, mid + off] : [mid]) {
            for (const side of [-1, 1]) {
              const centre = h ? { x: c, y: s[0].y + side * 72 } : { x: s[0].x + side * 72, y: c };
              const a = h
                ? { x: c, y: centre.y - side * BUBBLE_R }
                : { x: centre.x - side * BUBBLE_R, y: c };
              const z = h ? { x: c, y: s[0].y } : { x: s[0].x, y: c };
              if (!free(bubbleBox(centre)) || !segFree(a, z, [])) continue;
              bubbles.set(inst.tag, centre);
              connections.push({ id: `${inst.tag} connection`, pts: [a, z], ends: [inst.tag] });
              done = true;
              break;
            }
            if (done) break;
          }
        }
        if (done) break;
      }
      if (!done)
        warnings.push(
          `layout: no clear spot on line '${inst.on.id}' for '${inst.tag}'; it moves to the instrument band.`,
        );
    }
  }
  // The instrument band above the process, for everything else.
  const processTop = Math.min(
    ...allBoxes.map((b) => b.y),
    ...[...routed.values()].flat().map((p) => p.y),
    ...[...bubbles.values()].map((c) => c.y - BUBBLE_R),
  );
  const bandY = snap(processTop - 88);
  const partnersOf = (tag: string) =>
    data.signals
      .filter((s) => s.from === tag || s.to === tag)
      .map((s) => (s.from === tag ? s.to : s.from));
  const posOf = (tag: string): Pt | undefined =>
    bubbles.get(tag) ?? placed.find((p) => p.item.tag === tag)?.at;
  // A controller or other instrument with no `on` sits near the middle of
  // its loop (the transmitter and the valve it drives), on a free spot, so
  // its signal lines stay short; with no placed partner, in a band above.
  const pending = data.instruments.filter((i) => !bubbles.has(i.tag));
  const spots: Pt[] = [];
  for (let r = 0; r <= 12; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++)
        if (Math.max(Math.abs(dx), Math.abs(dy)) === r) spots.push({ x: dx * 24, y: dy * 24 });
    }
  }
  // Nearest first; above the middle before below it.
  spots.sort(
    (a, b) =>
      Math.hypot(a.x, a.y) + (a.y > 0 ? 12 : 0) - (Math.hypot(b.x, b.y) + (b.y > 0 ? 12 : 0)),
  );
  for (let guard = 0; pending.length && guard < 200; guard++) {
    pending.sort(
      (a, b) => partnersOf(b.tag).filter(posOf).length - partnersOf(a.tag).filter(posOf).length,
    );
    const inst = pending.shift()!;
    const known = partnersOf(inst.tag)
      .map(posOf)
      .filter((p): p is Pt => !!p);
    let at: Pt | null = null;
    if (known.length) {
      const mid = {
        x: snap(known.reduce((s, p) => s + p.x, 0) / known.length),
        y: snap(known.reduce((s, p) => s + p.y, 0) / known.length),
      };
      for (const o of spots) {
        const c = { x: snap(mid.x + o.x), y: snap(mid.y + o.y) };
        if (free(inflate(bubbleBox(c), 12))) {
          at = c;
          break;
        }
      }
    }
    if (!at) {
      const want = known.length
        ? snap(known.reduce((s, p) => s + p.x, 0) / known.length)
        : snap(union(allBoxes).x);
      for (let k = 0; k < 40 && !at; k++) {
        const dx = k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 56;
        for (const row of [0, -72]) {
          const c = { x: want + dx, y: bandY + row };
          if (free(bubbleBox(c))) {
            at = c;
            break;
          }
        }
      }
    }
    bubbles.set(inst.tag, at ?? { x: 0, y: bandY });
  }

  // ---------------------------------------------------------- 8. signals
  const extent = union([world, ...[...bubbles.values()].map((c) => inflate(bubbleBox(c), 160))]);
  const sig = new GridRouter(extent, { cross: 2 });
  for (const n of nodes.values()) sig.block(inflate(n.box, 8));
  for (const c of bubbles.values()) sig.block(bubbleBox(c));
  for (const p of placed) sig.block(inflate(p.box, 2));
  for (const t of [...tagLabels, ...lineLabels, ...notes]) sig.block(t.box);
  for (const pts of routed.values()) sig.occupy(pts);
  for (const c of connections) sig.occupy(c.pts);
  const signalLines: { id: string; type: SignalType; pts: Pt[]; ends: string[] }[] = [];
  // Which side of a bubble each signal uses: the side facing the partner,
  // never the side its process connection uses; several on one side spread.
  const connSide = new Map<string, Side>();
  for (const c of connections) {
    const b = bubbles.get(c.ends[0]!)!;
    const a = c.pts[0]!;
    connSide.set(
      c.ends[0]!,
      a.x < b.x - 1 ? 'left' : a.x > b.x + 1 ? 'right' : a.y < b.y ? 'top' : 'bottom',
    );
  }
  const sideFor = (tag: string, toward: Pt): Side => {
    const b = bubbles.get(tag)!;
    const dx = toward.x - b.x;
    const dy = toward.y - b.y;
    const primary: Side =
      Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'bottom' : 'top';
    if (connSide.get(tag) !== primary) return primary;
    return Math.abs(dx) > Math.abs(dy) ? (dy > 0 ? 'bottom' : 'top') : dx > 0 ? 'right' : 'left';
  };
  const sigSides = new Map<string, { key: string; side: Side; along: number }[]>();
  for (const s of data.signals) {
    for (const [me, other] of [
      [s.from, s.to],
      [s.to, s.from],
    ] as const) {
      if (!bubbles.has(me)) continue;
      const pt = posOf(other)!;
      const side = sideFor(me, pt);
      const k = `${me}|${side}`;
      const along = side === 'top' || side === 'bottom' ? pt.x : pt.y;
      sigSides.set(k, [
        ...(sigSides.get(k) ?? []),
        { key: `${s.from}>${s.to}|${me}`, side, along },
      ]);
    }
  }
  const sigOffset = new Map<string, { side: Side; off: number }>();
  for (const list of sigSides.values()) {
    list.sort((a, b) => a.along - b.along);
    const step = list.length > 2 ? 16 : 8;
    list.forEach((e, i) =>
      sigOffset.set(e.key, {
        side: e.side,
        off:
          list.length === 1 ? 0 : (i - (list.length - 1) / 2) * step * (list.length === 2 ? 2 : 1),
      }),
    );
  }
  const endpoint = (
    tag: string,
    toward: Pt,
    key?: string,
  ): { at: Pt; stub: Pt; out: Pt } | null => {
    const b = bubbles.get(tag);
    if (b) {
      const o = (key && sigOffset.get(key)) || { side: sideFor(tag, toward), off: 0 };
      const nrm = NORMAL[o.side];
      const across = { x: Math.abs(nrm.y), y: Math.abs(nrm.x) };
      const reach = Math.sqrt(BUBBLE_R * BUBBLE_R - o.off * o.off);
      return {
        at: {
          x: b.x + nrm.x * reach + across.x * o.off,
          y: b.y + nrm.y * reach + across.y * o.off,
        },
        stub: { x: b.x + nrm.x * 24 + across.x * o.off, y: b.y + nrm.y * 24 + across.y * o.off },
        out: nrm,
      };
    }
    const p = placed.find((x) => x.item.tag === tag);
    if (!p) return null;
    const ex = inlineExtent(p.item);
    // Into the actuator top (or the side it points to on a vertical run).
    if (p.dir.x === 0) {
      return {
        at: { x: p.at.x + ex.above, y: p.at.y },
        stub: { x: snapOut(p.at.x + ex.above + 4, 1), y: p.at.y },
        out: { x: 1, y: 0 },
      };
    }
    return {
      at: { x: p.at.x, y: p.at.y - ex.above + 2 },
      stub: { x: p.at.x, y: snapOut(p.at.y - ex.above - 4, -1) },
      out: { x: 0, y: -1 },
    };
  };
  for (const s of data.signals) {
    const pa = posOf(s.from)!;
    const pb = posOf(s.to)!;
    const a = endpoint(s.from, pb, `${s.from}>${s.to}|${s.from}`);
    const b = endpoint(s.to, pa, `${s.from}>${s.to}|${s.to}`);
    if (!a || !b) continue;
    const path = sig.route(a.stub, a.out, b.stub, { x: -b.out.x, y: -b.out.y });
    const pts = path
      ? simplify([a.at, ...path, b.at])
      : simplify([a.at, a.stub, { x: b.stub.x, y: a.stub.y }, b.stub, b.at]);
    if (!path) warnings.push(`layout: no clear route for the signal ${s.from} to ${s.to}.`);
    sig.occupy(pts);
    signalLines.push({ id: `${s.from}>${s.to}`, type: s.type, pts, ends: [s.from, s.to] });
  }

  // ---------------------------------------------------------- 9. colours, hops
  const circuitOf = new Map<string, PidData['circuits'][number]>();
  for (const c of data.circuits) for (const l of c.lines) circuitOf.set(l, c);
  const lineColour = (l: Line): string => {
    if (l.focal) return PALETTE.accent;
    const c = circuitOf.get(l.id);
    if (c?.colour) return resolveColour(c.colour, PALETTE.ink);
    if (P.colourByService) return P.serviceColour(l.service);
    return PALETTE.ink;
  };
  const drawn: Pt[][] = [
    ...data.lines.map((l) => routed.get(l.id)!),
    ...connections.map((c) => c.pts),
    ...signalLines.map((s) => s.pts),
  ];
  const hops = hopsFor(drawn);
  const hopStyle = P.symbols.crossing === 'gap' ? 'gap' : 'arc';
  const radius = P.symbols.corners === 'round' ? SPACE.elbow : 0;

  // ---------------------------------------------------------- 10. draw
  const L: Record<string, string[]> = {
    circuits: [],
    pipes: [],
    signals: [],
    equipment: [],
    inline: [],
    bubbles: [],
    labels: [],
    offpage: [],
  };
  const circuitBoxes: { id: string; box: Box }[] = [];
  for (const c of data.circuits) {
    const parts = [
      ...c.lines.map((l) => polylineBox(routed.get(l)!)),
      ...c.equipment.map((e) => nodes.get(e)!.box),
    ];
    if (!parts.length) continue;
    const b = inflate(union(parts), 16);
    b.y -= 12;
    b.h += 12;
    circuitBoxes.push({ id: c.id, box: b });
    const stroke = c.colour ? resolveColour(c.colour, PALETTE.soft) : PALETTE.soft;
    L.circuits!.push(
      el('g', { 'data-circuit': c.id }, [
        el('rect', {
          x: b.x,
          y: b.y,
          width: b.w,
          height: b.h,
          rx: 8,
          fill: 'none',
          stroke,
          'stroke-width': 1,
          'stroke-dasharray': '4,4',
        }),
        textEl('eyebrow', b.x + 10, b.y + 14, c.label, { fill: stroke }),
      ]),
    );
    if (measure(m, c.label, 'eyebrow') + 20 > b.w) {
      warnings.push(`layout: circuit '${c.id}' label is wider than its box: shorten the label.`);
    }
  }
  for (let i = 0; i < circuitBoxes.length; i++) {
    for (let j = i + 1; j < circuitBoxes.length; j++) {
      if (overlaps(circuitBoxes[i]!.box, circuitBoxes[j]!.box)) {
        warnings.push(
          `layout: circuits '${circuitBoxes[i]!.id}' and '${circuitBoxes[j]!.id}' overlap; circuits should not.`,
        );
      }
    }
  }
  data.lines.forEach((l, i) => {
    const pts = routed.get(l.id)!;
    const colour = lineColour(l);
    const width = l.weight === 'main' ? 2 : 1.2;
    // A dead leg is dashed only where the site's profile says so.
    const dash = l.deadleg && P.symbols.deadleg === 'dashed' ? '8,4' : undefined;
    // No arrowhead where a line joins a tee, stops, or meets its bubble.
    const open = !isPlain(l) && !(l.to && nodeIds.has(l.to));
    if (joined.has(l.id) || open) {
      const cap = capEnds.get(l.id);
      L.pipes!.push(
        el('g', { 'data-line': l.id }, [
          el('path', {
            d: orthoPath(pts, radius, hops[i], 6, hopStyle),
            fill: 'none',
            stroke: colour,
            'stroke-width': width,
            'stroke-dasharray': dash,
          }),
          cap ? drawCap(cap.tip, cap.d, colour, width) : '',
        ]),
      );
      return;
    }
    const dir = endDir(pts);
    const tip = pts[pts.length - 1]!;
    const body = [...pts.slice(0, -1), { x: tip.x - dir.x * 6, y: tip.y - dir.y * 6 }];
    L.pipes!.push(
      el('g', { 'data-line': l.id }, [
        el('path', {
          d: orthoPath(body, radius, hops[i], 6, hopStyle),
          fill: 'none',
          stroke: colour,
          'stroke-width': width,
          'stroke-dasharray': dash,
        }),
        arrowHead(tip, dir, colour, l.weight === 'main' ? 9 : 8),
      ]),
    );
  });
  // A join is a filled dot.
  for (const j of joins)
    L.pipes!.push(el('circle', { cx: j.x, cy: j.y, r: 3.5, fill: PALETTE.ink }));
  for (const t of usedTees) {
    const j = teePts.get(t.id)!.at;
    L.pipes!.push(el('circle', { cx: j.x, cy: j.y, r: 3.5, fill: PALETTE.ink, 'data-tee': t.id }));
  }
  const base = data.lines.length;
  connections.forEach((c, i) => {
    L.signals!.push(
      el('path', {
        d: orthoPath(c.pts, radius, hops[base + i], 5, hopStyle),
        fill: 'none',
        stroke: PALETTE.muted,
        'stroke-width': 1,
      }),
    );
  });
  signalLines.forEach((s, i) => {
    const st = signalStyle(s.type);
    L.signals!.push(
      el('g', { 'data-signal': s.id }, [
        el('path', {
          d: orthoPath(s.pts, radius, hops[base + connections.length + i], 5, hopStyle),
          fill: 'none',
          stroke: PALETTE.muted,
          'stroke-width': 1,
          'stroke-dasharray': st.dash,
        }),
        signalMarks(s.pts, s.type, PALETTE.muted),
      ]),
    );
  });
  for (const e of data.equipment) {
    const n = nodes.get(e.id)!;
    L.equipment!.push(
      el(
        'g',
        { 'data-equipment': e.id },
        drawEquipment(e.type, n.box, P, e.focal ? PALETTE.accent : PALETTE.ink),
      ),
    );
  }
  for (const p of placed) {
    const colour = p.item.focal ? PALETTE.accent : PALETTE.ink;
    L.inline!.push(
      el(
        'g',
        { 'data-inline': p.item.tag ?? p.item.type },
        drawInline(p.item, p.at, p.dir, P, colour),
      ),
    );
  }
  for (const inst of data.instruments) {
    const c = bubbles.get(inst.tag)!;
    L.bubbles!.push(drawBubble(inst, c.x, c.y, inst.focal ? PALETTE.accent : PALETTE.ink));
    if (inst.setpoint) {
      const sw = measure(m, inst.setpoint, 'eyebrow');
      L.labels!.push(
        textEl('eyebrow', c.x + BUBBLE_R + 6, c.y - BUBBLE_R + 4, inst.setpoint, {
          fill: PALETTE.muted,
        }),
      );
      notes.push({
        id: `${inst.tag} setpoint`,
        box: { x: c.x + BUBBLE_R + 4, y: c.y - BUBBLE_R - 4, w: sw + 4, h: 10 },
        svg: '',
      });
    }
  }
  for (const t of tagLabels) L.labels!.push(t.svg);
  for (const n of notes) if (n.svg) L.labels!.push(n.svg);
  for (const l of lineLabels) L.labels!.push(l.svg);
  for (const o of data.offpage) {
    const n = nodes.get(o.id)!;
    L.offpage!.push(el('g', { 'data-offpage': o.id }, drawOffPage(n.box, o.sheet)));
    if (o.text) {
      const right = o.direction === 'out';
      L.labels!.push(
        textEl('eyebrow', right ? n.box.x : n.box.x + n.box.w, n.box.y + n.box.h + 12, o.text, {
          'text-anchor': right ? 'start' : 'end',
          fill: PALETTE.muted,
        }),
      );
      const tw = measure(m, o.text, 'eyebrow');
      notes.push({
        id: `${o.id} text`,
        box: {
          x: right ? n.box.x : n.box.x + n.box.w - tw,
          y: n.box.y + n.box.h + 4,
          w: tw,
          h: 10,
        },
        svg: '',
      });
    }
  }

  // ---------------------------------------------------------- 11. self-check
  const qaItems: QaItem[] = [
    ...[...nodes.values()].map((n) => ({ kind: 'box' as const, id: n.id, box: n.box })),
    ...[...bubbles].map(([tag, c]) => ({
      kind: 'box' as const,
      id: tag,
      box: { x: c.x - BUBBLE_R, y: c.y - BUBBLE_R, w: 2 * BUBBLE_R, h: 2 * BUBBLE_R },
    })),
    ...placed.map((p) => ({
      kind: 'box' as const,
      id: p.item.tag ?? `${p.line} ${p.item.type}`,
      box: p.box,
    })),
    ...tagLabels.map((t) => ({ kind: 'label' as const, id: t.id, box: t.box })),
    ...lineLabels.map((t) => ({ kind: 'label' as const, id: `line ${t.id}`, box: t.box })),
    ...notes.map((t) => ({ kind: 'label' as const, id: t.id, box: t.box })),
    // A circuit's name, where its box draws it: a line or an arrowhead on it
    // makes it unreadable.
    ...data.circuits.flatMap((c) => {
      const cb = circuitBoxes.find((x) => x.id === c.id);
      return cb
        ? [
            {
              kind: 'label' as const,
              id: `circuit ${c.id}`,
              box: { x: cb.box.x + 10, y: cb.box.y + 4, w: measure(m, c.label, 'eyebrow'), h: 12 },
            },
          ]
        : [];
    }),
  ];
  const inlineIds = (lineId: string) =>
    placed.filter((p) => p.line === lineId).map((p) => p.item.tag ?? `${p.line} ${p.item.type}`);
  warnings.push(
    ...qa(qaItems, [
      ...data.lines.map((l) => ({
        id: l.id,
        points: routed.get(l.id)!,
        ends: [l.from, ...(l.to ? [l.to] : []), ...inlineIds(l.id)],
      })),
      ...connections.map((c) => ({ id: c.id, points: c.pts, ends: c.ends })),
      ...signalLines.map((s) => ({ id: s.id, points: s.pts, ends: s.ends })),
    ]),
  );

  // A circuit's box must hold its own items only: one that takes in other
  // equipment or bubbles says they belong to it.
  for (const c of data.circuits) {
    const cb = circuitBoxes.find((x) => x.id === c.id);
    if (!cb) continue;
    const own = new Set([...c.equipment, ...c.lines]);
    const strangers = [
      ...[...nodes.values()]
        .filter((n) => !own.has(n.id) && overlaps(cb.box, n.box, 1))
        .map((n) => n.id),
      ...[...bubbles]
        .filter(
          ([tag, p]) =>
            !own.has(tag) &&
            overlaps(
              cb.box,
              { x: p.x - BUBBLE_R, y: p.y - BUBBLE_R, w: 2 * BUBBLE_R, h: 2 * BUBBLE_R },
              1,
            ),
        )
        .map(([tag]) => tag),
    ];
    if (strangers.length) {
      warnings.push(
        `layout: circuit '${c.id}' box takes in ${strangers.slice(0, 4).join(', ')}${strangers.length > 4 ? ' and more' : ''}, not in it: move them with column and row hints, or split the circuit.`,
      );
    }
  }

  // ---------------------------------------------------------- 12. legend, frame
  const entries: LegendEntry[] = [];
  if (data.legend) {
    const weights = new Set(data.lines.map((l) => l.weight));
    // Colour by service names the lines by service instead: a weight entry
    // beside them said "Process" twice.
    if (weights.has('main') && !P.colourByService)
      entries.push({
        label: data.legendNames?.main ?? 'Process line',
        swatch: lineSwatch(PALETTE.ink, 2),
      });
    if (weights.has('secondary') && !P.colourByService)
      entries.push({
        label: data.legendNames?.secondary ?? 'Utility line',
        swatch: lineSwatch(PALETTE.ink, 1.2),
      });
    if (connections.length)
      entries.push({ label: 'Instrument connection', swatch: lineSwatch(PALETTE.muted, 1) });
    const names: Record<SignalType, string> = {
      electric: 'Electric signal',
      pneumatic: 'Pneumatic signal',
      data: 'Data link',
      capillary: 'Capillary',
      hydraulic: 'Hydraulic signal',
      connection: 'Instrument connection',
    };
    for (const t of new Set(data.signals.map((s) => s.type))) {
      if (t === 'connection' && connections.length) continue;
      const st = signalStyle(t);
      entries.push({
        label: names[t],
        swatch: (x, y) =>
          lineSwatch(PALETTE.muted, 1, st.dash)(x, y) +
          signalMarks(
            [
              { x, y: y + 6 },
              { x: x + 28, y: y + 6 },
            ],
            t,
            PALETTE.muted,
          ),
      });
    }
    const displays = new Set(data.instruments.map((i) => i.display));
    const dname: Record<string, string> = {
      shared: 'Shared display, DCS',
      computer: 'Computer function',
      plc: 'PLC',
      interlock: 'Interlock',
    };
    for (const d of ['shared', 'computer', 'plc', 'interlock'] as const) {
      if (!displays.has(d)) continue;
      entries.push({ label: dname[d]!, swatch: miniBubble({ location: 'field', display: d }) });
    }
    const locs = new Set(data.instruments.map((i) => i.location));
    const lname: Record<string, string> = {
      'control-room': 'Control room',
      'local-panel': 'Local panel',
      'behind-panel': 'Behind panel',
    };
    for (const l of ['control-room', 'local-panel', 'behind-panel'] as const) {
      if (!locs.has(l)) continue;
      entries.push({ label: lname[l]!, swatch: miniBubble({ location: l, display: 'discrete' }) });
    }
    if (P.colourByService) {
      for (const sv of new Set(
        data.lines
          .filter((l) => !l.focal && !circuitOf.get(l.id)?.colour)
          .map((l) => l.service ?? 'P'),
      )) {
        entries.push({
          label: SERVICE_NAMES[sv] ?? sv,
          swatch: lineSwatch(P.serviceColour(sv), 2),
        });
      }
    }
    if (data.circuits.length)
      entries.push({ label: 'Circuit', swatch: boxSwatch('none', PALETTE.soft, '4,4') });
  }
  // The guide's legend budget: four kinds of line at most (pipes and
  // signals; a bubble's short connection stub is not counted).
  const lineTypes =
    (P.colourByService
      ? new Set(data.lines.map((l) => l.service ?? 'P')).size
      : new Set(data.lines.map((l) => l.weight)).size) +
    new Set(data.signals.map((s) => s.type).filter((t) => t !== 'connection')).size;
  if (lineTypes > 4) {
    warnings.push(
      `budget: ${lineTypes} kinds of line (the guide keeps a sheet to 4): split the sheet, or show fewer services or signal types.`,
    );
  }

  const content = union([
    ...allBoxes,
    ...[...routed.values()].map(polylineBox),
    ...signalLines.map((s) => polylineBox(s.pts)),
    ...[...bubbles.values()].map((c) => ({
      x: c.x - BUBBLE_R - 4,
      y: c.y - BUBBLE_R - 4,
      w: 2 * BUBBLE_R + 8,
      h: 2 * BUBBLE_R + 8,
    })),
    ...circuitBoxes.map((c) => c.box),
    ...tagLabels.map((t) => t.box),
    ...lineLabels.map((t) => t.box),
    ...notes.map((t) => t.box),
  ]);
  const titleH = data.showTitle ? 48 : 0;
  const dx = snap(SPACE.margin - content.x);
  const dy = snap(SPACE.margin + titleH - content.y);
  const sheetText = data.sheet
    ? [data.sheet.number, data.sheet.revision ? `REV ${data.sheet.revision}` : '']
        .filter(Boolean)
        .join('  ')
    : '';
  const titleW = data.showTitle
    ? measure(m, data.title, 'title') + (sheetText ? measure(m, sheetText, 'eyebrow') + 48 : 0)
    : 0;
  const width = gridUp(Math.max(content.w + 2 * SPACE.margin, titleW + 2 * SPACE.margin, 480));
  const legendTop = gridUp(content.h + SPACE.margin + titleH + 24);
  const legend = legendStrip(m, entries, SPACE.margin, legendTop, width - 2 * SPACE.margin);
  const height = gridUp(
    legend.height ? legendTop + legend.height + 8 : content.h + 2 * SPACE.margin + titleH,
  );

  const body = [
    data.showTitle
      ? textEl('title', SPACE.margin, SPACE.margin + 20, data.title, { fill: PALETTE.ink })
      : '',
    sheetText
      ? textEl('eyebrow', width - SPACE.margin, SPACE.margin + 16, sheetText, {
          'text-anchor': 'end',
          fill: PALETTE.muted,
        })
      : '',
    el('g', { transform: `translate(${dx} ${dy})` }, [
      el('g', { 'data-layer': 'circuits' }, L.circuits!),
      el('g', { 'data-layer': 'pipes' }, L.pipes!),
      el('g', { 'data-layer': 'signals' }, L.signals!),
      el('g', { 'data-layer': 'equipment' }, L.equipment!),
      el('g', { 'data-layer': 'inline' }, L.inline!),
      el('g', { 'data-layer': 'instruments' }, L.bubbles!),
      el('g', { 'data-layer': 'offpage' }, L.offpage!),
      el('g', { 'data-layer': 'labels' }, L.labels!),
    ]),
    legend.svg,
  ].join('');
  const desc = [
    data.description ?? `${data.title}: ${data.equipment.map((e) => e.id).join(', ')}.`,
    data.sheet?.number
      ? `Drawing ${data.sheet.number}${data.sheet.revision ? ` revision ${data.sheet.revision}` : ''}.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  const svg = svgDocument({
    width,
    height,
    title: data.title,
    desc,
    idPrefix: slugify(data.title),
    generator: `mantle-diagram pid@${PID_VERSION}`,
    body,
  });
  const crossings = hops.reduce((s, h) => s + h.length, 0);
  warnings.push(...budgetWarnings(width, crossings, 8));
  return {
    svg,
    width,
    height,
    warnings: [...new Set(warnings)],
    stats: {
      equipment: data.equipment.length,
      lines: data.lines.length,
      instruments: data.instruments.length,
      signals: data.signals.length,
      valves: placed.length,
      crossings,
    },
  };
}
