/**
 * Text is measured, not guessed. In a browser the measurer lays the string
 * out in a hidden SVG `<text>` with the same font stack the export uses and
 * reads its real width. Outside a browser (unit tests, a server without
 * Chromium) `estimateMeasurer` stands in with per-character averages; the
 * render harness always uses the real one.
 */
import { ROLES, type FontSpec, type TextRole } from './style.ts';

export type Measurer = (text: string, font: FontSpec) => number;

/** Average advance per character, as a share of the font size. Wide on
 *  purpose: an estimate that is short makes text overflow its box. */
export function estimateMeasurer(text: string, font: FontSpec): number {
  const mono = /mono|menlo|consolas/i.test(font.family);
  let w = 0;
  for (const ch of text) {
    if (mono) w += 0.62;
    else if (/[ilj.,:;'|!]/.test(ch)) w += 0.3;
    else if (/[mwMW@]/.test(ch)) w += 0.9;
    else if (/[A-Z0-9]/.test(ch)) w += 0.68;
    else if (ch === ' ') w += 0.3;
    else w += 0.58;
  }
  const bold = font.weight >= 600 ? 1.06 : 1;
  return w * font.size * bold + font.tracking * Math.max(0, [...text].length - 1);
}

/** A measurer that lays text out in the live document. The SVG namespace and
 *  the attributes match what `textEl` writes, so the width is the drawn one. */
export function domMeasurer(doc: Document): Measurer {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(NS, 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.position = 'absolute';
  svg.style.left = '-9999px';
  svg.style.top = '-9999px';
  svg.style.visibility = 'hidden';
  const t = doc.createElementNS(NS, 'text');
  svg.appendChild(t);
  doc.body.appendChild(svg);
  const cache = new Map<string, number>();
  return (text, font) => {
    const key = `${font.family}|${font.size}|${font.weight}|${font.tracking}|${text}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    t.setAttribute('font-family', font.family);
    t.setAttribute('font-size', String(font.size));
    t.setAttribute('font-weight', String(font.weight));
    t.setAttribute('letter-spacing', String(font.tracking));
    t.textContent = font.upper ? text.toUpperCase() : text;
    // getBBox includes letter spacing; a 4% margin absorbs the small
    // differences between this machine's system font and the reader's.
    const w = t.getBBox().width * 1.04;
    cache.set(key, w);
    return w;
  };
}

/** Width of `text` in a role, with the role's case applied. */
export function measure(m: Measurer, text: string, role: TextRole | FontSpec): number {
  const f = typeof role === 'string' ? ROLES[role] : role;
  return m(f.upper ? text.toUpperCase() : text, f);
}

/** Line height for a role. */
export function lineHeight(role: TextRole | FontSpec): number {
  const f = typeof role === 'string' ? ROLES[role] : role;
  return Math.ceil(f.size * 1.35);
}

/**
 * Greedy word wrap to `maxWidth`. A single word longer than the width stays
 * whole on its own line (and is reported as `overflow`), because breaking a
 * tag like `4"-P-1024-CS150` would change what it says.
 */
export function wrap(
  m: Measurer,
  text: string,
  role: TextRole | FontSpec,
  maxWidth: number,
  maxLines = 3,
): { lines: string[]; width: number; overflow: boolean; truncated: boolean } {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  let overflow = false;
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (!cur || measure(m, next, role) <= maxWidth) {
      cur = next;
    } else {
      lines.push(cur);
      cur = w;
    }
    if (measure(m, w, role) > maxWidth) overflow = true;
  }
  if (cur) lines.push(cur);
  let truncated = false;
  if (lines.length > maxLines) {
    truncated = true;
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]} ...`;
    lines.length = 0;
    lines.push(...kept);
  }
  const width = Math.max(0, ...lines.map((l) => measure(m, l, role)));
  return { lines, width, overflow, truncated };
}
