/**
 * A tiny string SVG builder. Templates build their drawing as text, never as
 * live DOM, so the export is static by construction: there is no way to put
 * a script, an event handler or a foreign object in through these helpers,
 * and `checkStaticSvg` (export.ts) proves it on the result.
 */
import { FONT, ROLES, type FontSpec, type TextRole } from './style.ts';

export type Attrs = Record<string, string | number | undefined | null | false>;

const ATTR_NAME = /^[a-zA-Z][a-zA-Z0-9:-]*$/;

export function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Numbers to at most two decimals, so the output stays small and stable. */
export function num(n: number): string {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
}

function attrText(attrs: Attrs): string {
  let out = '';
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (!ATTR_NAME.test(k) || /^on/i.test(k)) throw new Error(`svg: refused attribute name '${k}'`);
    out += ` ${k}="${esc(typeof v === 'number' ? num(v) : v)}"`;
  }
  return out;
}

const TAGS = new Set([
  'svg',
  'g',
  'rect',
  'circle',
  'ellipse',
  'line',
  'path',
  'polygon',
  'polyline',
  'text',
  'tspan',
  'title',
  'desc',
]);

/** One element. `children` is already-built markup, or text when `text` is
 *  set (escaped here). */
export function el(tag: string, attrs: Attrs = {}, children: string | string[] = ''): string {
  if (!TAGS.has(tag)) throw new Error(`svg: refused element <${tag}>`);
  const inner = Array.isArray(children) ? children.join('') : children;
  return inner ? `<${tag}${attrText(attrs)}>${inner}</${tag}>` : `<${tag}${attrText(attrs)}/>`;
}

export function textEl(
  role: TextRole | FontSpec,
  x: number,
  y: number,
  content: string,
  extra: Attrs = {},
): string {
  const f = typeof role === 'string' ? ROLES[role] : role;
  return el(
    'text',
    {
      x,
      y,
      'font-family': f.family,
      'font-size': f.size,
      'font-weight': f.weight === 400 ? undefined : f.weight,
      'letter-spacing': f.tracking ? f.tracking : undefined,
      fill: '#2d3142',
      ...extra,
    },
    esc(f.upper ? content.toUpperCase() : content),
  );
}

export type Pt = { x: number; y: number };

/** A hop drawn where a later line crosses an earlier one: the crossing point
 *  on one segment of the later line. */
export type Hop = { at: Pt };

function dist(a: Pt, b: Pt): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** Drop repeated points and merge collinear runs, so an orthogonal polyline
 *  is its corners only. */
export function simplify(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    out.push({ x: p.x, y: p.y });
    while (out.length >= 3) {
      const a = out[out.length - 3]!;
      const b = out[out.length - 2]!;
      const c = out[out.length - 1]!;
      const collinear =
        (Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - c.x) < 0.01) ||
        (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - c.y) < 0.01);
      if (!collinear) break;
      out.splice(out.length - 2, 1);
    }
  }
  return out;
}

/**
 * The `d` of an orthogonal polyline with quarter-arc elbows of `radius`
 * (shrunk where a segment is short) and semicircle hops of `hopR` at the given
 * crossings. A hop bulges up on a horizontal run and right on a vertical one.
 */
export function orthoPath(
  points: Pt[],
  radius: number,
  hops: Pt[] = [],
  hopR = 6,
  hopStyle: 'arc' | 'gap' = 'arc',
): string {
  const pts = simplify(points);
  if (pts.length < 2) return '';
  const parts: string[] = [`M${num(pts[0]!.x)} ${num(pts[0]!.y)}`];
  // Where each segment really starts and ends, after the corner arcs.
  const r: number[] = pts.map((p, i) => {
    if (i === 0 || i === pts.length - 1) return 0;
    const before = dist(pts[i - 1]!, p);
    const after = dist(p, pts[i + 1]!);
    return Math.max(0, Math.min(radius, before / 2, after / 2));
  });
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const horizontal = Math.abs(a.y - b.y) < 0.01;
    const dir = horizontal ? Math.sign(b.x - a.x) : Math.sign(b.y - a.y);
    const startOff = r[i - 1]!;
    const endOff = r[i]!;
    // Hops on this segment, in travel order, clear of the corners.
    const along = (p: Pt) => (horizontal ? (p.x - a.x) * dir : (p.y - a.y) * dir);
    const len = dist(a, b);
    const onSeg = hops
      .filter((h) =>
        horizontal
          ? Math.abs(h.y - a.y) < 0.5 &&
            along(h) > startOff + hopR &&
            along(h) < len - endOff - hopR
          : Math.abs(h.x - a.x) < 0.5 &&
            along(h) > startOff + hopR &&
            along(h) < len - endOff - hopR,
      )
      .sort((p, q) => along(p) - along(q));
    for (const h of onSeg) {
      if (horizontal) {
        const x0 = h.x - dir * hopR;
        const x1 = h.x + dir * hopR;
        parts.push(`L${num(x0)} ${num(a.y)}`);
        // Sweep so the bulge is always upward; a gap just lifts the pen.
        parts.push(
          hopStyle === 'gap'
            ? `M${num(x1)} ${num(a.y)}`
            : `A${hopR} ${hopR} 0 0 ${dir > 0 ? 1 : 0} ${num(x1)} ${num(a.y)}`,
        );
      } else {
        const y0 = h.y - dir * hopR;
        const y1 = h.y + dir * hopR;
        parts.push(`L${num(a.x)} ${num(y0)}`);
        parts.push(
          hopStyle === 'gap'
            ? `M${num(a.x)} ${num(y1)}`
            : `A${hopR} ${hopR} 0 0 ${dir > 0 ? 1 : 0} ${num(a.x)} ${num(y1)}`,
        );
      }
    }
    if (i === pts.length - 1) {
      parts.push(`L${num(b.x)} ${num(b.y)}`);
      break;
    }
    const c = pts[i + 1]!;
    const rr = endOff;
    const pre = horizontal ? { x: b.x - dir * rr, y: b.y } : { x: b.x, y: b.y - dir * rr };
    const nextHorizontal = Math.abs(b.y - c.y) < 0.01;
    const nextDir = nextHorizontal ? Math.sign(c.x - b.x) : Math.sign(c.y - b.y);
    const post = nextHorizontal
      ? { x: b.x + nextDir * rr, y: b.y }
      : { x: b.x, y: b.y + nextDir * rr };
    parts.push(`L${num(pre.x)} ${num(pre.y)}`);
    if (rr > 0) {
      // Cross product of the two directions picks the sweep.
      const d1 = horizontal ? { x: dir, y: 0 } : { x: 0, y: dir };
      const d2 = nextHorizontal ? { x: nextDir, y: 0 } : { x: 0, y: nextDir };
      const sweep = d1.x * d2.y - d1.y * d2.x > 0 ? 1 : 0;
      parts.push(`A${num(rr)} ${num(rr)} 0 0 ${sweep} ${num(post.x)} ${num(post.y)}`);
    }
  }
  return parts.join('');
}

/** A filled arrowhead whose tip is `tip`, pointing along `dir` (a unit axis
 *  vector). Drawn as a path, not a marker, so every renderer shows it. */
export function arrowHead(tip: Pt, dir: Pt, fill: string, size = 8): string {
  const back = { x: tip.x - dir.x * size, y: tip.y - dir.y * size };
  const half = size * 0.45;
  const p1 = { x: back.x - dir.y * half, y: back.y + dir.x * half };
  const p2 = { x: back.x + dir.y * half, y: back.y - dir.x * half };
  return el('path', {
    d: `M${num(tip.x)} ${num(tip.y)}L${num(p1.x)} ${num(p1.y)}L${num(p2.x)} ${num(p2.y)}Z`,
    fill,
  });
}

/** Direction of the last segment of a polyline, as a unit axis vector. */
export function endDir(points: Pt[]): Pt {
  const pts = simplify(points);
  const a = pts[pts.length - 2]!;
  const b = pts[pts.length - 1]!;
  return { x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y) };
}

export const DEFAULT_FONT = FONT.sans;
