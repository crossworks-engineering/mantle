# KaTeX in a mini app

Version: katex 0.19.1, as this brain's app runtime serves it.
Source: the KaTeX docs (katex.org: API, options, supported functions) and
its changelog. Written for Mantle, not copied.

## Import

```tsx
import katex from 'katex';
```

A default import. The app frame already links KaTeX's stylesheet and fonts
(`/share-runtime/katex/`): do not add your own. The frame's import map
serves the library; it is not bundled into the app.

## In a React component

- `katex.renderToString(tex, { displayMode, throwOnError: false })` returns
  HTML. Put it in an element with `dangerouslySetInnerHTML`, and compute it
  in `useMemo` keyed on the TeX, so a re-render does not typeset again.
- `throwOnError: false` shows a bad formula in red instead of throwing, so
  one typo does not take the app down. Show the error text near an input
  when people type formulas.
- Keep `trust` off (the default). KaTeX then refuses `\href`, `\url` and
  `\htmlData`, and escapes the TeX, so a formula from a user or from
  `host.db` cannot add markup.
- `displayMode: true` for a block formula, `false` inline in a sentence.
- Colour follows `currentColor`: a `text-foreground` or `text-primary`
  parent sets it, and the host's theme switch restyles it with no code.
- `katex.render(tex, el, options)` into a ref works too; then call it in an
  effect when the TeX changes.

## App example

```tsx
import { useMemo, useState } from 'react';
import katex from 'katex';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

function TeX({ tex, display = false }: { tex: string; display?: boolean }) {
  const html = useMemo(
    () => katex.renderToString(tex, { displayMode: display, throwOnError: false }),
    [tex, display],
  );
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

export default function App() {
  const [tex, setTex] = useState('\\frac{\\pi D^2}{4} \\, v = Q');
  return (
    <div className="mx-auto max-w-xl space-y-4 p-6 text-foreground">
      <p className="text-sm text-muted-foreground">
        Flow through a pipe of diameter <TeX tex="D" /> at velocity <TeX tex="v" />:
      </p>
      <div className="rounded-lg border bg-card p-4 text-xl">
        <TeX tex={tex} display />
      </div>
      <div className="space-y-1">
        <Label htmlFor="tex">Formula</Label>
        <Input id="tex" value={tex} onChange={(e) => setTex(e.target.value)} />
      </div>
      <div className="rounded-lg border bg-card p-4 text-lg">
        <TeX tex="\Delta p = f \frac{L}{D} \frac{\rho v^2}{2}" display />
      </div>
    </div>
  );
}
```
