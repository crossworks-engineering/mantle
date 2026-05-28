/**
 * Pure geometry for the focus-marker gutter hit-test, split out from
 * focus-gutter.tsx so it's testable without the DOM. `nearestBlockIndex` is
 * where the "dragging over a thin divider marked the whole document" bug lived
 * (the old code clamped a between-blocks pointer to the LAST block) — keeping
 * it pure lets a unit test pin the contract.
 */

export interface Span {
  top: number;
  bottom: number;
}

/**
 * Index of the block whose vertical span contains `y`. If `y` falls in a gap
 * between blocks (e.g. the margin around a divider), return the vertically
 * NEAREST block by edge distance — never a far-away clamp. -1 if there are no
 * blocks.
 */
export function nearestBlockIndex(spans: Span[], y: number): number {
  if (spans.length === 0) return -1;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]!;
    if (y >= s.top && y <= s.bottom) return i;
    const dist = y < s.top ? s.top - y : y - s.bottom;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}
