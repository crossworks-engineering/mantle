# Alpine.js in a canvas

Version: alpinejs 3.17.5, as this brain's canvas runtime pins it.
Source: the Alpine.js docs (alpinejs.dev: start here, directives, magics,
globals) and its release notes. Written for Mantle, not copied.

## Import

```js
import Alpine from 'alpinejs';
Alpine.start();
```

Call `Alpine.start()` once, after the markup it drives (a module script runs
after the page is parsed, so anywhere in the page is fine). Use Alpine for
small interactive state written as HTML attributes: tabs, toggles, a step
through, a slider that filters a chart.

## Core API

- `x-data="{ tab: 'flow', n: 3 }"`: a component and its state.
- `x-text="n"`, `x-html` (avoid), `x-show="tab === 'flow'"`, `x-if` (on a
  `<template>`), `x-for="item in items"` (on a `<template>`, with `:key`).
- `x-on:click="n++"` or `@click`, with modifiers (`@keydown.enter`).
- `x-bind:class="{ 'bg-primary': tab === 'flow' }"` or `:class`; any
  attribute binds the same way.
- `x-model="value"` two-way binds an input.
- `x-init="..."` runs when the component starts; `x-effect` reruns when its
  state changes; magics `$refs`, `$el`, `$watch`, `$nextTick`.
- `Alpine.data('name', () => ({ ... }))` before `start()` for a reusable
  component, used as `x-data="name"`.

## What changed (if you know Alpine 2)

- Alpine 3 must be started: importing it does nothing until
  `Alpine.start()`.
- `x-spread` became `x-bind="object"`; `$el` is the element itself; `x-init`
  no longer needs to return a callback; `Alpine.data` and `Alpine.store`
  replace the old global helpers.
- 3.17 is a fix and small-feature line on 3; nothing to change from 3.13
  and on.

## In a canvas

- The frame allows Alpine's expression evaluation (its CSP permits it), so
  the standard build works. Expressions are plain JavaScript; keep them
  short.
- Style with Tailwind classes and theme tokens (`bg-card`,
  `text-muted-foreground`, `border-border`); they follow the theme.
- Start state is what the poster and `present_render` show: make the first
  tab the one that reads best on its own.
- Reduced motion: skip `x-transition` when the viewer asks (bind it on a
  flag from `matchMedia`).

## Example

```html
<!doctype html>
<html>
  <head>
    <title>Feed section at a glance</title>
    <meta name="description" content="Two tabs: what the feed section does, and its three main numbers." />
    <meta name="canvas:size" content="1280x720" />
  </head>
  <body class="bg-background p-16 text-foreground">
    <div x-data="{ tab: 'what' }" class="flex flex-col gap-6">
      <h1 class="text-5xl font-semibold">Feed section at a glance</h1>
      <div class="flex gap-3">
        <button class="rounded-md border border-border px-5 py-2 text-2xl" :class="tab === 'what' && 'bg-primary text-primary-foreground'" @click="tab = 'what'">What it does</button>
        <button class="rounded-md border border-border px-5 py-2 text-2xl" :class="tab === 'numbers' && 'bg-primary text-primary-foreground'" @click="tab = 'numbers'">Numbers</button>
      </div>
      <p x-show="tab === 'what'" class="max-w-4xl text-3xl text-muted-foreground">Feed enters the surge drum, and two pumps send it on at a steady level.</p>
      <ul x-show="tab === 'numbers'" class="space-y-2 text-3xl">
        <template x-for="row in [['Flow', '120 m³/h'], ['Level set point', '50 %'], ['Pumps', '1 duty, 1 standby']]">
          <li><span class="font-semibold" x-text="row[0]"></span>: <span x-text="row[1]"></span></li>
        </template>
      </ul>
    </div>
    <script type="module">
      import Alpine from 'alpinejs';
      Alpine.start();
    </script>
  </body>
</html>
```
