# Audit: the after-build check

Adapted for Mantle from Impeccable v4.9.1 `reference/craft-floor.md`, `reference/audit.md` and `reference/new-work.md` (Inspect and finish) (Apache 2.0). Changed: one short checklist for a builder to run once after a build, with Mantle's picture tools. For the full scored audit (accessibility, performance, responsive, theming) read `technical-audit`.

Run this once, after the build works. Not after every tweak.

## 1. Take the pictures, all in one round

- **Present canvas:** the save already returned one. Add `present_render` with `theme: 'dark'` (unless `canvas:theme` is `fixed`), `slide: n` for every slide of a deck, and `width`/`height` at a phone width for a `fill` canvas. For an animation, `at_seconds` at the end state too.
- **A mini app:** there is no picture tool for an app yet. Read the source against the list below, and `app_errors` after the person has opened it.

A picture counts only when it is valid: no blank or black regions, no half-loaded state, entrance motion settled.

## 2. Check each picture against this list

- **Contrast:** body text at least 4.5:1, large text 3:1, in both themes. Secondary text on colour is tinted from that colour, never plain grey.
- **Text:** nothing cut off, nothing overlapping, nothing overflowing its box, at every size checked. Body lines about 65 to 75 characters.
- **Hierarchy:** the most important thing is the most obvious. More space above a heading than below it.
- **States:** empty, loading, error and a long-content case exist and look designed, not default.
- **Controls:** each one names its action; focus is visible; nothing is a div pretending to be a button.
- **Data:** every chart has data and labels; numbers line up (`tabular-nums`); units are shown.
- **Browser surfaces:** selection colour, focus rings, scrollbars and link underlines are themed, not browser defaults.
- **Bans:** no kicker above a heading, no gradient text, no coloured side stripe on cards, no nested cards, no hero-metric template, no emoji as icons, no hex colours in a mini app.
- **Coverage:** everything the request asked for is there and findable in a few seconds.
- **Specificity:** with the name covered, it still reads as this product.

## 3. Fix once, look once, stop

Fix everything the list found in one batch (`present_update` `edits`, or the code tools and `app_build`). Take the same pictures again. If they pass, stop. Two rounds is the ceiling: report what is left rather than polishing on.

## 4. Report

Say what you checked, what you fixed, and anything still open. Never claim a check you did not run.
