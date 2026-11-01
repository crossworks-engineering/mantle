# math.js in a mini app

Version: mathjs 15.2.0, as this brain's app runtime serves it.
Source: the math.js docs (mathjs.org: units, expression parser, number
types, security) and its changelog. Written for Mantle, not copied.

## Import

```tsx
import { evaluate, unit, format, create, all } from 'mathjs';
```

Named imports only; there is no default export. The frame's import map
serves it (about 750 KB, fetched only by an app that imports it); it is not
bundled into the app.

## In a React component

- `evaluate('2.5 inch to mm')` parses and runs an expression and returns a
  number, a `Unit` or a matrix. `evaluate('rho * v^2 / 2', { rho: 1000, v: 2 })`
  takes a scope of names. It THROWS on a bad expression: wrap it in
  `try`/`catch` and show the message near the input.
- `unit(5, 'bar').toNumber('kPa')` converts to a plain number;
  `unit('3 m^3/h').to('L/min')` gives a `Unit`. Units multiply and divide
  (`area.multiply(speed).to('m^3/h')`); a mismatch throws.
- Offset units work: `unit(20, 'degC').toNumber('degF')`.
- `format(x, { precision: 4 })` prints a number, unit or matrix with
  significant digits. Do the maths in full precision and round only here.
- Your own unit or setting: make a private instance with `create(all)`
  (`const math = create(all); math.createUnit('ksi', '1000 psi')`), not
  changes to the shared one. `create(all, { number: 'BigNumber',
precision: 32 })` for decimal work.
- Also: matrices (`multiply`, `inv`, `lusolve`), statistics (`mean`, `std`).
- Compute in `useMemo` keyed on the inputs.
- A formula SAVED by one person and run in another person's app is
  untrusted. The parser cannot reach JavaScript, the page or `host`, but it
  can change math.js's own state in that tab. Run saved formulas through a
  limited instance (math.js's security notes), with a new scope each call
  and `typed` hidden, so nothing outlives the call:

```tsx
const safe = create(all); // set any config before the import below
const evaluate = safe.evaluate;
const off = () => {
  throw new Error('Not allowed in a saved formula');
};
safe.import(
  {
    import: off,
    createUnit: off,
    evaluate: off,
    parse: off,
    simplify: off,
    derivative: off,
    resolve: off,
    reviver: off,
    config: off,
  },
  { override: true },
);
const runSaved = (f: string, vars: Record<string, unknown> = {}) =>
  evaluate(f, { ...vars, typed: undefined });
```

## App example

```tsx
import { useMemo, useState } from 'react';
import { evaluate, format, unit } from 'mathjs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const CONVERSIONS = ['10 bar to psi', '20 degC to degF', '3 m^3/h to L/min', '6 inch to mm'];

function run(expr: string): string {
  try {
    return format(evaluate(expr), { precision: 5 });
  } catch (e) {
    return (e as Error).message;
  }
}

export default function App() {
  const [expr, setExpr] = useState('2.5 inch to mm');
  const [bore, setBore] = useState('150');
  const [speed, setSpeed] = useState('2');
  const answer = useMemo(() => run(expr), [expr]);
  const flow = useMemo(() => {
    try {
      const area = unit((Math.PI * (Number(bore) / 1000) ** 2) / 4, 'm^2');
      return format(area.multiply(unit(Number(speed), 'm/s')).to('m^3/h'), { precision: 4 });
    } catch (e) {
      return (e as Error).message;
    }
  }, [bore, speed]);
  return (
    <div className="mx-auto grid max-w-3xl gap-4 p-6 text-foreground sm:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Any expression</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Label htmlFor="expr">Expression</Label>
          <Input id="expr" value={expr} onChange={(e) => setExpr(e.target.value)} />
          <p className="rounded-md bg-muted px-3 py-2 font-mono text-lg">{answer}</p>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {CONVERSIONS.map((c) => (
              <li key={c} className="flex justify-between gap-4">
                <span>{c}</span>
                <span className="font-mono text-foreground">{run(c)}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Flow in a pipe</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Label htmlFor="bore">Bore (mm)</Label>
          <Input id="bore" value={bore} onChange={(e) => setBore(e.target.value)} />
          <Label htmlFor="speed">Speed (m/s)</Label>
          <Input id="speed" value={speed} onChange={(e) => setSpeed(e.target.value)} />
          <p className="rounded-md bg-primary px-3 py-2 font-mono text-lg text-primary-foreground">
            {flow}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
```
