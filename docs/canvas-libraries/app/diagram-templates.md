# Diagram templates in a mini app

Version: @mantle/diagram-templates 0.0.1, as this brain's app runtime
serves it (templates `flow` and `pid`).
Source: Mantle's own diagram templates (packages/diagram-templates).

## Import

```tsx
import { render, domMeasurer } from '@mantle/diagram-templates/browser';
```

The same runtime a Present template canvas uses. The frame's import map
serves it; it is not bundled into the app. `mount` is for a canvas page:
an app uses `render`.

## In a React component

- `render(template, data, measurer)` lays the data out and returns
  `{ ok: true, svg, warnings, stats }` or `{ ok: false, errors, warnings }`.
  It never throws on bad data: every problem comes back in `errors`, each
  naming the fix. Show them; do not draw a half diagram.
- `template` is `'flow'` (boxes and arrows: process flows, flowcharts,
  architecture) or `'pid'` (a P&ID first draft). The data contract and a
  complete example per template: `diagram_guide` with `type` `flow` or
  `pid`, and `diagram_render` draws data to look at it before you build.
- The measurer reads text widths in this document. Make it ONCE
  (`domMeasurer(document)` adds a hidden SVG to the body), at module level
  inside a function or in a ref, not on every render.
- Compute the SVG in `useMemo` keyed on the data, and insert it with
  `dangerouslySetInnerHTML`. The template escapes every label, so data from
  `host.db` or a user cannot add markup.
- The SVG is the house style on its own light ground, sized in pixels with a
  `viewBox`: scale it with `[&>svg]:h-auto [&>svg]:max-w-full` on the parent.
- Data from rows: build `nodes` and `edges` from `host.db` results, with
  stable `id`s (an edge names its ends by id).

## App example

```tsx
import { useMemo } from 'react';
import { render, domMeasurer } from '@mantle/diagram-templates/browser';

let measurer: ReturnType<typeof domMeasurer> | null = null;
const measure = () => (measurer ??= domMeasurer(document));

const FLOW = {
  template: 'flow',
  title: 'Work order flow',
  description: 'How a work order moves from a request to a closed job.',
  direction: 'right',
  nodes: [
    { id: 'request', label: 'Request', kind: 'input', shape: 'pill' },
    { id: 'triage', label: 'Triage', sublabel: 'planner' },
    { id: 'approved', label: 'Approved?', shape: 'diamond' },
    { id: 'schedule', label: 'Schedule', sublabel: 'next shutdown' },
    { id: 'done', label: 'Closed', kind: 'focal', shape: 'pill' },
  ],
  edges: [
    { from: 'request', to: 'triage' },
    { from: 'triage', to: 'approved' },
    { from: 'approved', to: 'schedule', label: 'yes' },
    { from: 'approved', to: 'done', label: 'no', style: 'dashed' },
    { from: 'schedule', to: 'done' },
  ],
};

export default function App() {
  const out = useMemo(() => render('flow', FLOW, measure()), []);
  if (!out.ok) {
    return (
      <pre className="whitespace-pre-wrap p-4 text-sm text-destructive">
        {out.errors.join('\n')}
      </pre>
    );
  }
  return (
    <div
      className="p-4 [&>svg]:h-auto [&>svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: out.svg }}
    />
  );
}
```
