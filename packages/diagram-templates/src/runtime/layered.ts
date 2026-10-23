/**
 * Layered layout with orthogonal routing.
 *
 * dagre (MIT) does the hard graph part: ranks, crossing-reduced order,
 * coordinates, room for edge labels, and a chain of dummy points for every
 * edge that spans more than one rank. dagre draws edges as splines through
 * those points; this module replaces that with right-angle routes:
 *
 * - each edge leaves its source and enters its target on the side facing the
 *   route, at its own port (ports on one side are spread at least 12px apart
 *   and kept in the order of where the edges go, so they do not cross at the
 *   box);
 * - between two ranks the cross-wise runs sit on separate tracks of the
 *   channel, ordered so that runs heading the same way do not cross, and the
 *   channel grows (pushing later ranks out) until every track fits;
 * - inside a rank an edge runs straight through its dummy point, which dagre
 *   placed clear of every node; an edge label sits on that run.
 *
 * Everything is computed top-to-bottom; a left-to-right drawing is the same
 * layout transposed.
 */
import * as dagre from '@dagrejs/dagre';
import type { Box } from './geom.ts';
import type { Pt } from './svg.ts';
import { GRID, SPACE, gridRound } from './style.ts';

export type Direction = 'right' | 'down';
export type Side = 'top' | 'bottom' | 'left' | 'right';

export type LayeredInput = {
  direction: Direction;
  nodes: { id: string; w: number; h: number; parent?: string; portSpan?: number }[];
  groups: { id: string; parent?: string }[];
  edges: { id: string; from: string; to: string; label?: { w: number; h: number } }[];
  nodeGap?: number;
  rankGap?: number;
  /** Group padding along the rank axis, in the top-to-bottom frame: before
   *  (above) and after (below) the members. Routing tracks keep clear of the
   *  group borders this makes. */
  groupPad?: { before: number; after: number };
};

export type LayeredEdge = {
  points: Pt[];
  fromSide: Side;
  toSide: Side;
  /** Centre of the label, when the edge has one. */
  label?: Pt;
};

export type LayeredResult = {
  nodes: Map<string, Box>;
  edges: Map<string, LayeredEdge>;
  /** Members' box of each group (nodes and nested groups), before padding. */
  groupMembers: Map<string, string[]>;
  width: number;
  height: number;
};

type Station = { x: number; level: number; node?: string };

const key = (y: number) => Math.round(y * 2) / 2;

export function layered(input: LayeredInput): LayeredResult {
  const T = input.direction === 'right';
  const g = new dagre.graphlib.Graph({ compound: true, multigraph: true });
  const nodeGap = input.nodeGap ?? SPACE.nodeGap;
  const rankGap = input.rankGap ?? SPACE.rankGap;
  g.setGraph({
    rankdir: 'TB',
    nodesep: nodeGap,
    ranksep: rankGap,
    edgesep: SPACE.track * 2,
    marginx: 0,
    marginy: 0,
    ranker: 'network-simplex',
  });
  g.setDefaultEdgeLabel(() => ({}));
  // Sizes in the top-to-bottom frame.
  const size = new Map<string, { w: number; h: number; span: number }>();
  for (const n of input.nodes) {
    const w = T ? n.h : n.w;
    const h = T ? n.w : n.h;
    size.set(n.id, { w, h, span: n.portSpan ?? w });
    g.setNode(n.id, { width: w, height: h });
  }
  for (const gr of input.groups) g.setNode(gr.id, {});
  for (const gr of input.groups) if (gr.parent) g.setParent(gr.id, gr.parent);
  for (const n of input.nodes) if (n.parent) g.setParent(n.id, n.parent);
  for (const e of input.edges) {
    const lw = e.label ? (T ? e.label.h : e.label.w) : 0;
    const lh = e.label ? (T ? e.label.w : e.label.h) : 0;
    g.setEdge(e.from, e.to, { width: lw, height: lh, labelpos: 'c', minlen: 1, weight: 1 }, e.id);
  }
  dagre.layout(g);

  // Node centres in the TB frame.
  const pos = new Map<string, { x: number; y: number }>();
  // Snapped so box corners sit on the grid and a dummy point lines up
  // exactly with the port that aims at it (no 2px jogs).
  for (const n of input.nodes) {
    const d = g.node(n.id);
    const w = size.get(n.id)!.w;
    pos.set(n.id, { x: gridRound((d.x ?? 0) - w / 2) + w / 2, y: d.y ?? 0 });
  }

  // Levels: every distinct y a node centre or an edge point sits on.
  const half = new Map<number, number>();
  const touch = (y: number, h: number) => half.set(key(y), Math.max(half.get(key(y)) ?? 0, h));
  for (const n of input.nodes) touch(pos.get(n.id)!.y, size.get(n.id)!.h / 2);
  const rawEdges = input.edges.map((e) => {
    const de = g.edge({ v: e.from, w: e.to, name: e.id }) as {
      points?: { x: number; y: number }[];
      x?: number;
      y?: number;
      height?: number;
    };
    const inner = (de.points ?? []).slice(1, -1).map((p) => ({ x: gridRound(p.x), y: p.y }));
    const lh = e.label ? (T ? e.label.w : e.label.h) : 0;
    for (const p of inner) touch(p.y, 0);
    if (e.label && de.y !== undefined) touch(de.y, lh / 2);
    return {
      e,
      inner,
      label: e.label && de.x !== undefined ? { x: gridRound(de.x), y: de.y! } : undefined,
    };
  });
  const levelYs = [...half.keys()].sort((a, b) => a - b);
  const levelOf = (y: number) => {
    let best = 0;
    for (let i = 0; i < levelYs.length; i++) {
      if (Math.abs(levelYs[i]! - y) < Math.abs(levelYs[best]! - y)) best = i;
    }
    return best;
  };
  const levelHalf = levelYs.map((y) => half.get(y) ?? 0);

  // Stations per edge: source, dummy points, target.
  const routes = rawEdges.map(({ e, inner, label }) => {
    const st: Station[] = [
      { x: pos.get(e.from)!.x, level: levelOf(pos.get(e.from)!.y), node: e.from },
    ];
    for (const p of inner) st.push({ x: p.x, level: levelOf(p.y) });
    st.push({ x: pos.get(e.to)!.x, level: levelOf(pos.get(e.to)!.y), node: e.to });
    return { e, st, label };
  });

  // Ports: per node and side, ordered by where each edge heads next.
  type PortReq = { route: number; end: 'from' | 'to'; toward: number };
  const portReqs = new Map<string, PortReq[]>();
  routes.forEach((r, i) => {
    const first = r.st[0]!;
    const second = r.st[1]!;
    const last = r.st[r.st.length - 1]!;
    const prev = r.st[r.st.length - 2]!;
    const fromSide = second.level > first.level ? 'bottom' : 'top';
    const toSide = prev.level < last.level ? 'top' : 'bottom';
    const push = (k: string, req: PortReq) => portReqs.set(k, [...(portReqs.get(k) ?? []), req]);
    push(`${r.e.from}|${fromSide}`, { route: i, end: 'from', toward: second.x });
    push(`${r.e.to}|${toSide}`, { route: i, end: 'to', toward: prev.x });
  });
  const portX = new Map<string, number>(); // `${route}|from` -> x
  const portSide = new Map<string, 'top' | 'bottom'>();
  for (const [k, reqs] of portReqs) {
    const [id, side] = k.split('|') as [string, 'top' | 'bottom'];
    const c = pos.get(id)!;
    const s = size.get(id)!;
    const lo = c.x - s.span / 2 + 8;
    const hi = c.x + s.span / 2 - 8;
    reqs.sort((a, b) => a.toward - b.toward || a.route - b.route);
    const gap = SPACE.track;
    let xs: number[];
    if (reqs.length === 1) {
      // Straight down when the next point is in reach, else the centre.
      const t = reqs[0]!.toward;
      xs = [t >= lo && t <= hi ? t : c.x];
    } else if ((reqs.length - 1) * gap > hi - lo) {
      // Not enough room for 12px apart: spread evenly.
      xs = reqs.map((_, i) => lo + ((hi - lo) * i) / (reqs.length - 1));
    } else {
      // Even spread around the centre, the classic fan.
      const span = Math.min(hi - lo, (reqs.length - 1) * gap * 2);
      xs = reqs.map((_, i) => c.x - span / 2 + (span * i) / (reqs.length - 1));
    }
    reqs.forEach((r, i) => {
      portX.set(`${r.route}|${r.end}`, gridRound(xs[i]!));
      portSide.set(`${r.route}|${r.end}`, side);
    });
  }

  // Channel runs: for each pair of consecutive stations, one cross-wise run
  // in the channel next to the first station, toward the second.
  type Run = { route: number; idx: number; channel: number; from: number; to: number; key: number };
  const runs: Run[] = [];
  routes.forEach((r, i) => {
    for (let k = 0; k + 1 < r.st.length; k++) {
      const a = r.st[k]!;
      const b = r.st[k + 1]!;
      const xa = k === 0 ? portX.get(`${i}|from`)! : a.x;
      const xb = k + 1 === r.st.length - 1 ? portX.get(`${i}|to`)! : b.x;
      if (Math.abs(xa - xb) < 1) continue;
      const down = b.level > a.level;
      const channel = down ? a.level : a.level - 1; // channel c sits between level c and c+1
      // Order so runs heading the same way never cross (see module note).
      const rightward = xb > xa;
      const goingDown = down;
      const k2 = rightward === goingDown ? -xa : xa;
      runs.push({ route: i, idx: k, channel, from: xa, to: xb, key: k2 });
    }
  });

  // Tracks per channel: ordered greedy, each run below every placed run it
  // overlaps.
  const trackOf = new Map<string, number>();
  const tracks = new Map<number, number>();
  const byChannel = new Map<number, Run[]>();
  for (const r of runs) byChannel.set(r.channel, [...(byChannel.get(r.channel) ?? []), r]);
  for (const [ch, list] of byChannel) {
    list.sort((a, b) => a.key - b.key || a.route - b.route);
    const placed: { lo: number; hi: number; t: number }[] = [];
    for (const r of list) {
      const lo = Math.min(r.from, r.to) - SPACE.track;
      const hi = Math.max(r.from, r.to) + SPACE.track;
      let t = 0;
      for (const p of placed) if (p.lo < hi && lo < p.hi) t = Math.max(t, p.t + 1);
      placed.push({ lo, hi, t });
      trackOf.set(`${r.route}|${r.idx}`, t);
    }
    tracks.set(ch, Math.max(0, ...placed.map((p) => p.t + 1)));
  }

  // Group borders along the rank axis. A border belongs to the level of the
  // member it pads, so it moves with that level when channels grow.
  const pad = input.groupPad ?? { before: 0, after: 0 };
  const nodeLevel = new Map(input.nodes.map((n) => [n.id, levelOf(pos.get(n.id)!.y)]));
  type Ext = { lo: number; loLevel: number; hi: number; hiLevel: number };
  const extents = (ys: number[]): Ext[] => {
    const memo = new Map<string, Ext | null>();
    const ext = (gid: string): Ext | null => {
      if (memo.has(gid)) return memo.get(gid)!;
      let best: Ext | null = null;
      const take = (lo: number, loLevel: number, hi: number, hiLevel: number) => {
        if (!best) best = { lo, loLevel, hi, hiLevel };
        else {
          if (lo < best.lo) Object.assign(best, { lo, loLevel });
          if (hi > best.hi) Object.assign(best, { hi, hiLevel });
        }
      };
      for (const n of input.nodes) {
        if (n.parent !== gid) continue;
        const lv = nodeLevel.get(n.id)!;
        const h = size.get(n.id)!.h / 2;
        take(ys[lv]! - h, lv, ys[lv]! + h, lv);
      }
      for (const c of input.groups) {
        if (c.parent !== gid) continue;
        const e = ext(c.id);
        if (e) take(e.lo, e.loLevel, e.hi, e.hiLevel);
      }
      const out: Ext | null = best
        ? {
            lo: (best as Ext).lo - pad.before,
            loLevel: (best as Ext).loLevel,
            hi: (best as Ext).hi + pad.after,
            hiLevel: (best as Ext).hiLevel,
          }
        : null;
      memo.set(gid, out);
      return out;
    };
    return input.groups.map((gr) => ext(gr.id)).filter((e): e is Ext => e !== null);
  };
  const ext0 = extents(levelYs);
  // How far group borders reach into channel ch from each side (stable
  // under shifting, since each border moves with its own level).
  const lowExtra = (ch: number) =>
    Math.max(
      0,
      ...ext0
        .filter((e) => e.hiLevel === ch)
        .map((e) => e.hi - (levelYs[ch]! + levelHalf[ch]!) + 8),
    );
  const highExtra = (ch: number) =>
    Math.max(
      0,
      ...ext0
        .filter((e) => e.loLevel === ch + 1)
        .map((e) => levelYs[ch + 1]! - levelHalf[ch + 1]! - e.lo + 8),
    );

  // Grow channels that are too small, pushing later levels out.
  const levelY = [...levelYs];
  let shift = 0;
  const shifted = levelYs.map((y, i) => {
    if (i > 0) {
      const ch = i - 1;
      const n = tracks.get(ch) ?? 0;
      const gapNow = levelYs[i]! - levelHalf[i]! - (levelYs[i - 1]! + levelHalf[i - 1]!);
      const need = lowExtra(ch) + highExtra(ch) + (n + 1) * SPACE.track + 8;
      if (need > gapNow) shift += gridRound(need - gapNow + GRID / 2);
    }
    return y + shift;
  });
  for (let i = 0; i < levelY.length; i++) levelY[i] = shifted[i]!;
  const bandBottom = (lv: number) => levelY[lv]! + levelHalf[lv]!;
  const bandTop = (lv: number) => levelY[lv]! - levelHalf[lv]!;
  const trackY = (ch: number, t: number) => {
    const n = tracks.get(ch) ?? 1;
    const top = bandBottom(ch) + lowExtra(ch);
    const bottom = bandTop(ch + 1) - highExtra(ch);
    return gridRound(top + ((bottom - top) * (t + 1)) / (n + 1));
  };

  // Node boxes after the shift (TB frame).
  const tbBox = new Map<string, Box>();
  for (const n of input.nodes) {
    const c = pos.get(n.id)!;
    const s = size.get(n.id)!;
    const y = levelY[levelOf(c.y)]!;
    tbBox.set(n.id, { x: gridRound(c.x - s.w / 2), y: gridRound(y - s.h / 2), w: s.w, h: s.h });
  }

  // Polylines in the TB frame.
  const tbEdges = routes.map((r, i) => {
    const pts: Pt[] = [];
    const fromBox = tbBox.get(r.e.from)!;
    const toBox = tbBox.get(r.e.to)!;
    const fs = portSide.get(`${i}|from`)!;
    const ts = portSide.get(`${i}|to`)!;
    const fx = portX.get(`${i}|from`)!;
    const tx = portX.get(`${i}|to`)!;
    pts.push({ x: fx, y: fs === 'bottom' ? fromBox.y + fromBox.h : fromBox.y });
    let x = fx;
    for (let k = 0; k + 1 < r.st.length; k++) {
      const a = r.st[k]!;
      const b = r.st[k + 1]!;
      const xb = k + 1 === r.st.length - 1 ? tx : b.x;
      if (Math.abs(x - xb) >= 1) {
        const down = b.level > a.level;
        const ch = down ? a.level : a.level - 1;
        const y = trackY(ch, trackOf.get(`${i}|${k}`) ?? 0);
        pts.push({ x, y }, { x: xb, y });
        x = xb;
      }
      if (k + 1 < r.st.length - 1) pts.push({ x, y: levelY[b.level]! });
    }
    pts.push({ x: tx, y: ts === 'top' ? toBox.y : toBox.y + toBox.h });
    const label = r.label ? { x: r.label.x, y: levelY[levelOf(r.label.y)]! } : undefined;
    return { id: r.e.id, pts, fs, ts, label };
  });

  // To the real frame, then to the origin.
  const tr = (p: Pt): Pt => (T ? { x: p.y, y: p.x } : { x: p.x, y: p.y });
  const trBox = (b: Box): Box => (T ? { x: b.y, y: b.x, w: b.h, h: b.w } : { ...b });
  const sideOf = (s: 'top' | 'bottom'): Side => (T ? (s === 'top' ? 'left' : 'right') : s);
  const nodes = new Map<string, Box>();
  for (const [id, b] of tbBox) nodes.set(id, trBox(b));
  const edges = new Map<string, LayeredEdge>();
  for (const e of tbEdges) {
    edges.set(e.id, {
      points: e.pts.map(tr),
      fromSide: sideOf(e.fs),
      toSide: sideOf(e.ts),
      label: e.label ? tr(e.label) : undefined,
    });
  }
  const all: Box[] = [...nodes.values()];
  for (const e of edges.values())
    for (const p of e.points) all.push({ x: p.x, y: p.y, w: 0, h: 0 });
  const minX = Math.min(...all.map((b) => b.x));
  const minY = Math.min(...all.map((b) => b.y));
  const dx = -gridRound(minX);
  const dy = -gridRound(minY);
  for (const b of nodes.values()) {
    b.x += dx;
    b.y += dy;
  }
  for (const e of edges.values()) {
    for (const p of e.points) {
      p.x += dx;
      p.y += dy;
    }
    if (e.label) {
      e.label.x += dx;
      e.label.y += dy;
    }
  }
  const width = Math.max(0, ...all.map((b) => b.x + b.w)) + dx;
  const height = Math.max(0, ...all.map((b) => b.y + b.h)) + dy;

  const groupMembers = new Map<string, string[]>();
  for (const gr of input.groups) groupMembers.set(gr.id, (g.children(gr.id) as string[]) ?? []);
  return { nodes, edges, groupMembers, width, height };
}
