/**
 * Theme mode: the drawing in the colours of the page it sits in. A mini app
 * (`render(..., { theme: 'tokens' })`) draws a template inline in its own
 * document, which carries the app's theme tokens (`--card`, `--foreground`,
 * `--chart-1` ...) and switches them on a live theme change.
 *
 * The drawing itself is untouched: every colour stays the house colour in
 * its `fill` or `stroke` attribute. Theme mode adds one stylesheet that maps
 * each house colour to a token by attribute selector. A CSS rule wins over a
 * presentation attribute, so the page's tokens paint the drawing, and a theme
 * switch restyles it with no redraw. Without the option nothing is added,
 * so a Present canvas, `diagram_render` and `present_export` draw exactly
 * as before (the static export must hold no CSS variables anyway).
 *
 * Line meaning does not ride colour alone: dash patterns, weights, arrow
 * heads and symbols are attributes and stay as they are. Only the colours
 * move, each to the token of the same role (ink to `--foreground`, the
 * muted inks to `--muted-foreground`, paper to `--card`, the series to the
 * chart ramp), so the contrast a role has in light it has in dark.
 *
 * A colour the data names itself (`#rrggbb` on a circuit or a service) is
 * the author's and is left alone.
 */
import { NODE_KINDS, PALETTE, ROLE_COLOURS, SERIES, opaque } from './style.ts';

/** Where a house ink goes: the token of the same role. */
const INKS: Record<string, string> = {
  '45,49,66': 'var(--foreground)', // ink
  '79,93,117': 'var(--muted-foreground)', // muted
  '191,69,32': 'var(--primary)', // accent
};

/** A translucent house ink as the same token at the same strength, either
 *  over nothing (a stroke) or flattened onto the card (a fill, as `opaque`
 *  flattens it onto paper). */
function tinted(rgba: string, over: 'transparent' | 'var(--card)'): string | null {
  const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(rgba);
  const ink = m ? INKS[`${m[1]},${m[2]},${m[3]}`] : undefined;
  if (!m || !ink) return null;
  return `color-mix(in oklab, ${ink} ${Math.round(Number(m[4]) * 100)}%, ${over})`;
}

/** Every house colour the templates draw with, and its token. */
export const THEME_COLOURS: Readonly<Record<string, string>> = (() => {
  const map: Record<string, string> = {
    [PALETTE.paper]: 'var(--card)',
    [PALETTE.paper2]: 'var(--muted)',
    [PALETTE.white]: 'var(--background)',
    [PALETTE.ink]: 'var(--foreground)',
    [PALETTE.muted]: 'var(--muted-foreground)',
    [PALETTE.soft]: 'var(--muted-foreground)',
    [PALETTE.rule]: 'var(--border)',
    [PALETTE.ruleSolid]: 'var(--border)',
    [PALETTE.accent]: 'var(--primary)',
    [PALETTE.accentTint]: 'color-mix(in oklab, var(--primary) 12%, var(--card))',
    [PALETTE.link]: 'var(--chart-2)',
  };
  Object.values(SERIES).forEach((hex, i) => (map[hex] = `var(--chart-${i + 1})`));
  // The node treatments: translucent strokes, and fills flattened on paper.
  for (const k of Object.values(NODE_KINDS)) {
    const stroke = tinted(k.stroke, 'transparent');
    if (stroke) map[k.stroke] = stroke;
  }
  for (const src of [
    'rgba(45,49,66,0.05)',
    'rgba(45,49,66,0.03)',
    'rgba(45,49,66,0.02)',
    'rgba(79,93,117,0.10)',
    'rgba(191,69,32,0.05)',
  ]) {
    map[opaque(src)] = tinted(src, 'var(--card)')!;
  }
  return map;
})();

/** Text in a series colour (a circuit label, a service colour): the chart
 *  ramp is tuned for fills and lines, and small text needs more contrast, so
 *  the token takes a quarter of the foreground. Drawn as a line, the same
 *  series keeps its plain token. */
export const THEME_TEXT_COLOURS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.values(SERIES).map((hex, i) => [
    hex,
    `color-mix(in oklab, var(--chart-${i + 1}) 75%, var(--foreground))`,
  ]),
);

/** A role's token: its own variable (an app may set it), else the theme's
 *  ink of the role's hue, else (a page without the inks) the plain token. */
const role = (name: string, ink: string, plain: string) =>
  `var(--diagram-${name}, ${ink.startsWith('color-mix') ? ink : `var(--${ink}, ${plain})`})`;
/** Two inks mixed half and half (a role between two hues). */
const between = (a: string, b: string) => `color-mix(in oklab, var(--${a}) 50%, var(--${b}))`;

/** The colour set's roles (style 2) and their tokens: one each, no two the
 *  same. Each is one of the theme's inks (share-ui themes.css: every
 *  `-ink` and `code-` token is solved to 4.5:1 on every neutral surface,
 *  the card among them, in light and in dark), or half and half of two
 *  (contradicted red-violet, link teal), so a role keeps the contrast a
 *  line (3:1) and its text (4.5:1) need in every theme
 *  (colour-set.test.ts reads them all). The chart ramp is tuned for fills
 *  and falls short on some themes' cards. Drawn only for a style 2
 *  drawing (`themeSvg`), so a classic drawing, or a profile colour that
 *  happens to equal a role's, themes as before. Text takes a quarter of
 *  the foreground, as the series do. */
export const THEME_ROLE_COLOURS: Readonly<Record<string, string>> = {
  [ROLE_COLOURS.main]: role('main', 'destructive-ink', 'var(--destructive)'),
  [ROLE_COLOURS.branch]: role('branch', 'info-ink', 'var(--chart-2)'),
  [ROLE_COLOURS.deadleg]: role('deadleg', 'code-number', 'var(--chart-3)'),
  [ROLE_COLOURS.instrument]: role('instrument', 'code-variable', 'var(--chart-5)'),
  [ROLE_COLOURS.guess]: role('guess', 'warning-ink', 'var(--chart-4)'),
  [ROLE_COLOURS.checked]: role('checked', 'success-ink', 'var(--chart-1)'),
  [ROLE_COLOURS.contradicted]: role(
    'contradicted',
    between('destructive-ink', 'code-variable'),
    'var(--destructive)',
  ),
  [ROLE_COLOURS.corrected]: role('corrected', 'primary-ink', 'var(--primary)'),
  [ROLE_COLOURS.link]: role('link', between('info-ink', 'success-ink'), 'var(--chart-2)'),
};

/** The attribute that marks a themed drawing; the stylesheet is scoped to it,
 *  since a `<style>` inside inline SVG applies to the whole document. */
export const THEME_ATTR = 'data-mantle-theme';

function themeCss(svg: string, style: number): string {
  const rules: string[] = [];
  for (const [house, token] of Object.entries(THEME_COLOURS)) {
    for (const prop of ['fill', 'stroke']) {
      rules.push(`svg[${THEME_ATTR}] [${prop}="${house}"]{${prop}:${token}}`);
    }
  }
  // After the general rules, and more specific, so text takes these.
  for (const [house, css] of Object.entries(THEME_TEXT_COLOURS)) {
    rules.push(`svg[${THEME_ATTR}] text[fill="${house}"]{fill:${css}}`);
  }
  for (const [hex, token] of Object.entries(style >= 2 ? THEME_ROLE_COLOURS : {})) {
    if (!svg.includes(`"${hex}"`)) continue;
    for (const prop of ['fill', 'stroke'])
      rules.push(`svg[${THEME_ATTR}] [${prop}="${hex}"]{${prop}:${token}}`);
    rules.push(
      `svg[${THEME_ATTR}] text[fill="${hex}"]{fill:color-mix(in oklab, ${token} 75%, var(--foreground))}`,
    );
  }
  return rules.join('');
}

/** The drawing, themed: the marker on its root and the stylesheet first.
 *  `style`: the drawing's style edition (style.ts); the colour set's roles
 *  are themed only from 2. */
export function themeSvg(svg: string, style = 1): string {
  const open = /^<svg\b[^>]*>/.exec(svg);
  if (!open) return svg;
  const root = open[0].replace(/^<svg\b/, `<svg ${THEME_ATTR}="tokens"`);
  return `${root}<style>${themeCss(svg, style)}</style>${svg.slice(open[0].length)}`;
}
