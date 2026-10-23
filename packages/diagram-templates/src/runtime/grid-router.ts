/**
 * An orthogonal router on an 8px grid (A* with a bend penalty). Used where
 * lines leave and enter at fixed sides, as pipes on a P&ID do, rather than
 * between ranks. Each routed line is remembered, so the next one:
 *
 * - never passes through a blocked box (equipment, a bubble, a symbol);
 * - never runs on top of an earlier line (a heavy cost, not a wall, so a
 *   route always exists);
 * - keeps a cell clear beside an earlier parallel run where it can;
 * - may cross an earlier line at a right angle (a small cost); the drawing
 *   then hops it.
 */
import type { Box } from './geom.ts';
import type { Pt } from './svg.ts';
import { simplify } from './svg.ts';

export const STEP = 8;

export type Side = 'top' | 'bottom' | 'left' | 'right';
export const NORMAL: Record<Side, Pt> = {
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const DIRS: Pt[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

export type Costs = { bend: number; overlap: number; cross: number; near: number };
const DEFAULT_COSTS: Costs = { bend: 6, overlap: 200, cross: 4, near: 3 };

class Heap {
  private a: { f: number; i: number }[] = [];
  push(f: number, i: number): void {
    const a = this.a;
    a.push({ f, i });
    let k = a.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (a[p]!.f <= a[k]!.f) break;
      [a[p], a[k]] = [a[k]!, a[p]!];
      k = p;
    }
  }
  pop(): number | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0]!.i;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < a.length && a[l]!.f < a[m]!.f) m = l;
        if (r < a.length && a[r]!.f < a[m]!.f) m = r;
        if (m === k) break;
        [a[m], a[k]] = [a[k]!, a[m]!];
        k = m;
      }
    }
    return top;
  }
  get size(): number {
    return this.a.length;
  }
}

export class GridRouter {
  readonly x0: number;
  readonly y0: number;
  readonly cols: number;
  readonly rows: number;
  private blocked: Uint8Array;
  private occH: Uint8Array;
  private occV: Uint8Array;
  private costs: Costs;

  constructor(bounds: Box, costs: Partial<Costs> = {}) {
    this.x0 = Math.floor(bounds.x / STEP) * STEP;
    this.y0 = Math.floor(bounds.y / STEP) * STEP;
    this.cols = Math.ceil((bounds.x + bounds.w - this.x0) / STEP) + 1;
    this.rows = Math.ceil((bounds.y + bounds.h - this.y0) / STEP) + 1;
    const n = this.cols * this.rows;
    this.blocked = new Uint8Array(n);
    this.occH = new Uint8Array(n);
    this.occV = new Uint8Array(n);
    this.costs = { ...DEFAULT_COSTS, ...costs };
  }

  private idx(gx: number, gy: number): number {
    return gy * this.cols + gx;
  }

  cell(p: Pt): { gx: number; gy: number } {
    return { gx: Math.round((p.x - this.x0) / STEP), gy: Math.round((p.y - this.y0) / STEP) };
  }

  point(gx: number, gy: number): Pt {
    return { x: this.x0 + gx * STEP, y: this.y0 + gy * STEP };
  }

  inside(gx: number, gy: number): boolean {
    return gx >= 0 && gy >= 0 && gx < this.cols && gy < this.rows;
  }

  /** Block every grid point strictly inside the box. */
  block(b: Box): void {
    const gx0 = Math.ceil((b.x - this.x0) / STEP);
    const gx1 = Math.floor((b.x + b.w - this.x0) / STEP);
    const gy0 = Math.ceil((b.y - this.y0) / STEP);
    const gy1 = Math.floor((b.y + b.h - this.y0) / STEP);
    for (let gy = Math.max(0, gy0); gy <= Math.min(this.rows - 1, gy1); gy++) {
      for (let gx = Math.max(0, gx0); gx <= Math.min(this.cols - 1, gx1); gx++)
        this.blocked[this.idx(gx, gy)] = 1;
    }
  }

  isBlocked(p: Pt): boolean {
    const { gx, gy } = this.cell(p);
    return this.inside(gx, gy) && this.blocked[this.idx(gx, gy)] === 1;
  }

  /** Remember a drawn polyline (grid-aligned runs only) so later routes keep
   *  off it. */
  occupy(points: Pt[]): void {
    const pts = simplify(points);
    for (let i = 1; i < pts.length; i++) {
      const a = this.cell(pts[i - 1]!);
      const b = this.cell(pts[i]!);
      const horizontal = a.gy === b.gy;
      const n = Math.max(Math.abs(b.gx - a.gx), Math.abs(b.gy - a.gy));
      for (let k = 0; k <= n; k++) {
        const gx = a.gx + Math.sign(b.gx - a.gx) * k;
        const gy = a.gy + Math.sign(b.gy - a.gy) * k;
        if (!this.inside(gx, gy)) continue;
        if (horizontal) this.occH[this.idx(gx, gy)] = 1;
        else this.occV[this.idx(gx, gy)] = 1;
      }
    }
  }

  /**
   * Route from `from` leaving along `fromDir` to `to` arriving along `toDir`
   * (the direction of travel at the end). Both points must be on the grid
   * and not blocked. Returns the corner points, or null when no route
   * exists inside the bounds.
   */
  route(from: Pt, fromDir: Pt, to: Pt, toDir: Pt): Pt[] | null {
    const s = this.cell(from);
    const t = this.cell(to);
    if (!this.inside(s.gx, s.gy) || !this.inside(t.gx, t.gy)) return null;
    const n = this.cols * this.rows;
    const dirIndex = (d: Pt) => DIRS.findIndex((q) => q.x === d.x && q.y === d.y);
    const g = new Float64Array(n * 4).fill(Infinity);
    const prev = new Int32Array(n * 4).fill(-1);
    const heap = new Heap();
    const h = (gx: number, gy: number) => Math.abs(gx - t.gx) + Math.abs(gy - t.gy);
    const sd = dirIndex(fromDir);
    const start = this.idx(s.gx, s.gy) * 4 + sd;
    g[start] = 0;
    heap.push(h(s.gx, s.gy), start);
    const goalDir = dirIndex(toDir);
    const { bend, overlap, cross, near } = this.costs;
    let found = -1;
    while (heap.size) {
      const cur = heap.pop()!;
      const ci = cur >> 2;
      const cd = cur & 3;
      const cx = ci % this.cols;
      const cy = (ci - cx) / this.cols;
      if (cx === t.gx && cy === t.gy) {
        // Arriving the wrong way costs one more bend.
        found = cur;
        if (cd === goalDir) break;
      }
      const gc = g[cur]!;
      for (let d = 0; d < 4; d++) {
        const dir = DIRS[d]!;
        // No U-turns.
        if (dir.x === -DIRS[cd]!.x && dir.y === -DIRS[cd]!.y) continue;
        const nx = cx + dir.x;
        const ny = cy + dir.y;
        if (!this.inside(nx, ny)) continue;
        const ni = this.idx(nx, ny);
        const atGoal = nx === t.gx && ny === t.gy;
        if (this.blocked[ni] && !atGoal) continue;
        const horizontal = dir.y === 0;
        let c = 1;
        if (d !== cd) c += bend;
        if (horizontal ? this.occH[ni] : this.occV[ni]) c += overlap;
        if (horizontal ? this.occV[ni] : this.occH[ni]) c += d !== cd ? overlap / 4 : cross;
        // Keep a cell between parallel runs.
        if (horizontal) {
          if (
            (ny > 0 && this.occH[this.idx(nx, ny - 1)]) ||
            (ny + 1 < this.rows && this.occH[this.idx(nx, ny + 1)])
          )
            c += near;
        } else if (
          (nx > 0 && this.occV[this.idx(nx - 1, ny)]) ||
          (nx + 1 < this.cols && this.occV[this.idx(nx + 1, ny)])
        ) {
          c += near;
        }
        if (atGoal && d !== goalDir) c += bend;
        const ns = ni * 4 + d;
        if (gc + c < g[ns]!) {
          g[ns] = gc + c;
          prev[ns] = cur;
          heap.push(gc + c + h(nx, ny), ns);
        }
      }
    }
    if (found < 0) return null;
    // Prefer the arrival in the wanted direction when it was reached.
    const want = this.idx(t.gx, t.gy) * 4 + goalDir;
    if (g[want]! < Infinity && g[want]! <= g[found]! + bend) found = want;
    const cells: Pt[] = [];
    for (let k = found; k >= 0; k = prev[k]!) {
      const ci = k >> 2;
      const gx = ci % this.cols;
      cells.push(this.point(gx, (ci - gx) / this.cols));
    }
    cells.reverse();
    return simplify(cells);
  }
}
