# KaTeX in a canvas

Version: katex 0.19.1, as this brain's canvas runtime pins it.
Source: the KaTeX docs (katex.org: API, options, supported functions) and
its changelog. Written for Mantle, not copied.

## Import

```js
import katex from 'katex';
```

Its stylesheet and fonts are already in every canvas frame: do not link
them. Use KaTeX to typeset formulas (an equation on a slide, a derivation
beside a chart).

## Core API

- `katex.render(tex, element, options)`: typesets into the element.
- `katex.renderToString(tex, options)`: the HTML as a string, to place
  yourself.
- Options: `displayMode: true` for a centred block formula (inline
  otherwise), `throwOnError: false` to show a bad formula in red instead of
  throwing, `output: 'htmlAndMathml'` (default; keeps it readable to screen
  readers), `macros: { '\\RR': '\\mathbb{R}' }`, `trust: false` (keep it).
- TeX in a JavaScript string: double every backslash (`'\\frac{a}{b}'`), or
  use `String.raw` with a template literal.
- Supported: most of LaTeX math mode, `aligned`, `cases`, `matrix`,
  `\text{}`, `\color{}`; not full LaTeX documents or packages.

## What changed (if you know older KaTeX)

- 0.19.0: a character missing from KaTeX's font metrics is reported
  through the `strict` option (code `symbolNotInFont`); the default
  `strict: 'warn'` logs a console warning. A `strict` function that returns
  nothing now warns instead of being ignored.
- 0.19.1 is a fix release on 0.19.0.
- In a canvas the fonts are woff2 only (the brain serves them).

## In a canvas

- Set `throwOnError: false`: a typo shows in red rather than an error that
  stops the rest of the script, and `present_render` reports what KaTeX
  says.
- Colour: KaTeX takes the surrounding `color`; put formulas in elements
  with `text-foreground`, or use `\color{}` sparingly.
- Size: set `font-size` on the element (1.2em to 3em on a slide).
- Formulas are text: search reads them from the canvas's own text, so add a
  plain-words line beside an important one.

## Example

```html
<!doctype html>
<html>
  <head>
    <title>Pressure drop</title>
    <meta name="description" content="The Darcy-Weisbach equation for pressure drop in a pipe, with its terms." />
    <meta name="canvas:size" content="1280x720" />
  </head>
  <body class="flex flex-col justify-center gap-8 bg-background p-16 text-foreground">
    <h1 class="text-5xl font-semibold">Pressure drop in a straight pipe</h1>
    <div id="eq" style="font-size: 2.6em"></div>
    <ul class="space-y-2 text-2xl text-muted-foreground">
      <li><span class="tex">f_D</span>: the Darcy friction factor</li>
      <li><span class="tex">L / D</span>: pipe length over inside diameter</li>
      <li><span class="tex">\rho v^2 / 2</span>: the dynamic pressure</li>
    </ul>
    <script type="module">
      import katex from 'katex';
      katex.render(String.raw`\Delta p = f_D \, \frac{L}{D} \, \frac{\rho v^2}{2}`, document.getElementById('eq'), {
        displayMode: true,
        throwOnError: false,
      });
      for (const el of document.querySelectorAll('.tex')) {
        katex.render(el.textContent, el, { throwOnError: false });
      }
    </script>
  </body>
</html>
```
