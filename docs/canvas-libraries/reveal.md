# reveal.js in a canvas

Version: reveal.js 6.0.2, as this brain's canvas runtime pins it.
Source: the reveal.js docs (revealjs.com: installation, initialization,
config, API and the upgrading notes). Written for Mantle, not copied.

## Import

```html
<link rel="stylesheet" href="/canvas-runtime/reveal/reveal.css" />
<link rel="stylesheet" href="/canvas-runtime/reveal/theme/white.css" />
<script type="module">
  import Reveal from 'reveal.js';
</script>
```

The two stylesheets are served from the brain at those exact paths (themes:
`white`, `black`, `simple`, `serif`, `league`, `beige`, `sky`, `night`,
`moon`, `solarized`, `blood`, `dracula`, and the `-contrast` pair). No
plugin is in the canvas runtime: no Markdown, highlight, notes or math
plugin. Write slides as HTML; use KaTeX for formulas.

## Core API

- Markup: `<div class="reveal"><div class="slides"><section>...</section></div></div>`,
  one `<section>` per slide; a `<section>` inside a `<section>` is a
  vertical slide. `data-auto-animate` on two neighbouring slides moves
  matching elements between them.
- Fragments: `class="fragment"` reveals a step at a time.
- Start it: `const deck = new Reveal({ width: 1920, height: 1080, hash: false }); await deck.initialize();`
- Useful config: `controls`, `progress`, `center`, `transition`
  (`'slide'`, `'fade'`, `'none'`), `margin`, `slideNumber`.
- API: `deck.slide(h, v)`, `deck.next()`, `deck.prev()`,
  `deck.on('slidechanged', (e) => ...)`.

## What changed (if you know reveal.js 4 or 5)

- 6.0 builds with Vite; the module entry is the package's bare name
  (`import Reveal from 'reveal.js'`), the old `dist/reveal.esm.js` is gone.
- npm paths dropped `dist/` (`reveal.js/reveal.css`); in a canvas use the
  `/canvas-runtime/reveal/...` paths above, never a CDN.
- Plugins moved and are imported by name in 6; none ships in the canvas
  runtime.

## In a canvas

- A deck is a `fill` canvas: reveal scales its own 1920x1080 stage, so set
  `canvas:size` to `fill` and `width`/`height` in the config.
- `hash: false`: the frame has no address of its own to write.
- Text no smaller than 24px on the stage, at most six lines a slide.
- Colours: the theme file sets the slide look; for your own elements use
  `var(--chart-1)` and the other tokens.
- Check every slide with `present_render` `slide: n`; the arrow keys and
  Full screen work in Present. `slide` counts arrow presses from the
  start, and each fragment takes a press: on a slide with fragments, ask for
  a higher number to see them shown.

## Example

```html
<!doctype html>
<html>
  <head>
    <title>Shutdown plan</title>
    <meta name="description" content="A three-slide deck: the scope, the dates and the one risk." />
    <meta name="canvas:size" content="fill" />
    <link rel="stylesheet" href="/canvas-runtime/reveal/reveal.css" />
    <link rel="stylesheet" href="/canvas-runtime/reveal/theme/white.css" />
  </head>
  <body>
    <div class="reveal">
      <div class="slides">
        <section><h2>Shutdown plan</h2><p>Unit 3, two weeks</p></section>
        <section>
          <h3>Dates</h3>
          <ul>
            <li class="fragment">Isolation: day 1</li>
            <li class="fragment">Inspection: days 2 to 9</li>
            <li class="fragment">Restart: day 14</li>
          </ul>
        </section>
        <section><h3>The one risk</h3><p style="color: var(--chart-1)">The exchanger bundle may need a spare.</p></section>
      </div>
    </div>
    <script type="module">
      import Reveal from 'reveal.js';
      const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const deck = new Reveal({ width: 1920, height: 1080, hash: false, transition: still ? 'none' : 'slide' });
      await deck.initialize();
    </script>
  </body>
</html>
```
