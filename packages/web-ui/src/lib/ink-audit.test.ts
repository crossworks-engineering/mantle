import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COLOR_THEMES } from './themes';
import { parseThemeBlocks } from './theme-css-blocks';

/**
 * INK AUDIT — discovers what is used as text, instead of being told.
 *
 * `themes.test.ts` asserts a hand-written list of pairs. That is exactly why
 * three separate instances of the same bug survived a session spent on
 * contrast: a contract only covers the tokens it enumerates. The accent pair
 * was listed, so it was caught. `chart-3` was not, so `hljs-title` rendered
 * function names at 1.02:1 — the same colour as the code background — on the
 * `claude` theme, and a user found it.
 *
 * So this test does not enumerate. It SCANS every `color:` declaration in the
 * shipped CSS, resolves which token each one paints with, and measures that
 * token against the surfaces it can land on, in every theme and both modes.
 * A new `color: var(--whatever)` is audited the moment it is written, by
 * nobody's decision.
 *
 * The rule it enforces: a token used as text must be either
 *   (a) INK-SAFE — it clears AA on every neutral surface in every theme, or
 *   (b) SCOPED — declared below as only ever landing on specific surfaces,
 *       and it clears AA on those.
 * Anything else fails, and the fix is a `-ink` token (see `--primary-ink`).
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const THEME_CSS = readFileSync(join(HERE, '..', '..', 'styles', 'themes.css'), 'utf8');

/** Every stylesheet that ships to a browser. Discovered, not listed, so a new
 *  globals.css cannot quietly opt out of the audit. */
function shippedStylesheets(): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth = 0) => {
    if (depth > 4) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e === 'node_modules' || e === '.next' || e === 'dist' || e.startsWith('.')) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, depth + 1);
      else if (e.endsWith('.css') && e !== 'themes.css') out.push(p);
    }
  };
  for (const root of ['client/web/app', 'server/web/app', 'packages/web-ui/styles']) {
    walk(join(REPO, root));
  }
  return out;
}

// ── colour maths (shared shape with themes.test.ts) ──────────────────────────
const clamp = (x: number) => Math.min(1, Math.max(0, x));
const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function linear(value: string): [number, number, number] {
  const v = value.trim();
  if (v.startsWith('#')) {
    let h = v.slice(1);
    if (h.length === 3)
      h = h
        .split('')
        .map((c) => c + c)
        .join('');
    if (h.length === 8) h = h.slice(0, 6);
    return [0, 2, 4].map((i) => toLin(parseInt(h.slice(i, i + 2), 16) / 255)) as [
      number,
      number,
      number,
    ];
  }
  const args = v
    .slice(v.indexOf('(') + 1, v.lastIndexOf(')'))
    .split('/')[0]!
    .trim()
    .split(/[\s,]+/);
  if (v.startsWith('oklch')) {
    const L = args[0]!.endsWith('%') ? parseFloat(args[0]!) / 100 : parseFloat(args[0]!);
    const C = args[1]!.endsWith('%') ? (parseFloat(args[1]!) / 100) * 0.4 : parseFloat(args[1]!);
    const H = ((parseFloat(args[2] ?? '0') || 0) * Math.PI) / 180;
    const [a, b] = [C * Math.cos(H), C * Math.sin(H)];
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
      clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    ];
  }
  if (v.startsWith('hsl')) {
    const [h, sPct, lPct] = args.map((x) => parseFloat(x));
    const [S, L] = [sPct! / 100, lPct! / 100];
    const k = (n: number) => (n + h! / 30) % 12;
    const a = S * Math.min(L, 1 - L);
    const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4)].map(toLin) as [number, number, number];
  }
  throw new Error(`unsupported colour notation: ${value}`);
}

const lum = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(linear(a)), lum(linear(b))];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const BLOCKS = parseThemeBlocks(THEME_CSS);

function tokensOf(selector: string): Record<string, string> {
  const block = BLOCKS.get(selector);
  if (!block) throw new Error(`no block for ${selector}`);
  return block;
}
const resolved = (sel: string) => ({ ...tokensOf(':root'), ...tokensOf(sel) });

/** Surfaces a token can land on when nothing narrows it. */
const NEUTRAL_SURFACES = ['background', 'card', 'muted', 'popover', 'sidebar'] as const;

/**
 * Tokens that are legitimately scoped: they only ever paint text on the
 * surface(s) named here, so they are measured against those and not the rest.
 * Each entry is a CLAIM about where the token is used — narrower than the
 * conservative default, and therefore reviewable. Adding one is a decision,
 * not a workaround.
 */
const SCOPED: Record<string, readonly string[]> = {
  'card-foreground': ['card'],
  'popover-foreground': ['popover'],
  'sidebar-foreground': ['sidebar'],
  'accent-foreground': ['accent'],
  'sidebar-accent-foreground': ['sidebar-accent'],
  'primary-foreground': ['primary'],
  'secondary-foreground': ['secondary'],
  'destructive-foreground': ['destructive'],
  'success-foreground': ['success'],
  'warning-foreground': ['warning'],
  'info-foreground': ['info'],
  // (muted-foreground needs no entry: the app's standard secondary ink lands
  // anywhere, so the conservative default — every neutral surface — IS its
  // contract, and the generator solves it against exactly that set.)
};

/**
 * KNOWN-UNSAFE BASELINE — debt that existed when this audit was written, with
 * the reason and where it is tracked. The list may only ever SHRINK.
 *
 * Two rules keep it honest, and the second is the one that matters:
 *   1. A token NOT listed here must be clean → a newly-introduced bad ink fails
 *      immediately, which is the entire point of the audit.
 *   2. A token listed here must STILL be failing → the moment it is fixed, the
 *      test fails telling you to delete the entry. A baseline that can hold
 *      stale exemptions is just a mute button.
 *
 * EMPTY since the theme generator landed: every text token is now solved
 * against its surfaces at build time, the chart-as-text consumers moved to the
 * derived code + success/warning/info roles (task 002794f9), and the two
 * self-contradicting palettes were dropped. The mechanism stays: the next bad
 * ink fails CI, and parking it here is a visible, tracked decision.
 */
const KNOWN_UNSAFE: Record<string, string> = {};

/** Non-colour `color:` values that carry no token to audit. */
const IGNORED_VALUES = /^(inherit|currentcolor|transparent|unset|initial|revert)$/i;

/**
 * COMPUTED-VALUE ALLOWLIST. The audit can only measure a bare `var(--token)`;
 * a `color-mix()`, a relative `oklch(from …)` or a literal hex is opaque to
 * it. Those used to be SKIPPED SILENTLY — which is exactly how
 * `.prose-accent h3`'s color-mix() shipped below AA on 52 of 164 surfaces and
 * survived a session spent on contrast. Now an unresolvable ink FAILS unless
 * its selector is listed here with a reason, and a listed selector that stops
 * existing fails too (an allowlist that can hold stale entries is a mute
 * button, same rule as KNOWN_UNSAFE).
 */
const COMPUTED_ALLOWED: Record<string, string> = {
  '.ProseMirror .diff-removed-body':
    'struck ghost text of a REMOVED diff block — 65% foreground is deliberate de-emphasis, ' +
    'the content is decoration around its Restore pill, not information',
};

type Use = { file: string; selector: string; token: string };
type Opaque = { file: string; selector: string; value: string };

/** Every `color:` declaration painting with a theme token, plus every one the
 *  audit CANNOT resolve (computed/literal values — see COMPUTED_ALLOWED).
 *  Deliberately not `background-color` / `border-color` — those are surfaces,
 *  not ink. */
function inkUses(): { uses: Use[]; opaque: Opaque[] } {
  const uses: Use[] = [];
  const opaque: Opaque[] = [];
  for (const path of shippedStylesheets()) {
    const css = readFileSync(path, 'utf8');
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = rule[1]!.trim().split('\n').pop()!.trim();
      for (const d of rule[2]!.matchAll(/(?:^|[;{]|\s)color:\s*([^;]+)/g)) {
        const value = d[1]!.trim();
        if (IGNORED_VALUES.test(value)) continue;
        const varMatch = /^var\(--([a-z0-9-]+)\)$/.exec(value);
        const file = path.replace(REPO + '/', '');
        if (varMatch) uses.push({ file, selector, token: varMatch[1]! });
        else opaque.push({ file, selector, value });
      }
    }
  }
  return { uses, opaque };
}

describe('ink audit — every token used as text', () => {
  const { uses, opaque } = inkUses();

  it('finds the `color:` declarations at all (guards against a dead scan)', () => {
    // A scanner that silently matches nothing passes forever. This is the
    // canary: the app demonstrably paints text with theme tokens.
    expect(
      uses.length,
      'no `color: var(--token)` declarations found — the scan is broken',
    ).toBeGreaterThan(10);
  });

  it('every computed/literal ink is explicitly allowlisted', () => {
    const unlisted = opaque.filter((o) => !(o.selector in COMPUTED_ALLOWED));
    expect(
      unlisted.map((o) => `${o.file} → ${o.selector}: color: ${o.value}`),
      `these \`color:\` declarations use values the audit cannot measure. Either paint with a ` +
        `bare var(--token) (deriving a new token in themes/ if needed), or add the selector to ` +
        `COMPUTED_ALLOWED with a reason — silence is how .prose-accent h3 shipped below AA.`,
    ).toEqual([]);
  });

  it('the computed allowlist names only selectors that still exist', () => {
    const live = new Set(opaque.map((o) => o.selector));
    const stale = Object.keys(COMPUTED_ALLOWED).filter((sel) => !live.has(sel));
    expect(
      stale,
      `COMPUTED_ALLOWED lists ${stale.join(', ')}, which no stylesheet declares any more — ` +
        `delete the entr${stale.length === 1 ? 'y' : 'ies'}.`,
    ).toEqual([]);
  });

  const byToken = [...new Set(uses.map((u) => u.token))].sort();

  it.each(byToken)('--%s is legible everywhere it can land', (token) => {
    const surfaces = SCOPED[token] ?? NEUTRAL_SURFACES;
    const where = uses
      .filter((u) => u.token === token)
      .map((u) => `${u.file} → ${u.selector}`)
      .slice(0, 3);

    const failures: string[] = [];
    for (const theme of COLOR_THEMES) {
      for (const [mode, selector] of [
        ['light', theme.id === 'clean-slate' ? ':root' : `[data-color-theme="${theme.id}"]`],
        ['dark', theme.id === 'clean-slate' ? '.dark' : `.dark[data-color-theme="${theme.id}"]`],
      ] as const) {
        const t = resolved(selector);
        if (!t[token]) continue;
        for (const surface of surfaces) {
          if (!t[surface]) continue;
          const ratio = contrast(t[token]!, t[surface]!);
          if (ratio < 4.5) {
            failures.push(`${theme.id} ${mode}: on ${surface} = ${ratio.toFixed(2)}:1`);
          }
        }
      }
    }

    if (token in KNOWN_UNSAFE) {
      // Rule 2: the baseline may only shrink. If this token now passes, the
      // entry is stale and must go, or the list slowly becomes a mute button.
      expect(
        failures.length,
        `--${token} is in KNOWN_UNSAFE but now passes everywhere. Delete its entry from ` +
          `KNOWN_UNSAFE — the baseline is shrink-only.`,
      ).toBeGreaterThan(0);
      return;
    }

    expect(
      failures,
      `--${token} is used as TEXT here:\n    ${where.join('\n    ')}\n` +
        `  …but it is illegible in ${failures.length} theme/surface combinations, worst first:\n    ` +
        failures
          .sort((a, b) => parseFloat(a.split('= ')[1]!) - parseFloat(b.split('= ')[1]!))
          .slice(0, 5)
          .join('\n    ') +
        `\n  Either give it a contrast-corrected \`-ink\` token (see --primary-ink), or if it ` +
        `truly only ever lands on specific surfaces, declare that in SCOPED with a reason.`,
    ).toEqual([]);
  });

  it('the known-unsafe baseline names only tokens that are actually used', () => {
    // A baseline entry for a token nobody paints with any more is dead weight
    // that makes the debt look bigger than it is.
    const used = new Set(uses.map((u) => u.token));
    const orphaned = Object.keys(KNOWN_UNSAFE).filter((t) => !used.has(t));
    expect(
      orphaned,
      `KNOWN_UNSAFE lists ${orphaned.join(', ')}, which no \`color:\` declaration uses any more — ` +
        `delete the entr${orphaned.length === 1 ? 'y' : 'ies'}.`,
    ).toEqual([]);
  });
});
