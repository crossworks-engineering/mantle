# Task: a Present deck

Adapted for Mantle from Impeccable v4.9.1 `reference/mode-persuade.md`, `reference/mode-read.md` and `reference/new-work.md` (Apache 2.0). Changed: condensed for a reveal.js deck on a Present canvas.

## Pick the mode first

- A **pitch, launch or proposal** deck is **Persuade**: the audience decides and acts. Bold, one world carried through every slide, one clear ask at the end.
- A **report, briefing or training** deck is **Read**: the audience understands something. A calm, clear frame with real structure.
- A **showcase** deck is **Experience**: the work fills the slide; the chrome recedes.

Read that mode's topic if you need more depth.

## The story

- Write the deck as a list of slide titles first. Each title is a full claim ("Downtime fell 40 percent after the valve swap"), not a label ("Results"). Read the titles alone: they must tell the story.
- One idea per slide. At most six lines. No text under 24px on the 1920x1080 stage.
- Open with the thesis, not an agenda. Close on the ask or the one thing to remember, not "Thank you" or "Questions?".
- Prove, don't claim: a real number, a real picture, a real example. Sample data is labelled sample.

## The world

- Find the world as `new-work` says, and commit it at slide scale: the ground, the title type and one signature move (a rule system, a way of setting numbers, a recurring shape) on every slide.
- One grammar, varied pace: a dense slide earns a quiet one. Big type for the claims, small for sources.
- Persuade decks may set their own palette (CSS variables, with `canvas:theme` `fixed`). Read decks stay on the theme tokens.
- Charts follow the dashboard rules: one question each, sorted, labelled directly, the chart tokens as series colours.

## Never

- A kicker or eyebrow label above a slide title. Section numbers (01, 02, 03) unless the order carries meaning.
- Bullet walls, stock icon rows, three equal cards on every slide.
- Gradient text, glass panels, a centred title over a gradient as the whole design.
- Animated entrances on every element. Use the deck's own transitions once, and honour reduced motion.

## Check

`present_render` with `slide: n` for every slide, and once with `theme: 'dark'` unless the deck is `fixed`. Look for overflow, cut text, overlap and empty charts. Fix all of it in one `present_update`, look again, stop.
