/**
 * The single map from Mantle theme tokens → Mermaid `themeVariables`.
 *
 * Two surfaces render Mermaid and both come through here, so a palette change
 * lands in one place: the Pages/chat NodeView (client/web page-editor
 * diagram-view) and the /print surface's PDF sidecar, which loads this as an
 * IIFE from share-runtime (server/web build-share-runtime step 5).
 *
 * The house rule for colour: **filled shapes that carry text sit on neutral
 * surfaces** (`background`/`card`/`muted`/`secondary`) with `foreground` text.
 * The `chart-1..5` tokens are 3:1 data ink — fine as fills where nothing has
 * to be read on top of them (pie slices, journey task chips, gitgraph
 * branches), never as text and never behind a label. Where a diagram type
 * needs more series than the palette has, the palette CYCLES: the theme
 * generator owns every colour in the product (`pnpm themes:build`), so
 * inventing an off-palette sixth hue here is not an option.
 *
 * Values must be concrete — mermaid's `base` theme runs khroma colour maths on
 * them, which parses hex/rgb/hsl but not `color-mix()`. The generated
 * themes.css emits plain hex, so reading the token straight out of
 * `getComputedStyle` is safe.
 */

/** Resolve a CSS custom property to a concrete value; the fallback keeps a
 *  missing token from yielding an empty colour string. */
export type ThemeToken = (name: string, fallback: string) => string;

/** GitHub-ish light defaults — only reached if a token is missing entirely. */
const FALLBACK_CHARTS = ['#666ed1', '#ae467f', '#ad5700', '#4b830f', '#00889b'];

/**
 * @param token   resolves `--foo` against whatever element owns the theme
 * @param darkMode mermaid's `base` theme branches on this for every value NOT
 *   set below — gantt/journey section tints (a `-1` vs `-4` lighten
 *   multiplier), `edgeLabelBackground`, gitgraph `branchLabelColor`, quadrant
 *   `scaleLabelColor`. Unset it defaults to false, i.e. light-mode maths on a
 *   dark brain.
 */
export function mermaidThemeVariables(
  token: ThemeToken,
  darkMode: boolean,
): Record<string, string | boolean> {
  const charts = [1, 2, 3, 4, 5].map((i) => token(`--chart-${i}`, FALLBACK_CHARTS[i - 1]!));
  /** Categorical fill by index, cycling once the 5 chart tokens run out. */
  const series = (i: number) => charts[i % charts.length]!;

  const foreground = token('--foreground', '#1f2328');
  const mutedForeground = token('--muted-foreground', '#59636e');
  const background = token('--background', '#ffffff');
  const card = token('--card', '#ffffff');
  const muted = token('--muted', '#f6f8fa');
  const secondary = token('--secondary', '#eff2f5');
  const accent = token('--accent', '#eaeef2');
  const border = token('--border', '#d1d9e0');
  const primary = token('--primary', '#0969da');
  const destructive = token('--destructive', '#d1242f');

  const vars: Record<string, string | boolean> = {
    darkMode,
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',

    // ── Core surfaces. Most diagram types derive from these three "primary/
    // secondary/tertiary" slots rather than naming their own variable, which
    // is why sequence, class, state and ER already track the theme without
    // per-type entries below.
    background,
    mainBkg: muted,
    primaryColor: muted,
    primaryTextColor: foreground,
    primaryBorderColor: border,
    secondaryColor: card,
    secondaryTextColor: foreground,
    secondaryBorderColor: border,
    tertiaryColor: background,
    tertiaryTextColor: foreground,
    tertiaryBorderColor: border,
    lineColor: mutedForeground,
    textColor: foreground,
    noteBkgColor: muted,
    noteTextColor: foreground,
    noteBorderColor: border,

    // ── Gantt. Section bands alternate three neutral surfaces; task bars stay
    // neutral too because mermaid paints the task label INSIDE the bar, so a
    // chart fill would put 3:1 data ink behind text. `crit` is the one solid
    // fill, hence `background` as its ink (light text on the light-mode
    // destructive, dark text on the dark-mode one — the token flips with the
    // mode, so one value is correct in both).
    sectionBkgColor: muted,
    altSectionBkgColor: background,
    sectionBkgColor2: card,
    excludeBkgColor: secondary,
    taskBkgColor: accent,
    taskBorderColor: border,
    activeTaskBkgColor: secondary,
    activeTaskBorderColor: primary,
    doneTaskBkgColor: muted,
    doneTaskBorderColor: border,
    critBkgColor: destructive,
    critBorderColor: destructive,
    todayLineColor: primary,
    gridColor: border,
    vertLineColor: border,
    taskTextColor: foreground,
    taskTextOutsideColor: foreground,
    taskTextClickableColor: primary,

    // ── Quadrant chart. Four subtle neutral surfaces make the quadrants read
    // as a checkerboard without competing with the plotted points, which are
    // the only thing here that should carry chart ink.
    quadrant1Fill: background,
    quadrant2Fill: muted,
    quadrant3Fill: card,
    quadrant4Fill: secondary,
    quadrant1TextFill: foreground,
    quadrant2TextFill: foreground,
    quadrant3TextFill: foreground,
    quadrant4TextFill: foreground,
    quadrantPointFill: series(0),
    quadrantPointTextFill: foreground,
    quadrantXAxisTextFill: mutedForeground,
    quadrantYAxisTextFill: mutedForeground,
    quadrantTitleFill: foreground,
    quadrantInternalBorderStrokeFill: border,
    quadrantExternalBorderStrokeFill: border,

    // ── Pie text + strokes. Slice fills are chart ink (below); the label sits
    // ON the slice, so it takes `background` — which inverts with the mode and
    // therefore contrasts with a chart token in both.
    pieStrokeColor: background,
    pieOuterStrokeColor: border,
    pieTitleTextColor: foreground,
    pieSectionTextColor: background,
    pieLegendTextColor: foreground,

    // ── Error strip (mermaid's own, not the NodeView's).
    errorBkgColor: destructive,
    errorTextColor: background,
  };

  // ── Categorical series. Mermaid names these individually and falls back to
  // hardcoded pastels for any index left unset, so each family is filled to
  // its full count rather than the first five.
  for (let i = 0; i < 12; i++) {
    vars[`pie${i + 1}`] = series(i); // pie1..pie12 (1-based)
    vars[`cScale${i}`] = series(i); // mindmap / journey sections
  }
  for (let i = 0; i < 8; i++) {
    vars[`git${i}`] = series(i); // gitgraph branches
    vars[`fillType${i}`] = series(i); // user-journey task chips
  }
  return vars;
}

/**
 * The same map, read off `<html>` — what both live browsers want. Dark mode
 * comes from the `dark` class next-themes sets; the /print surface never sets
 * it, which is correct, since a PDF forces a light background regardless of
 * the brain's mode.
 */
export function mermaidThemeVariablesFromDocument(): Record<string, string | boolean> {
  const cs = getComputedStyle(document.documentElement);
  return mermaidThemeVariables(
    (name, fallback) => cs.getPropertyValue(name).trim() || fallback,
    document.documentElement.classList.contains('dark'),
  );
}
