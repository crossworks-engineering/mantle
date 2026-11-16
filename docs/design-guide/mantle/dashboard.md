# Task: a dashboard

Adapted for Mantle from Impeccable v4.9.1 `reference/mode-operate.md`, `reference/operate.md` and `reference/craft-floor.md` (Apache 2.0). Changed: condensed for a dashboard built as a mini app or a `fill` canvas.

A dashboard is an **Operate** surface: the person reads the state of something and acts on it. Build it as a mini app when people change data, as a Present canvas (`canvas:size` `fill`) when they only look.

## Start from the questions

- Write down the three to five questions the dashboard answers ("Which units are late?", "Is spend over plan?"). Each region answers one. A region that answers nothing goes.
- The data the person reads first sits top left and largest. Order the rest by how often it is read.
- Real data from the brain or the request. If a number is not there, say what is missing; never draw a guess.

## Structure

- A shell first: title and scope (what period, which site), filters that sit above what they scope, then the work areas.
- Filters are standard controls (selects, date range, segmented tabs). Show the active filter state plainly.
- Tables have sortable headers, right-aligned numbers in `tabular-nums`, units in the header, not in every cell.
- One chart per question. The chart type follows the question: change over time is a line, parts of a whole is a bar (not a pie past four parts), comparison is a sorted bar.
- A headline number that moves over time shows its recent history beside it, with the moment something changed marked.

## Colour

- Restrained is the floor. One category colour may carry a whole report (Committed).
- Chart series use the chart tokens (`chart-1` to `chart-5`) as named roles, the same series in the same colour on every chart. A chart library needs the tokens as rgb: the `canvas_library` guide has the helper.
- State colours sit on top only where they carry meaning: critical, degraded, healthy. Never colour for decoration.

## States to show

Every region has its loading, empty ("No late units this week"), error and stale-data state. Show when the data was last updated. One state worth seeing in your test data: an alert, a degraded service, an empty filter result.

## Never

- The hero-metric template: a row of big numbers with small labels and coloured accents standing in for a design.
- Sparklines, progress rings and soft rounded tiles standing in for real content.
- Same-size cards in a grid as the whole structure. Nested cards.
- Gradient text, glass, glowing edges, neon on near-black by default.

## Self-check

With the name covered: does it read as a working product of its category, can the person answer each question in a few seconds, and is it at least as clean as the best tool they know? Then run the `audit` checklist once.
