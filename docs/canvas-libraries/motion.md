# Motion in a canvas

Version: motion 14.6.0, as this brain's canvas runtime pins it.
Source: the Motion docs for JavaScript (motion.dev, its llms.txt index and
the `animate` page) and its changelog. Written for Mantle, not copied.

## Import

```js
import { animate, stagger, inView, scroll, spring } from 'motion';
```

The vanilla JavaScript API of the `motion` package: no React here
(`motion/react` is not in the canvas runtime). Motion is the only animation
library a canvas has; never GSAP.

## Core API

- `animate(target, keyframes, options)`: `target` is an element, a CSS
  selector (`'.bar'`), or several elements. `keyframes` is an object of end
  values (`{ opacity: 1, x: 0 }`) or arrays of keyframes
  (`{ x: [-40, 0] }`). Transforms are their own keys: `x`, `y`, `scale`,
  `rotate`.
- Options, times in SECONDS: `duration` (0.3 default), `delay`, `ease`
  (`'easeOut'`, `'easeInOut'`, a cubic bezier array), `repeat` (`Infinity`
  for a loop), `repeatType` (`'loop'`, `'reverse'`, `'mirror'`), and
  `type: 'spring'` with `bounce` (0 to 1) or `stiffness` and `damping`.
- `delay: stagger(0.08)` offsets each element of a list.
- Sequences: `animate([[a, kf, opts], [b, kf, { at: '<' }]])`; `at` takes
  seconds, `'<'` (with the previous), `'+0.3'` or a label.
- `animate` returns controls: `await` it (or `.then`), `pause()`, `play()`,
  `stop()`, `complete()`, `cancel()`, and `time` and `speed` to scrub.
- `inView(el, (el) => { animate(el, ...) })` runs when an element enters the
  view; `scroll(animation)` ties an animation to scroll progress.

## What changed (if you know Framer Motion or Motion One)

- Framer Motion became Motion: the React API is `motion/react`, the plain
  JavaScript API (what a canvas uses) is `motion`. Motion One's `animate`
  lives on here with the same shape.
- Times are seconds, not milliseconds.
- 14.0 removed internal APIs kept for old `framer-motion` 13 packages: use
  only the documented exports above. 14.x added grid staggers
  (`stagger(0.05, { grid: [cols, rows], from: 'center' })`) and hardware
  accelerated `x`, `y` and `scale`.

## In a canvas

- Reduced motion: when `matchMedia('(prefers-reduced-motion: reduce)')`
  matches, skip the animation and show the end state (the example does).
- The poster and `present_render` take the picture about 2 seconds after
  load: make sure the canvas reads right at its end state, and pass a
  later `at_seconds` to look at a longer intro.
- Animate `opacity` and transforms; colours come from theme tokens
  (`var(--chart-1)` in CSS), not from animated hex values.

## Example

```html
<!doctype html>
<html>
  <head>
    <title>Three steps to commissioning</title>
    <meta name="description" content="Three steps appear one after another, then the last one is marked." />
    <meta name="canvas:size" content="1280x720" />
  </head>
  <body class="flex flex-col justify-center gap-6 bg-background p-16 text-foreground">
    <h1 class="text-5xl font-semibold">Three steps to commissioning</h1>
    <div class="step rounded-lg border border-border bg-card p-6 text-3xl">1. Flush the lines</div>
    <div class="step rounded-lg border border-border bg-card p-6 text-3xl">2. Pressure test</div>
    <div class="step rounded-lg border border-border bg-card p-6 text-3xl" id="last">3. Hand over</div>
    <script type="module">
      import { animate, stagger } from 'motion';
      const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!still) {
        await animate('.step', { opacity: [0, 1], x: [-40, 0] }, { duration: 0.5, delay: stagger(0.2) });
        animate('#last', { scale: [1, 1.04, 1] }, { duration: 0.6, ease: 'easeInOut' });
      }
      document.getElementById('last').style.borderColor = 'var(--chart-1)';
    </script>
  </body>
</html>
```
