/**
 * Theme generator — seeds.mjs -> styles/themes.css + the generated picker
 * registry. Run via `pnpm themes:build` (or `node themes/generate.mjs`);
 * `--check` regenerates in memory and fails on drift (CI calls this through
 * the drift test); `--report` prints every token that differs from a given
 * baseline css, with ΔE, so a repaint is measured instead of assumed.
 *
 * WHAT IS AUTHORED VS DERIVED
 *   verbatim from seeds….  surfaces (background/card/popover/muted/secondary/
 *                          accent/sidebar/sidebar-accent), fills (primary/
 *                          destructive), decor (border/input/sidebar-border),
 *                          non-colour extras, and pinnacle's brand chart ramp.
 *   solved (anchored)…….  every -foreground (anchor: the authored value, so a
 *                          passing pair ships unchanged), every -ink (anchor:
 *                          its fill), ring/sidebar-ring at the 3:1 non-text
 *                          bar, the semantic roles, the code palette, and the
 *                          categorical chart ramp.
 *
 * THE CONTRACTS (all measured on the emitted 8-bit hex)
 *   4.5:1  text — each -foreground on its own fill; `foreground` on every
 *          neutral surface; `muted-foreground` on muted + the neutrals; every
 *          ink (primary/destructive/success/warning/info/code-*) on every
 *          neutral surface, because ~330 call sites use inks without declaring
 *          a background.
 *   3.0:1  non-text — ring against background+card, sidebar-ring against
 *          sidebar, generated chart colours against background+card.
 *          (A seeded `charts` override is authored brand artwork and is
 *          exempt — pinnacle's ramp is identity, not data ink.)
 *
 * SEMANTIC ROLES. success/warning/info sit beside destructive: one global hue
 * each, chroma borrowed from the theme (max of primary/destructive chroma,
 * clamped) so `mono` gets them as quiet as its own destructive and `cyberpunk`
 * gets them loud, lightness solved per theme. A new role is one line in
 * ROLE_HUES — never another 168 hand-picked hex values.
 *
 * CODE PALETTE. `code-keyword` keeps the THEME's primary hue (the brand accent
 * survives into code blocks); string/number/title/variable are fixed semantic
 * hues (strings read green in every theme), nudged away from the keyword hue
 * when a theme's primary would collide with one of them.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { THEME_SEEDS } from './seeds.mjs';
import {
  cssToHex,
  deltaE,
  hueDistance,
  oklchToSrgb,
  parseOklch,
  solvePair,
  solveText,
  toHex,
} from './model.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CSS_PATH = join(HERE, '..', 'styles', 'themes.css');
const REGISTRY_PATH = join(HERE, '..', 'src', 'lib', 'theme-registry.gen.ts');

// ── structural defaults (must match seeds.mjs docs) ──────────────────────────
const DEFAULTS = {
  'card-foreground': 'foreground',
  popover: 'card',
  'popover-foreground': 'card-foreground',
  'secondary-foreground': 'foreground',
  'accent-foreground': 'foreground',
  input: 'border',
  ring: 'primary',
  sidebar: 'muted',
  'sidebar-foreground': 'foreground',
  'sidebar-primary': 'primary',
  'sidebar-primary-foreground': 'primary-foreground',
  'sidebar-accent': 'accent',
  'sidebar-accent-foreground': 'accent-foreground',
  'sidebar-border': 'border',
  'sidebar-ring': 'ring',
};

/** Surfaces every unscoped ink can land on (mirrors the audit + ink tests). */
const NEUTRALS = ['background', 'card', 'popover', 'muted', 'sidebar'];

/** Semantic roles beside `destructive`. Adding a role = adding a line. */
export const ROLE_HUES = { success: 150, warning: 80, info: 245 };

/** Fixed hues of the code palette (keyword takes the theme's primary hue). */
const CODE_HUES = { string: 150, number: 75, title: 245, variable: 330 };

/** Relative hue steps of the generated categorical chart ramp (from primary). */
const CHART_HUE_STEPS = [0, 72, 144, 216, 288];

const clampC = (c, lo, hi) => Math.min(hi, Math.max(lo, c));

/** Resolve a seed mode through the default chain to all 27 authored tokens. */
export function resolveSeed(mode) {
  const t = { ...mode };
  delete t.charts;
  delete t.extras;
  for (const [token, fallback] of Object.entries(DEFAULTS)) {
    if (!(token in t)) {
      // fallbacks can chain (sidebar-ring -> ring -> primary)
      let v = fallback;
      while (!(v in t)) {
        if (!(v in DEFAULTS)) throw new Error(`unresolvable default for --${token}`);
        v = DEFAULTS[v];
      }
      t[token] = t[v];
    }
  }
  return t;
}

/** Pure-function memo: seeds are immutable module data, and the CSS, the
 *  registry and the test suites all re-derive the same modes — solving each
 *  (seed, mode) once keeps the whole pipeline O(themes), not O(callers). */
const MODE_MEMO = new WeakMap();

/** Generate the full token map for one theme mode. */
export function generateMode(modeSeed, { mode }) {
  const hit = MODE_MEMO.get(modeSeed);
  if (hit?.[mode]) return { ...hit[mode] };
  const out = generateModeUncached(modeSeed, { mode });
  MODE_MEMO.set(modeSeed, { ...hit, [mode]: out });
  return { ...out };
}

/** solveText, but refusing to emit an unmeetable contract. Infeasibility means
 *  the surfaces span mid-luminance in a way NO single ink can clear (one
 *  surface needs light text, another dark) — a seed problem, and the author
 *  should hear it as a generator error naming the surfaces, not as a cryptic
 *  contrast-test failure three artifacts downstream. */
function mustSolve(anchorCss, against, opts) {
  const r = solveText(anchorCss, against, opts);
  if (!r.feasible) {
    throw new Error(
      `no feasible ink: anchor ${anchorCss} cannot clear ${opts?.ratio ?? 4.5}:1 against ` +
        `[${against.join(', ')}] — the surfaces demand light AND dark text at once; fix the seed`,
    );
  }
  return r;
}

function generateModeUncached(modeSeed, { mode }) {
  const s = resolveSeed(modeSeed);
  const out = {};
  const dark = mode === 'dark';

  // 1. Neutral surfaces and decor — the theme's canvas, verbatim. These are
  //    what every text token is solved AGAINST; they never move.
  for (const token of [
    'background',
    'card',
    'popover',
    'muted',
    'sidebar',
    'border',
    'input',
    'sidebar-border',
  ]) {
    out[token] = s[token];
  }

  // 2. Branded fills + their own -foreground — solved as a PAIR. A pair the
  //    theme authored consistently ships verbatim; a broken one moves
  //    whichever side shifts least (fill weighted heavier). See solvePair.
  for (const [fill, fg] of [
    ['primary', 'primary-foreground'],
    ['secondary', 'secondary-foreground'],
    ['accent', 'accent-foreground'],
    ['destructive', 'destructive-foreground'],
    ['sidebar-primary', 'sidebar-primary-foreground'],
    ['sidebar-accent', 'sidebar-accent-foreground'],
  ]) {
    const pair = solvePair(s[fill], s[fg]);
    out[fill] = pair.fill;
    out[fg] = pair.fg;
  }

  // 3. Text on the neutral canvas — anchored on the authored value.
  out.foreground = mustSolve(
    s.foreground,
    NEUTRALS.map((n) => out[n]),
  ).hex;
  out['card-foreground'] = mustSolve(s['card-foreground'], [out.card]).hex;
  out['popover-foreground'] = mustSolve(s['popover-foreground'], [out.popover]).hex;
  out['sidebar-foreground'] = mustSolve(s['sidebar-foreground'], [out.sidebar]).hex;
  out['muted-foreground'] = mustSolve(
    s['muted-foreground'],
    NEUTRALS.map((n) => out[n]),
  ).hex;

  // 4. Inks — the fill's colour, at whatever lightness survives every surface.
  const neutralSurfaces = NEUTRALS.map((n) => out[n]);
  out['primary-ink'] = mustSolve(out.primary, neutralSurfaces).hex;
  out['destructive-ink'] = mustSolve(out.destructive, neutralSurfaces).hex;

  // 5. Semantic roles — global hue, the theme's own chroma and weight, and
  //    the SAME on-fill text convention as their sibling `destructive` (a
  //    theme whose destructive wears white gets white on success too — the
  //    pair solve deepens the fill to hold it, exactly as it would have for a
  //    hand-authored pair).
  const [pL, pC] = parseOklch(out.primary);
  const [dL, dC] = parseOklch(out.destructive);
  const roleC = clampC(Math.max(pC, dC), 0.05, 0.16);
  const roleL = dC >= 0.05 ? dL : pL; // sibling weight: match destructive when it is chromatic
  const dHue = parseOklch(out.destructive)[2];
  for (const [role, baseHue] of Object.entries(ROLE_HUES)) {
    // A destructive that drifts toward a role's hue (doom-64's is orange)
    // would make e.g. warning and destructive the same colour — push the role
    // hue away until the two stay tellable-apart, biased toward the original.
    let hue = baseHue;
    if (dC >= 0.05 && hueDistance(hue, dHue) < 40) {
      const up = (dHue + 45 + 360) % 360;
      const down = (dHue - 45 + 360) % 360;
      hue = hueDistance(up, baseHue) <= hueDistance(down, baseHue) ? up : down;
    }
    // Solve the pair, then make sure the fill is tellable-apart from
    // destructive and the roles before it. Hue separation alone is not enough:
    // at very low lightness sRGB has no ambers, so a dark theme's warning can
    // gamut-collapse onto the exact browny-red of its destructive. When that
    // happens, walk the anchor lightness away (lighter in dark mode, darker in
    // light) and re-solve — each step only gains distance.
    const siblings = ['destructive', ...Object.keys(ROLE_HUES).filter((r) => r in out)];
    let L = roleL;
    let pair;
    for (let i = 0; i < 12; i++) {
      pair = solvePair(toHex(oklchToSrgb([L, roleC, hue])), out['destructive-foreground']);
      if (siblings.every((sib) => deltaE(pair.fill, out[sib]) >= 0.06)) break;
      L = Math.min(0.95, Math.max(0.05, L + (dark ? 0.04 : -0.04)));
    }
    out[role] = pair.fill;
    out[`${role}-foreground`] = pair.fg;
    out[`${role}-ink`] = mustSolve(pair.fill, neutralSurfaces).hex;
  }

  // 6. Code palette — inks by contract (code sits on --muted, but like every
  //    ink these land wherever `.code-view` happens to be mounted). Keywords
  //    keep the brand: they anchor on primary-ink, which is already ink-safe,
  //    so in most themes `code-keyword` IS the primary ink at full chroma.
  const keywordHue = pC >= 0.02 ? parseOklch(out.primary)[2] : 300;
  const codeC = clampC(Math.max(pC, dC), 0.05, 0.14);
  const codeAnchorL = dark ? 0.75 : 0.5;
  out['code-keyword'] = mustSolve(out['primary-ink'], neutralSurfaces).hex;
  for (const [role, hue] of Object.entries(CODE_HUES)) {
    // a primary too close to a semantic code hue would make two token kinds
    // identical — push the fixed hue away, keyword keeps the brand.
    const h = hueDistance(hue, keywordHue) < 25 ? (hue + 40) % 360 : hue;
    out[`code-${role}`] = mustSolve(
      toHex(oklchToSrgb([codeAnchorL, codeC, h])),
      neutralSurfaces,
    ).hex;
  }

  // 7. Focus rings — non-text, 3:1 against what they ring. A ring the seed
  //    left defaulted follows the SOLVED fill, not the authored one.
  out.ring = mustSolve(modeSeed.ring ?? out.primary, [out.background, out.card], {
    ratio: 3,
  }).hex;
  out['sidebar-ring'] = mustSolve(modeSeed['sidebar-ring'] ?? out.ring, [out.sidebar], {
    ratio: 3,
  }).hex;

  // 8. Charts — categorical data ink. Seeded override = authored brand ramp,
  //    exempt; otherwise five distinguishable hues anchored on the brand.
  if (modeSeed.charts) {
    modeSeed.charts.forEach((c, i) => (out[`chart-${i + 1}`] = c));
  } else if (pC < 0.02) {
    // achromatic theme: a lightness ramp keeps its character. Solve the step
    // NEAREST the surfaces once (the 3:1 floor), then ladder strictly away
    // from them — every further step only gains contrast, and the fixed ΔL
    // keeps the five steps tellable-apart (solving each independently used to
    // collapse chart-4 and chart-5 onto the same grey).
    const floor = mustSolve(
      toHex(oklchToSrgb([dark ? 0.5 : 0.6, 0, 0])),
      [out.background, out.card],
      {
        ratio: 3,
      },
    );
    const floorL = parseOklch(floor.hex)[0];
    for (let i = 0; i < 5; i++) {
      const L = Math.min(0.97, Math.max(0.05, floorL + (dark ? 1 : -1) * i * 0.1));
      out[`chart-${i + 1}`] = toHex(oklchToSrgb([L, 0, 0]));
    }
  } else {
    const chartC = clampC(Math.max(pC, dC), 0.06, 0.15);
    const baseL = dark ? 0.7 : 0.55;
    CHART_HUE_STEPS.forEach((step, i) => {
      const hue = (keywordHue + step) % 360;
      // chart-1 keeps the brand affinity most authored ramps had: it anchors
      // at the primary's own lightness, so it reads as "the theme's colour".
      out[`chart-${i + 1}`] = mustSolve(
        toHex(oklchToSrgb([i === 0 ? pL : baseL, chartC, hue])),
        [out.background, out.card],
        { ratio: 3 },
      ).hex;
    });
  }

  return out;
}

// ── emission ─────────────────────────────────────────────────────────────────

/** Canonical token order for a theme block (stable, review-friendly diffs). */
const EMIT_ORDER = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'primary-ink',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'destructive-ink',
  'success',
  'success-foreground',
  'success-ink',
  'warning',
  'warning-foreground',
  'warning-ink',
  'info',
  'info-foreground',
  'info-ink',
  'code-keyword',
  'code-string',
  'code-number',
  'code-title',
  'code-variable',
  'border',
  'input',
  'ring',
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'sidebar',
  'sidebar-foreground',
  'sidebar-primary',
  'sidebar-primary-foreground',
  'sidebar-accent',
  'sidebar-accent-foreground',
  'sidebar-border',
  'sidebar-ring',
];

function emitBlock(selector, tokens, extras) {
  const lines = [`${selector} {`];
  for (const t of EMIT_ORDER) lines.push(`  --${t}: ${tokens[t]};`);
  for (const [k, v] of Object.entries(extras ?? {})) lines.push(`  --${k}: ${v};`);
  lines.push('}');
  return lines.join('\n');
}

const THEME_INLINE = `@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  /* INK, not fill. A fill is tuned to sit BEHIND its own -foreground; as text
     on a neutral surface it is a different job, and -ink is the derived token
     that does it. Bare text-primary / text-destructive / text-success /
     text-warning / text-info are lint errors (mantle/use-ink-for-text). */
  --color-primary-ink: var(--primary-ink);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-destructive-ink: var(--destructive-ink);
  --color-success: var(--success);
  --color-success-foreground: var(--success-foreground);
  --color-success-ink: var(--success-ink);
  --color-warning: var(--warning);
  --color-warning-foreground: var(--warning-foreground);
  --color-warning-ink: var(--warning-ink);
  --color-info: var(--info);
  --color-info-foreground: var(--info-foreground);
  --color-info-ink: var(--info-ink);
  /* The code palette is ink-only (no fills): hljs rules use the vars directly,
     and these mappings give JSX the same colours (json-tree, code chips). */
  --color-code-keyword: var(--code-keyword);
  --color-code-string: var(--code-string);
  --color-code-number: var(--code-number);
  --color-code-title: var(--code-title);
  --color-code-variable: var(--code-variable);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-chart-1: var(--chart-1);
  --color-chart-2: var(--chart-2);
  --color-chart-3: var(--chart-3);
  --color-chart-4: var(--chart-4);
  --color-chart-5: var(--chart-5);
  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-ring: var(--sidebar-ring);

  --font-sans: var(--font-sans);
  --font-mono: var(--font-mono);
  --font-serif: var(--font-serif);
  --font-logo: var(--font-logo);

  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);

  --shadow-2xs: var(--shadow-2xs);
  --shadow-xs: var(--shadow-xs);
  --shadow-sm: var(--shadow-sm);
  --shadow: var(--shadow);
  --shadow-md: var(--shadow-md);
  --shadow-lg: var(--shadow-lg);
  --shadow-xl: var(--shadow-xl);
  --shadow-2xl: var(--shadow-2xl);

  --tracking-tighter: calc(var(--tracking-normal) - 0.05em);
  --tracking-tight: calc(var(--tracking-normal) - 0.025em);
  --tracking-normal: var(--tracking-normal);
  --tracking-wide: calc(var(--tracking-normal) + 0.025em);
  --tracking-wider: calc(var(--tracking-normal) + 0.05em);
  --tracking-widest: calc(var(--tracking-normal) + 0.1em);
}`;

export function generateCss() {
  const parts = [
    `/* GENERATED FILE — do not edit. \`pnpm themes:build\` regenerates it from
 * themes/seeds.mjs (the authored source); the drift test fails CI if the two
 * disagree. Every -foreground and -ink below is SOLVED against the surfaces it
 * must be legible on (see themes/generate.mjs for the contracts), so a token
 * here is correct by construction — fix a colour in seeds.mjs, never here.
 *
 * Imported via \`@import '@mantle/web-ui/styles/themes.css';\` by both Next
 * apps, inside the Tailwind bundle (tokens must precede @layer base). */`,
  ];
  const [base, ...rest] = THEME_SEEDS;
  if (base.id !== 'clean-slate') throw new Error('clean-slate must stay the baseline seed');
  parts.push(emitBlock(':root', generateMode(base.light, { mode: 'light' }), base.light.extras));
  parts.push(emitBlock('.dark', generateMode(base.dark, { mode: 'dark' }), base.dark.extras));
  for (const t of rest) {
    parts.push(
      emitBlock(
        `[data-color-theme="${t.id}"]`,
        generateMode(t.light, { mode: 'light' }),
        t.light.extras,
      ),
    );
    parts.push(
      emitBlock(
        `.dark[data-color-theme="${t.id}"]`,
        generateMode(t.dark, { mode: 'dark' }),
        t.dark.extras,
      ),
    );
  }
  parts.push(THEME_INLINE);
  return parts.join('\n\n') + '\n';
}

export function generateRegistry() {
  const rows = THEME_SEEDS.map((t) => {
    const light = generateMode(t.light, { mode: 'light' });
    const swatches = [light.primary, light.accent, light.background];
    return `  { id: '${t.id}', label: '${t.label}', swatches: [${swatches.map((s) => `'${s}'`).join(', ')}] },`;
  });
  return `/* GENERATED FILE — do not edit. \`pnpm themes:build\` regenerates it from
 * themes/seeds.mjs. Swatches are [primary, accent, background] of the
 * generated light mode, so the picker preview can never desync from the CSS. */
import type { ColorTheme } from './themes';

export const GENERATED_COLOR_THEMES: ColorTheme[] = [
${rows.join('\n')}
];
`;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// Guarded to direct execution: the drift test IMPORTS generateCss/
// generateRegistry, and an import must never write or exit.
const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (!invokedDirectly) {
  // imported as a library — expose the pure functions only
} else main(process.argv[2]);

function main(arg) {
  if (arg === '--check') {
    const cssOk = readFileSync(CSS_PATH, 'utf8') === generateCss();
    const regOk = readFileSync(REGISTRY_PATH, 'utf8') === generateRegistry();
    if (!cssOk || !regOk) {
      console.error(
        `drift: ${[!cssOk && 'styles/themes.css', !regOk && 'src/lib/theme-registry.gen.ts']
          .filter(Boolean)
          .join(', ')} do not match themes/seeds.mjs — run \`pnpm themes:build\``,
      );
      process.exit(1);
    }
    console.log('themes.css + registry match seeds');
  } else if (arg === '--report') {
    // Fidelity report: what would visibly change vs the css at `baseline` path.
    const baselinePath = process.argv[3] ?? CSS_PATH;
    const baseline = readFileSync(baselinePath, 'utf8');
    const blockOf = (selector) => {
      const at = baseline.indexOf(`${selector} {`);
      if (at < 0) return null;
      const body = baseline.slice(at, baseline.indexOf('\n}', at));
      const t = {};
      for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) t[m[1]] = m[2].trim();
      return t;
    };
    const rootBase = blockOf(':root');
    const buckets = {};
    let moved = 0;
    let total = 0;
    for (const t of THEME_SEEDS) {
      for (const mode of ['light', 'dark']) {
        const sel =
          t.id === 'clean-slate'
            ? mode === 'light'
              ? ':root'
              : '.dark'
            : mode === 'light'
              ? `[data-color-theme="${t.id}"]`
              : `.dark[data-color-theme="${t.id}"]`;
        const authored = { ...rootBase, ...(blockOf(sel) ?? {}) };
        const gen = generateMode(t[mode], { mode });
        for (const [token, hex] of Object.entries(gen)) {
          if (!authored[token]) continue; // new token, nothing to compare
          total++;
          const d = deltaE(hex, authored[token]);
          if (d < 0.005) continue;
          moved++;
          (buckets[token] ??= []).push({
            id: `${t.id}/${mode}`,
            d,
            from: cssToHex(authored[token]),
            to: hex,
          });
        }
      }
    }
    console.log(`moved ${moved} of ${total} pre-existing token values (ΔE ≥ 0.005)\n`);
    for (const [token, list] of Object.entries(buckets).sort((a, b) => b[1].length - a[1].length)) {
      list.sort((a, b) => b.d - a.d);
      const worst = list
        .slice(0, 3)
        .map((x) => `${x.id} ${x.from}→${x.to} ΔE ${x.d.toFixed(3)}`)
        .join('; ');
      console.log(`  --${token}: ${list.length} moved   worst: ${worst}`);
    }
  } else {
    writeFileSync(CSS_PATH, generateCss());
    writeFileSync(REGISTRY_PATH, generateRegistry());
    console.log(`wrote ${CSS_PATH}\nwrote ${REGISTRY_PATH}`);
  }
}
