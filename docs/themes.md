# Themes: seeds, the generator, and the contrast contract

Mantle ships ~40 colour themes × light/dark. Since v0.207 the theme CSS is a
**build artifact**: nobody hand-maintains token values, and every text token is
**correct by construction**: solved at build time against the surfaces it must
be legible on.

## The one rule

**A theme's identity is its surfaces and fills. Text colour is a pure function
of (hue, surface, target ratio).** Surfaces and fills are authored; every text
role is derived. That is the whole design; everything below is mechanism.

## Files

| file | role |
|---|---|
| `packages/share-ui/themes/seeds.mjs` | **The authored source.** One record per theme: surfaces, fills, decor, text *anchors*, non-colour `extras`, optional `charts` brand override. Edit this. |
| `packages/share-ui/themes/model.mjs` | Colour maths: OKLab/OKLCH, WCAG contrast measured on the emitted 8-bit hex, the anchored solver (`solveText`), the fill+foreground joint solver (`solvePair`). |
| `packages/share-ui/themes/generate.mjs` | Seeds → full token scale → emits `styles/themes.css` + `src/lib/theme-registry.gen.ts`. Also `--check` (drift) and `--report` (ΔE vs a baseline css). |
| `packages/share-ui/styles/themes.css` | **Generated. Never edit.** The drift test fails CI if it disagrees with the seeds. |
| `packages/share-ui/src/lib/theme-registry.gen.ts` | Generated picker registry, `[primary, accent, background]` for **both** modes, so swatches can't desync from the CSS and the picker never advertises light-mode dots to someone browsing in the dark. |
| `packages/share-ui/themes/preview.html` | Zero-build visual harness: `python3 -m http.server -d packages/share-ui 4173` → `/themes/preview.html`. (`.claude/launch.json` is gitignored, so a `theme-preview` entry there is yours to add locally, not something the clone ships.) |

## Workflow

```sh
# edit packages/share-ui/themes/seeds.mjs, then:
pnpm themes:build     # regenerates themes.css + the registry
pnpm test             # contract + drift + generator suites
```

Adding a **theme** is a seed record (~10 lines, unlisted tokens fall down the
default chain: `popover=card`, `ring=primary`, `sidebar=muted`, `input=border`,
`sidebar-*=*`, foreground anchors default sensibly). Adding a **semantic role**
is one line in `ROLE_HUES` in `generate.mjs` plus a `@theme inline` mapping,
never another 168 hand-picked hex values.

## How derivation works (the anchored solver)

For each text token: keep the anchor's **hue and chroma** (the theme's
identity), scan **lightness** outward from the anchor in 0.0025 steps, emit the
first value whose **rounded 8-bit hex** clears the required ratio against every
surface in its contract; only reduce chroma if no lightness works. An authored
value that already passes ships **byte-for-byte unchanged**.

For a fill + its own `-foreground`, the two are solved **as a pair**: a broken
pair moves whichever side shifts least (fill weighted heavier). This is the
v0.206.7 accent repair, "move the lightness of whichever of the two shifts
least", done mechanically. It is what keeps white text white on a
slightly-deepened brand pink instead of flipping it to black.

## The contracts (asserted per theme × mode in CI)

- **4.5:1 (AA text)**: every `-foreground` on its own fill; `foreground` and
  `muted-foreground` on every neutral surface (`background`, `card`,
  `popover`, `muted`, `sidebar`); every **ink** on every neutral surface:
  `primary-ink`, `destructive-ink`, `success-ink`, `warning-ink`, `info-ink`,
  and the code palette `code-keyword/string/number/title/variable`.
- **3:1 (non-text)**: `ring` vs `background`+`card`, `sidebar-ring` vs
  `sidebar`, generated `chart-1..5` vs `background`+`card`.
- **Distinguishability**: the roles stay tellable-apart from `destructive`
  and each other; generated chart ramps never collapse two steps.

Three test layers, deliberately redundant:

1. `src/lib/themes.test.ts`, independent re-measure of the shipped CSS bytes
   (own parser, own colour maths; a generator bug can't vouch for itself).
2. `src/lib/theme-generator.test.ts`, drift (generated files match seeds),
   solver behaviour, distinguishability, seeds hygiene.
3. `src/lib/ink-audit.test.ts`, *discovers* what is used as text by scanning
   every shipped stylesheet, so a new `color: var(--x)` is audited by nobody's
   decision. Computed values (`color-mix()`, literal hex) **fail loudly**
   unless allowlisted with a reason; the `KNOWN_UNSAFE` baseline is empty and
   shrink-only.
4. `jackdaw/components/theme-preview/color-palette.test.ts`, same
   discover-don't-declare trick pointed at the **Color Palette tab**: every
   colour token `:root` ships must be visible there. Adding a role is one line
   in `ROLE_HUES` and one `@theme inline` mapping, neither of which passes
   near that component, so without this a new role would just be invisible.

Plus the ESLint pair (`mantle/pair-fill-foreground`,
`mantle/use-ink-for-text`): a fill wearing a foreign foreground, or a bare
`text-primary`/`text-destructive`/`text-success`/`text-warning`/`text-info`,
is a build error.

## Semantic roles

`success`, `warning`, `info` are first-class beside `destructive`: global hue
constants (`ROLE_HUES`), chroma borrowed from the theme (max of
primary/destructive chroma, clamped, `mono` gets them quiet, `cyberpunk`
loud), lightness solved per theme, on-fill text following the theme's own
`destructive-foreground` convention. Hue de-confliction keeps `warning`
distinct when a theme's destructive drifts orange (doom-64).

The code palette: `code-keyword` anchors on `primary-ink` (the brand hue
survives into code blocks); string/number/title/variable are fixed semantic
hues (strings read green everywhere), nudged away from the keyword hue on
collision.

`chart-1..5` are **categorical data ink only** (3:1): generated as five
distinguishable hues anchored on the brand (achromatic themes get a lightness
ramp). A seed may pin an authored brand ramp (`charts:`, pinnacle), which is
identity, not data ink, and exempt from the 3:1 bar.

## Deliberate limits (audited 2026-07-28: measured, accepted, documented)

- **`secondary` demands its own foreground.** `foreground` on `secondary` is
  NOT in the contract (15 of 82 blocks measure below AA, worst 1.68:1),
  including it would wreck body text in themes with strong secondaries. Text
  on `bg-secondary` must be `text-secondary-foreground`; the pairing lint
  catches every provable case, and today zero call sites put plain text on it
  (slider track + icon button only).
- **Pinnacle's light-mode brand ramp genuinely fails 3:1** (worst 1.64),
  that's what the seed `charts:` override exempts, deliberately: authored
  brand identity over data-ink contrast, the client's call.
- **Roles may coincide with the brand**: on a blue-primary theme `info` ≈
  `primary` (twitter: ΔE 0.002); on a green theme `success` ≈ `primary`.
  Intrinsic to "info is blue everywhere" and accepted: the safety-critical
  distinctions (each role vs `destructive` and vs its siblings) are the ones
  the generator enforces.
- **User colour marks (`{color=chart-N}`, highlights, asides) stay on chart
  tokens**, user-chosen decoration at the 3:1 data-ink bar, not AA text. The
  generated ramps actually improved them: the old mono-ramps could sit at
  ~1:1 on some themes.
- **An unmeetable contract aborts generation** (`mustSolve`): if a seed's
  neutral surfaces span mid-luminance such that no single ink clears them
  all, `themes:build` fails naming the anchor and surfaces instead of
  emitting a value for CI to trip over downstream.
- **Cross-platform determinism is empirical, not guaranteed**: the drift
  test passes byte-identically on macOS/arm64 and Linux/x64 today; a
  last-ulp `Math.cbrt`/`**` divergence could in principle flip one 8-bit
  rounding. If that ever fires, the fix is to quantise solver candidates in
  the generator, not to loosen the drift test.

## History

Decided 2026-07-27 (dev brain: "Handover, colour roles, derived inks, and the
theme system", node `cfe83c70`). The imported tweakcn presets were artwork with
no contrast contract; only 4 of 42 were self-consistent, and four separate
bugs in one session were all "a token used for a job it was never derived
for". `retro-arcade` and `northern-lights` were dropped as structurally
self-contradicting (retro-arcade dark declared its own body text on its own
muted fill at 2.01:1). The ΔE report at the switchover: 647 of 2,788
pre-existing values moved, ~400 of them the chart ramps; on-fill foregrounds
moved in only ~8 blocks at ΔE ≤ 0.05.
