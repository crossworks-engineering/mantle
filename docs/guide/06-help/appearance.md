---
title: Appearance
---

## Appearance

Light, dark or follow-the-system, plus a colour theme, and a live preview so
you can see what a theme does to a real screen before committing to it.

The themes are complete palettes, not accent colours. Each one redefines
backgrounds, surfaces, borders, text and the status colours together, which is
why switching feels like a different application rather than a tinted version of
the same one.

Brand identity (the logo and the wordmark font) is set on the logo screen
rather than here.

### Backgrounds

Four areas of the app can carry a generated backdrop: the menu, the header, the
chat, and the activity column. Each is set on its own, and each can be set to
**Off**.

The artwork is generated, not a stock image, and it takes its colours from
whichever colour theme is active. Change the theme and every backdrop repaints
with it, so a background can never end up clashing with the rest of the
interface.

Only the menu is decorated to begin with. The rest start Off.

## When to use this

Pick by contrast, not by favourite colour. The status roles carry meaning,
success, warning, info, destructive, and a theme where those read as similar
shades makes a failed job harder to spot in a list. The preview shows them
together for exactly this reason.

If a screen ever looks unstyled after an update, that's a stale stylesheet
rather than a theme problem, and reloading fixes it.

Backgrounds are decoration, and the settings are built so they stay that way:
the artwork is faint, and it fades out where the text is densest. If a panel
ever feels busy, turn that one area Off rather than living with it. The chat is
the surface you read most, so it is the one worth leaving plain unless a
particular style genuinely disappears behind the messages.

## Technical

Colours are theme tokens, never fixed values: every surface in the app refers to
a role (background, card, border, primary, muted) and the theme supplies what
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
brain; the same account can be dark on a laptop and light on a phone.

Backgrounds work the other way round. They are stored on the brain, so they are
part of how this Mantle looks to everyone who signs into it, in the same way the
logo and the wordmark are. Turning one off is itself a saved choice rather than
an absence, which is what keeps a later change to the defaults from switching it
back on behind your back.
