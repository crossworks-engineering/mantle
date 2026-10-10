/**
 * A drawing snapshot, rebuilt for the PNG renderer from an allowlist.
 *
 * The snapshot is user data (any login that commits a drawing writes it), and
 * the renderer resolves XML namespaces: a link written under ANY prefix bound
 * to the xlink or SVG namespace is a live link, whatever a regex over the
 * text sees. So this parses the document with a strict, namespace-aware XML
 * parser (saxes) and writes a NEW document from what the parse says:
 *
 *  - only SVG-namespace elements on the allowlist, everything else dropped
 *    with its whole subtree (fail closed on anything unknown);
 *  - only no-namespace attributes on the allowlist, plus `href` in no
 *    namespace or the xlink namespace, and only on `use` and `image`;
 *  - a link survives only as `#id` or an inline raster picture
 *    (`data:image/png|jpeg|gif|webp;base64,…`); SVG pictures, file paths,
 *    URLs and everything else are dropped;
 *  - `url()` in a paint or reference attribute or in `style` survives only
 *    as `url(#id)`; a style declaration with a backslash (a CSS escape can
 *    spell anything) is dropped;
 *  - a DOCTYPE is refused outright (entities), and so is an undefined
 *    entity (saxes refuses it); processing instructions and comments go;
 *  - a prefixed element is dropped whatever its namespace (an export writes
 *    none), so no image hides from the image rule below;
 *  - with `keepImagesOf`, an `image` is kept only inside a `symbol` whose id
 *    names one of those scene files: the reader's own image rule, applied
 *    to what the parser sees rather than to the text;
 *  - element count and depth are capped, so a hostile snapshot costs a
 *    refusal, not the renderer's time.
 *
 * The `@font-face` rules of the snapshot's `<style>` are read out as data
 * (the renderer loads fonts from buffers) and the style element itself is
 * not kept.
 *
 * This is the first layer. The second is the renderer itself: resvg runs as
 * WebAssembly in a worker thread, with no file system to read from.
 */
import { SaxesParser, type SaxesTagNS } from 'saxes';
import { symbolFileIds } from './scene-svg';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

export const SVG_MAX_ELEMENTS = 50_000;
export const SVG_MAX_DEPTH = 64;
/** Embedded fonts read per snapshot (a real export holds a handful). */
export const SVG_MAX_FONTS = 24;
/** Base64 length of one embedded font (about 6 MB of bytes). */
const FONT_MAX_BASE64 = 8_000_000;

/** Kept as they are. `a` is kept as `g` (its link goes). */
const ELEMENTS: ReadonlySet<string> = new Set([
  'svg',
  'g',
  'defs',
  'symbol',
  'use',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'image',
  'clipPath',
  'mask',
  'linearGradient',
  'radialGradient',
  'stop',
]);
const RENAMED: Readonly<Record<string, string>> = { a: 'g' };

const ATTRIBUTES: ReadonlySet<string> = new Set([
  'id',
  'x',
  'y',
  'width',
  'height',
  'rx',
  'ry',
  'cx',
  'cy',
  'r',
  'fx',
  'fy',
  'x1',
  'y1',
  'x2',
  'y2',
  'd',
  'points',
  'viewBox',
  'preserveAspectRatio',
  'transform',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-miterlimit',
  'opacity',
  'color',
  'display',
  'visibility',
  'clip-path',
  'clip-rule',
  'mask',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-variant',
  'text-anchor',
  'dominant-baseline',
  'alignment-baseline',
  'baseline-shift',
  'direction',
  'letter-spacing',
  'word-spacing',
  'text-decoration',
  'writing-mode',
  'clipPathUnits',
  'maskUnits',
  'maskContentUnits',
  'gradientUnits',
  'gradientTransform',
  'spreadMethod',
  'offset',
  'stop-color',
  'stop-opacity',
  'style',
]);
/** Style properties kept (the presentation attributes above, minus style). */
const STYLE_PROPS: ReadonlySet<string> = new Set([...ATTRIBUTES].filter((a) => a !== 'style'));
const STYLE_EXTRA: ReadonlySet<string> = new Set(['white-space']);

const LINK_ELEMENTS: ReadonlySet<string> = new Set(['use', 'image']);
const LOCAL_REF = /^#[A-Za-z0-9_.:-]+$/;
const RASTER_DATA = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]*$/i;
const URL_FN = /url\s*\(/i;
const LOCAL_URL_ONLY = /^\s*url\(\s*(["']?)#[A-Za-z0-9_.:-]+\1\s*\)\s*$/i;

export type EmbeddedFontSource = { family: string; base64: string };

export type SanitizedSvg = {
  svg: string;
  fonts: EmbeddedFontSource[];
  /** The scene's viewBox before any region. */
  sceneBox: [number, number, number, number];
};

export type SvgRegion = { x: number; y: number; width: number; height: number };

function esc(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A link value the renderer may follow, or null. */
export function allowedHref(v: string): string | null {
  const t = v.trim();
  if (LOCAL_REF.test(t)) return t;
  if (RASTER_DATA.test(t)) return t.replace(/\s+/g, '');
  return null;
}

/** An attribute value that names something by url(): only url(#id). */
function attrValue(name: string, value: string): string | null {
  if (name === 'style') return styleValue(value);
  if (URL_FN.test(value)) return LOCAL_URL_ONLY.test(value) ? value.trim() : null;
  if (value.includes('\\')) return null;
  return value;
}

function styleValue(style: string): string | null {
  const kept: string[] = [];
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).trim();
    if (!value || value.includes('\\') || /[@<>]/.test(value)) continue;
    if (!STYLE_PROPS.has(prop) && !STYLE_EXTRA.has(prop)) continue;
    if (URL_FN.test(value) && !LOCAL_URL_ONLY.test(value)) continue;
    kept.push(`${prop}:${value}`);
  }
  return kept.length ? kept.join(';') : null;
}

const FONT_FACE = /@font-face\s*\{([^}]*)\}/gi;
const FONT_FAMILY_DECL = /font-family\s*:\s*([^;]+)/i;
const FONT_DATA_URL =
  /url\(\s*(["']?)data:(?:font\/(?:woff2|ttf|otf|sfnt)|application\/(?:font-woff2|x-font-ttf|octet-stream));base64,([A-Za-z0-9+/=]+)\1\s*\)/gi;

function fontsOf(css: string, into: EmbeddedFontSource[]): void {
  for (const face of css.matchAll(FONT_FACE)) {
    const body = face[1] ?? '';
    const family = (FONT_FAMILY_DECL.exec(body)?.[1] ?? '')
      .trim()
      .replace(/^["']|["']$/g, '')
      .trim();
    for (const m of body.matchAll(FONT_DATA_URL)) {
      if (into.length >= SVG_MAX_FONTS) return;
      const b64 = m[2] ?? '';
      if (b64.length > FONT_MAX_BASE64) continue;
      into.push({ family, base64: b64 });
    }
  }
}

function viewBoxOf(attrs: Record<string, string>): [number, number, number, number] | null {
  const vb = attrs.viewBox
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (vb && vb.length === 4 && vb.every(Number.isFinite) && vb[2]! > 0 && vb[3]! > 0) {
    return vb as [number, number, number, number];
  }
  const w = parseFloat(attrs.width ?? '');
  const h = parseFloat(attrs.height ?? '');
  return w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h) ? [0, 0, w, h] : null;
}

/**
 * Parse and rebuild a snapshot. Throws (with a reason) when it is not a
 * well-formed SVG document, carries a DOCTYPE or an unknown entity, has no
 * usable size, or passes the element or depth cap.
 */
export function sanitizeSceneSvg(
  input: string,
  opts: {
    region?: SvgRegion;
    /** Scene file ids whose image the reader may see; absent = all. */
    keepImagesOf?: ReadonlySet<string>;
  } = {},
): SanitizedSvg {
  const parser = new SaxesParser({ xmlns: true, position: false });
  const out: string[] = [];
  const fonts: EmbeddedFontSource[] = [];
  /** Per open element: the name written, or null when its subtree is dropped. */
  const stack: (string | null)[] = [];
  /** Per open symbol: whether its image may be shown. */
  const symbols: boolean[] = [];
  let dropDepth = 0;
  let inStyle = false;
  let styleText = '';
  let elements = 0;
  let rootSeen = false;
  let sceneBox: [number, number, number, number] | null = null;

  parser.on('doctype', () => {
    throw new Error('the snapshot carries a DOCTYPE');
  });
  parser.on('opentag', (tag: SaxesTagNS) => {
    elements++;
    if (elements > SVG_MAX_ELEMENTS) throw new Error('the snapshot has too many elements');
    if (stack.length >= SVG_MAX_DEPTH) throw new Error('the snapshot nests too deep');
    if (dropDepth > 0) {
      dropDepth++;
      stack.push(null);
      return;
    }
    const svgNs = tag.uri === SVG_NS;
    if (!rootSeen) {
      rootSeen = true;
      if (!svgNs || tag.local !== 'svg') throw new Error('the snapshot is not an SVG document');
      const attrs: Record<string, string> = {};
      for (const a of Object.values(tag.attributes)) if (!a.uri) attrs[a.local] = a.value;
      sceneBox = viewBoxOf(attrs);
      if (!sceneBox)
        throw new Error('the snapshot has no usable size (no viewBox or width/height)');
      let [x, y, w, h] = sceneBox;
      if (opts.region) {
        const [sx, sy, sw, sh] = sceneBox;
        x = sx + opts.region.x * sw;
        y = sy + opts.region.y * sh;
        w = opts.region.width * sw;
        h = opts.region.height * sh;
      }
      out.push(`<svg xmlns="${SVG_NS}" viewBox="${x} ${y} ${w} ${h}" width="${w}" height="${h}">`);
      stack.push('svg');
      return;
    }
    if (svgNs && tag.local === 'style') {
      inStyle = true;
      styleText = '';
      dropDepth = 1;
      stack.push(null);
      return;
    }
    const name =
      svgNs && !tag.prefix
        ? (RENAMED[tag.local] ?? (ELEMENTS.has(tag.local) ? tag.local : null))
        : null;
    const imageHidden =
      name === 'image' && opts.keepImagesOf !== undefined && symbols[symbols.length - 1] !== true;
    if (!name || name === 'svg' || imageHidden) {
      dropDepth = 1;
      stack.push(null);
      return;
    }
    if (name === 'symbol') {
      const id = Object.values(tag.attributes).find((a) => !a.uri && a.local === 'id')?.value ?? '';
      symbols.push(
        opts.keepImagesOf === undefined ||
          symbolFileIds(` id="${id}"`).some((f) => opts.keepImagesOf!.has(f)),
      );
    }
    const parts: string[] = [name];
    for (const a of Object.values(tag.attributes)) {
      const isHref = a.local === 'href' && (a.uri === '' || a.uri === XLINK_NS);
      if (isHref) {
        if (!LINK_ELEMENTS.has(name)) continue;
        const href = allowedHref(a.value);
        if (href) parts.push(`href="${esc(href)}"`);
        continue;
      }
      if (a.uri || !ATTRIBUTES.has(a.local)) continue;
      const v = attrValue(a.local, a.value);
      if (v !== null) parts.push(`${a.local}="${esc(v)}"`);
    }
    out.push(`<${parts.join(' ')}>`);
    stack.push(name);
  });
  parser.on('text', (t: string) => {
    if (inStyle) styleText += t;
    else if (dropDepth === 0 && stack.length > 0) out.push(esc(t));
  });
  parser.on('cdata', (t: string) => {
    if (inStyle) styleText += t;
    else if (dropDepth === 0 && stack.length > 0) out.push(esc(t));
  });
  parser.on('closetag', () => {
    const name = stack.pop();
    if (dropDepth > 0) {
      dropDepth--;
      if (dropDepth === 0 && inStyle) {
        inStyle = false;
        fontsOf(styleText, fonts);
      }
      return;
    }
    if (name === 'symbol') symbols.pop();
    if (name) out.push(`</${name}>`);
  });
  parser.write(input).close();
  if (!sceneBox) throw new Error('the snapshot is not an SVG document');
  return { svg: out.join(''), fonts, sceneBox };
}
