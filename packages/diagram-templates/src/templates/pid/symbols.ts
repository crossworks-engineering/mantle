/**
 * The P&ID symbol set: equipment, valves and inline items, instrument
 * bubbles, off-page connectors and signal line marks. Shapes follow the
 * Mantle P&ID guide (`docs/diagram-guides/mantle/type-pid.md`), common
 * ISA-5.1 practice. A site profile can swap a built-in drawing for its own
 * (`customSymbols`) or pick a variant (`symbols`).
 */
import { el, num, textEl, type Pt } from '../../runtime/svg.ts';
import { PALETTE, ROLES } from '../../runtime/style.ts';
import type { Box } from '../../runtime/geom.ts';
import type { CustomSymbol, ResolvedProfile } from './profile.ts';
import type { EquipmentType, InlineItem, Instrument, SignalType } from './schema.ts';

const INK = PALETTE.ink;
const PAPER = PALETTE.paper;

/** Default sizes (w x h), on the 8px grid where the guide allows. */
export const EQUIP_SIZE: Record<EquipmentType, { w: number; h: number }> = {
  'vertical-vessel': { w: 64, h: 160 },
  'horizontal-drum': { w: 160, h: 64 },
  column: { w: 56, h: 240 },
  tank: { w: 120, h: 96 },
  'centrifugal-pump': { w: 40, h: 40 },
  'pd-pump': { w: 40, h: 40 },
  compressor: { w: 56, h: 40 },
  'shell-tube-exchanger': { w: 128, h: 40 },
  exchanger: { w: 40, h: 40 },
  'air-cooler': { w: 96, h: 48 },
  filter: { w: 32, h: 24 },
};

export type Band = 'vessel' | 'machine' | 'inline';
export const BAND: Record<EquipmentType, Band> = {
  'vertical-vessel': 'vessel',
  'horizontal-drum': 'vessel',
  column: 'vessel',
  tank: 'vessel',
  'centrifugal-pump': 'machine',
  'pd-pump': 'machine',
  compressor: 'machine',
  'shell-tube-exchanger': 'inline',
  exchanger: 'inline',
  'air-cooler': 'inline',
  filter: 'inline',
};

export function equipmentSize(
  type: EquipmentType,
  profile: ResolvedProfile,
): { w: number; h: number } {
  const c = profile.customSymbols[type];
  return c ? { w: c.w, h: c.h } : EQUIP_SIZE[type];
}

function custom(c: CustomSymbol, x: number, y: number, stroke: string): string {
  return el(
    'g',
    { transform: `translate(${num(x)} ${num(y)})` },
    c.paths.map((p) =>
      el('path', {
        d: p.d,
        fill: p.fill === 'ink' ? stroke : p.fill === 'paper' ? PAPER : 'none',
        stroke,
        'stroke-width': 1.2,
      }),
    ),
  );
}

/** A pump's casing: centre and radius (the discharge leaves tangentially
 *  from its top, at y + 8). */
export function pumpCasing(b: Box): { cx: number; cy: number; r: number } {
  return { cx: b.x + b.w / 2, cy: b.y + 22, r: 14 };
}

/** Draw one piece of equipment in its box. */
export function drawEquipment(
  type: EquipmentType,
  b: Box,
  profile: ResolvedProfile,
  stroke: string = INK,
): string {
  const c = profile.customSymbols[type];
  if (c) return custom(c, b.x, b.y, stroke);
  const s = { fill: PAPER, stroke, 'stroke-width': 1.2 };
  const hair = { fill: 'none', stroke, 'stroke-width': 0.6, 'stroke-opacity': 0.5 };
  const { x, y, w, h } = b;
  const cx = x + w / 2;
  const cy = y + h / 2;
  switch (type) {
    case 'vertical-vessel':
    case 'column': {
      const cap = w / 4;
      const parts = [
        el('path', {
          d: `M${x} ${y + cap}A${w / 2} ${cap} 0 0 1 ${x + w} ${y + cap}V${y + h - cap}A${w / 2} ${cap} 0 0 1 ${x} ${y + h - cap}Z`,
          ...s,
        }),
        el('path', { d: `M${x} ${y + cap}H${x + w}M${x} ${y + h - cap}H${x + w}`, ...hair }),
      ];
      if (type === 'column') {
        // Trays: alternating short hairlines.
        let left = true;
        for (let ty = y + cap + 20; ty < y + h - cap - 8; ty += 20) {
          parts.push(
            el('path', {
              d: left ? `M${x} ${ty}H${x + w - 16}` : `M${x + 16} ${ty}H${x + w}`,
              ...hair,
            }),
          );
          left = !left;
        }
      }
      return parts.join('');
    }
    case 'horizontal-drum': {
      const cap = h / 4;
      return (
        el('path', {
          d: `M${x + cap} ${y}H${x + w - cap}A${cap} ${h / 2} 0 0 1 ${x + w - cap} ${y + h}H${x + cap}A${cap} ${h / 2} 0 0 1 ${x + cap} ${y}Z`,
          ...s,
        }) + el('path', { d: `M${x + cap} ${y}V${y + h}M${x + w - cap} ${y}V${y + h}`, ...hair })
      );
    }
    case 'tank':
      return el('path', {
        d: `M${x} ${y + 16}L${cx} ${y}L${x + w} ${y + 16}V${y + h}H${x}Z`,
        ...s,
      });
    case 'centrifugal-pump':
    case 'pd-pump': {
      const r = 14;
      const py = y + 22;
      const parts = [
        el('path', {
          d: `M${cx - 12} ${y + h}L${cx - 6} ${py + 10}M${cx + 12} ${y + h}L${cx + 6} ${py + 10}M${cx - 16} ${y + h}H${cx + 16}`,
          fill: 'none',
          stroke,
          'stroke-width': 1.2,
        }),
        el('circle', { cx, cy: py, r, ...s }),
      ];
      if (type === 'centrifugal-pump') {
        // Tangential discharge from the top of the casing.
        parts.push(
          el('path', { d: `M${cx} ${py - r}H${x + w}`, fill: 'none', stroke, 'stroke-width': 1.2 }),
        );
      } else {
        parts.push(
          el('path', { d: `M${cx} ${py - r}H${x + w}`, fill: 'none', stroke, 'stroke-width': 1.2 }),
          textEl({ ...ROLES.tag, size: 8 }, cx, py + 3, 'PD', {
            'text-anchor': 'middle',
            fill: stroke,
          }),
        );
      }
      return parts.join('');
    }
    case 'compressor':
      return el('path', {
        d: `M${x} ${y}L${x + w} ${y + h / 4}V${y + (3 * h) / 4}L${x} ${y + h}Z`,
        ...s,
      });
    case 'shell-tube-exchanger': {
      const zig: string[] = [`M${x + 8} ${cy}`];
      let up = true;
      for (let zx = x + 20; zx < x + w - 12; zx += 12) {
        zig.push(`L${zx} ${up ? cy - 8 : cy + 8}`);
        up = !up;
      }
      zig.push(`L${x + w - 8} ${cy}`);
      return (
        el('rect', { x, y, width: w, height: h, rx: h / 2, ...s }) +
        el('path', { d: zig.join(''), fill: 'none', stroke, 'stroke-width': 1 })
      );
    }
    case 'exchanger':
      return (
        el('circle', { cx, cy, r: Math.min(w, h) / 2, ...s }) +
        el('path', {
          d: `M${x} ${cy}H${x + 10}L${x + 15} ${cy - 8}L${x + 25} ${cy + 8}L${x + 30} ${cy}H${x + w}`,
          fill: 'none',
          stroke,
          'stroke-width': 1,
        })
      );
    case 'air-cooler':
      return (
        el('rect', { x, y: y + 16, width: w, height: h - 16, rx: 2, ...s }) +
        el('path', { d: `M${cx} ${y + 16}V${y + 8}`, fill: 'none', stroke, 'stroke-width': 1 }) +
        el('ellipse', { cx: cx - 10, cy: y + 8, rx: 10, ry: 3, ...s, 'stroke-width': 1 }) +
        el('ellipse', { cx: cx + 10, cy: y + 8, rx: 10, ry: 3, ...s, 'stroke-width': 1 })
      );
    case 'filter':
      return (
        el('rect', { x, y, width: w, height: h, ...s }) +
        el('path', { d: `M${x} ${y + h}L${x + w} ${y}`, fill: 'none', stroke, 'stroke-width': 1 })
      );
  }
}

/** The half length an inline item takes along its line, and the room it
 *  needs across it (above, for an actuator). */
export function inlineExtent(item: InlineItem): { half: number; above: number; below: number } {
  switch (item.type) {
    case 'control':
      return { half: 12, above: 28, below: 8 };
    case 'relief':
      return { half: 12, above: 28, below: 8 };
    case 'three-way':
      return { half: 12, above: 8, below: 16 };
    default:
      return { half: 10, above: 10, below: item.closed ? 16 : 8 };
  }
}

/** Draw an inline item centred on its line at (cx, cy). The symbols are
 *  drawn for flow to the right with the actuator up; `dir` (the flow
 *  direction) turns them: flow left mirrors (the actuator stays up), flow
 *  down or up turns them a quarter so the actuator points right. */
export function drawInline(
  item: InlineItem,
  at: Pt,
  dir: Pt,
  profile: ResolvedProfile,
  stroke: string = INK,
): string {
  const { x: cx, y: cy } = at;
  const c = profile.customSymbols[item.type];
  const parts: string[] = [];
  const s = { fill: PAPER, stroke, 'stroke-width': 1 };
  const bowtie = (filled = false) =>
    el('path', {
      d: `M${cx - 8} ${cy - 6}L${cx + 8} ${cy + 6}V${cy - 6}L${cx - 8} ${cy + 6}Z`,
      ...s,
      fill: filled ? stroke : PAPER,
    });
  if (c) {
    parts.push(custom(c, cx - c.w / 2, cy - c.h / 2, stroke));
  } else {
    const nc = item.closed && profile.symbols.normallyClosed === 'filled';
    switch (item.type) {
      case 'gate':
        parts.push(bowtie(nc));
        break;
      case 'globe':
        parts.push(bowtie(nc), el('circle', { cx, cy, r: 2, fill: stroke }));
        break;
      case 'ball':
        parts.push(bowtie(nc), el('circle', { cx, cy, r: 3, ...s }));
        break;
      case 'butterfly':
        parts.push(
          bowtie(nc),
          el('path', { d: `M${cx} ${cy - 7}V${cy + 7}`, stroke, 'stroke-width': 1.6 }),
        );
        break;
      case 'check':
        if (profile.symbols.checkValve === 'filled') {
          parts.push(
            el('path', { d: `M${cx - 8} ${cy - 6}L${cx} ${cy}L${cx - 8} ${cy + 6}Z`, ...s }),
            el('path', {
              d: `M${cx + 8} ${cy - 6}L${cx} ${cy}L${cx + 8} ${cy + 6}Z`,
              ...s,
              fill: stroke,
            }),
          );
        } else {
          parts.push(
            bowtie(),
            el('path', {
              d: `M${cx - 6} ${cy - 10}H${cx + 4}M${cx + 1} ${cy - 13}L${cx + 5} ${cy - 10}L${cx + 1} ${cy - 7}`,
              fill: 'none',
              stroke,
              'stroke-width': 1,
            }),
          );
        }
        break;
      case 'three-way':
        parts.push(
          bowtie(),
          el('path', { d: `M${cx} ${cy}L${cx - 6} ${cy + 12}H${cx + 6}Z`, ...s }),
        );
        break;
      case 'control': {
        parts.push(
          bowtie(),
          el('circle', { cx, cy, r: 2, fill: stroke }),
          el('path', { d: `M${cx} ${cy}V${cy - 16}`, stroke, 'stroke-width': 1 }),
        );
        if (item.actuator === 'diaphragm') {
          parts.push(
            el('path', { d: `M${cx - 9} ${cy - 16}A9 9 0 0 1 ${cx + 9} ${cy - 16}Z`, ...s }),
          );
        } else if (item.actuator === 'piston') {
          parts.push(el('rect', { x: cx - 7, y: cy - 24, width: 14, height: 8, ...s }));
        } else {
          parts.push(
            el('rect', { x: cx - 8, y: cy - 32, width: 16, height: 16, ...s }),
            textEl({ ...ROLES.tag, size: 9 }, cx, cy - 21, 'M', {
              'text-anchor': 'middle',
              fill: stroke,
            }),
          );
        }
        break;
      }
      case 'relief':
        // Angle body with the spring above.
        parts.push(
          bowtie(),
          el('path', {
            d: `M${cx} ${cy}V${cy - 8}L${cx - 5} ${cy - 11}L${cx + 5} ${cy - 15}L${cx - 5} ${cy - 19}L${cx + 5} ${cy - 23}L${cx} ${cy - 25}`,
            fill: 'none',
            stroke,
            'stroke-width': 1,
          }),
        );
        break;
      case 'reducer':
        parts.push(
          el('path', {
            d: `M${cx - 6} ${cy - 6}L${cx + 6} ${cy - 3}V${cy + 3}L${cx - 6} ${cy + 6}Z`,
            ...s,
          }),
        );
        break;
      case 'blind':
        parts.push(
          el('path', { d: `M${cx - 2} ${cy}H${cx + 2}`, stroke, 'stroke-width': 1.6 }),
          el('circle', { cx: cx - 6, cy, r: 4, fill: stroke, stroke, 'stroke-width': 1 }),
          el('circle', { cx: cx + 6, cy, r: 4, ...s }),
        );
        break;
      case 'orifice':
        parts.push(
          el('path', {
            d: `M${cx - 2} ${cy - 8}V${cy + 8}M${cx + 2} ${cy - 8}V${cy + 8}`,
            stroke,
            'stroke-width': 1.4,
          }),
        );
        break;
    }
  }
  let matrix: string | null = null;
  if (dir.x < 0) matrix = `matrix(-1 0 0 1 ${num(2 * cx)} 0)`;
  else if (dir.y > 0) matrix = `matrix(0 1 -1 0 ${num(cx + cy)} ${num(cy - cx)})`;
  else if (dir.y < 0) matrix = `matrix(0 -1 -1 0 ${num(cx + cy)} ${num(cx + cy)})`;
  // The M of a motor actuator is symmetric, so a mirror keeps it readable.
  return matrix ? el('g', { transform: matrix }, parts) : parts.join('');
}

/** The text that goes with an inline item (tag, NC, failure position),
 *  placed by the caller. */
export function inlineNotes(item: InlineItem, profile: ResolvedProfile): string[] {
  const notes: string[] = [];
  if (item.closed && profile.symbols.normallyClosed === 'text') notes.push('NC');
  if (item.fail) notes.push(item.fail);
  return notes;
}

export const BUBBLE_R = 20;

/** An ISA-5.1 instrument bubble centred at (cx, cy). */
export function drawBubble(inst: Instrument, cx: number, cy: number, stroke: string = INK): string {
  const r = BUBBLE_R;
  const s = { fill: PAPER, stroke, 'stroke-width': 1 };
  const parts: string[] = [];
  switch (inst.display) {
    case 'shared':
      parts.push(
        el('rect', { x: cx - r, y: cy - r, width: 2 * r, height: 2 * r, ...s }),
        el('circle', { cx, cy, r, ...s }),
      );
      break;
    case 'computer':
      parts.push(
        el('path', {
          d: `M${cx - r - 2} ${cy}L${cx - r / 2} ${cy - r}H${cx + r / 2}L${cx + r + 2} ${cy}L${cx + r / 2} ${cy + r}H${cx - r / 2}Z`,
          ...s,
        }),
      );
      break;
    case 'plc':
      parts.push(
        el('rect', { x: cx - r, y: cy - r, width: 2 * r, height: 2 * r, ...s }),
        el('path', {
          d: `M${cx} ${cy - r}L${cx + r} ${cy}L${cx} ${cy + r}L${cx - r} ${cy}Z`,
          ...s,
        }),
      );
      break;
    case 'interlock':
      parts.push(
        el('path', {
          d: `M${cx} ${cy - r - 4}L${cx + r + 4} ${cy}L${cx} ${cy + r + 4}L${cx - r - 4} ${cy}Z`,
          ...s,
        }),
      );
      break;
    default:
      parts.push(el('circle', { cx, cy, r, ...s }));
  }
  // Where it lives: lines through the middle.
  const span = inst.display === 'discrete' || inst.display === 'interlock' ? r : r;
  if (inst.location === 'control-room')
    parts.push(el('path', { d: `M${cx - span} ${cy}H${cx + span}`, stroke, 'stroke-width': 1 }));
  if (inst.location === 'local-panel')
    parts.push(
      el('path', {
        d: `M${cx - span} ${cy - 2}H${cx + span}M${cx - span} ${cy + 2}H${cx + span}`,
        stroke,
        'stroke-width': 1,
      }),
    );
  if (inst.location === 'behind-panel')
    parts.push(
      el('path', {
        d: `M${cx - span} ${cy}H${cx + span}`,
        stroke,
        'stroke-width': 1,
        'stroke-dasharray': '3,2',
      }),
    );
  const letterSize = inst.letters.length > 3 ? 9 : 11;
  parts.push(
    textEl({ ...ROLES.nodeName, size: letterSize }, cx, cy - 4, inst.letters, {
      'text-anchor': 'middle',
      fill: PALETTE.ink,
    }),
    textEl({ ...ROLES.sublabel, size: 9 }, cx, cy + 12, inst.loop, {
      'text-anchor': 'middle',
      fill: PALETTE.soft,
    }),
  );
  return el('g', { 'data-instrument': inst.tag }, parts);
}

export const OPC_SIZE = { w: 56, h: 24 };

/** An off-page connector: a pentagon pointing in the flow direction. */
export function drawOffPage(
  b: Box,
  sheet: string,
  stroke: string = INK,
  /** A dash for the outline (style 2: a guessed end, dotted). */
  dash?: string,
): string {
  const { x, y, w, h } = b;
  return (
    el('path', {
      d: `M${x} ${y}H${x + w - 12}L${x + w} ${y + h / 2}L${x + w - 12} ${y + h}H${x}Z`,
      fill: PAPER,
      stroke,
      'stroke-width': 1.2,
      'stroke-dasharray': dash,
    }) +
    textEl('eyebrow', x + (w - 12) / 2 + 2, y + h / 2 + 3, sheet, {
      'text-anchor': 'middle',
      fill: PALETTE.ink,
    })
  );
}

/** Signal line style: stroke, dash, and the marks drawn along it. */
export function signalStyle(type: SignalType): {
  dash?: string;
  mark?: 'slashes' | 'circles' | 'crosses' | 'ells';
  every: number;
} {
  switch (type) {
    case 'electric':
      return { dash: '6,4', every: 0 };
    case 'pneumatic':
      return { mark: 'slashes', every: 40 };
    case 'data':
      return { mark: 'circles', every: 24 };
    case 'capillary':
      return { mark: 'crosses', every: 24 };
    case 'hydraulic':
      return { mark: 'ells', every: 40 };
    default:
      return { every: 0 };
  }
}

/** Marks along a polyline (drawn as small paths so they survive as plain
 *  static SVG), clear of the corners. */
export function signalMarks(points: Pt[], type: SignalType, stroke: string): string {
  const st = signalStyle(type);
  if (!st.mark) return '';
  const out: string[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    const dx = Math.sign(b.x - a.x);
    const dy = Math.sign(b.y - a.y);
    // A short run (a legend sample) still shows one mark, in its middle.
    const first = len < st.every + 16 ? len / 2 : st.every / 2 + 8;
    for (let t = first; t <= Math.max(first, len - 12); t += st.every) {
      if (len < 12) break;
      const p = { x: a.x + dx * t, y: a.y + dy * t };
      // n is the normal to the run.
      const n = { x: -dy, y: dx };
      if (st.mark === 'slashes') {
        for (const off of [-1.5, 1.5]) {
          const c = { x: p.x + dx * off, y: p.y + dy * off };
          out.push(
            `M${num(c.x - dx * 2 - n.x * 3)} ${num(c.y - dy * 2 - n.y * 3)}L${num(c.x + dx * 2 + n.x * 3)} ${num(c.y + dy * 2 + n.y * 3)}`,
          );
        }
      } else if (st.mark === 'crosses') {
        out.push(
          `M${num(p.x - 3)} ${num(p.y - 3)}L${num(p.x + 3)} ${num(p.y + 3)}M${num(p.x - 3)} ${num(p.y + 3)}L${num(p.x + 3)} ${num(p.y - 3)}`,
        );
      } else if (st.mark === 'ells') {
        out.push(
          `M${num(p.x + n.x * 4)} ${num(p.y + n.y * 4)}L${num(p.x)} ${num(p.y)}L${num(p.x + dx * 4)} ${num(p.y + dy * 4)}`,
        );
      } else {
        out.push(
          `M${num(p.x + 2)} ${num(p.y)}A2 2 0 1 1 ${num(p.x - 2)} ${num(p.y)}A2 2 0 1 1 ${num(p.x + 2)} ${num(p.y)}`,
        );
      }
    }
  }
  if (!out.length) return '';
  return el('path', {
    d: out.join(''),
    fill: st.mark === 'circles' ? PAPER : 'none',
    stroke,
    'stroke-width': 1,
  });
}
