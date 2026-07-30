---
title: Appearance
---

## Appearance

Light, dark or follow-the-system, plus a colour theme — and a live preview so
you can see what a theme does to a real screen before committing to it.

The themes are complete palettes, not accent colours. Each one redefines
backgrounds, surfaces, borders, text and the status colours together, which is
why switching feels like a different application rather than a tinted version of
the same one.

Brand identity — the logo and the wordmark font — is set on the logo screen
rather than here.

## When to use this

Pick by contrast, not by favourite colour. The status roles carry meaning —
success, warning, info, destructive — and a theme where those read as similar
shades makes a failed job harder to spot in a list. The preview shows them
together for exactly this reason.

If a screen ever looks unstyled after an update, that's a stale stylesheet
rather than a theme problem, and reloading fixes it.

## Technical

Colours are theme tokens, never fixed values: every surface in the app refers to
a role — background, card, border, primary, muted — and the theme supplies what
each role means. That indirection is what lets roughly forty themes work without
per-theme code, and it's why nothing in the interface hardcodes a colour.

The theme stylesheet is **generated** from a set of seed definitions rather than
hand-written. Colours are expressed in a perceptual colour space, so a theme's
light and dark variants are derived from the same seed and stay related instead
of being two independent guesses.

Every fill is paired with its own foreground role. That pairing is a contrast
guarantee, and it's the reason a light-accent theme stays readable where a
mix-and-match approach would produce invisible text on one theme out of forty.

Your choice is stored per browser, so it follows the device rather than the
brain — the same account can be dark on a laptop and light on a phone.
