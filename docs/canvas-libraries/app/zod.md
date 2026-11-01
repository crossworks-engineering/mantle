# Zod in a mini app

Version: zod 4.6.7, as this brain's app runtime serves it.
Source: the Zod 4 docs (zod.dev: basics, the API, error customization,
formatting errors) and its v4 changelog. Written for Mantle, not copied.

## Import

```tsx
import { z } from 'zod';
```

`z` is a named export; there is no default export, and `import z from
'zod'` fails the build. The frame's import map serves it (about 450 KB,
fetched only by an app that imports it); it is not bundled into the app.

## In a React component

- Describe the shape once, at module scope:
  `const Tag = z.object({ tag: z.string().regex(/^[A-Z]{1,3}-\d{2,5}$/), email: z.email() })`.
  `type Tag = z.infer<typeof Tag>` gives the TypeScript type for free.
- `Tag.safeParse(value)` returns `{ success: true, data }` or
  `{ success: false, error }` and never throws. Use it for a form; use
  `.parse` only where a throw is what you want.
- Form inputs are strings: `z.coerce.number().min(0).max(250)` turns
  `'12.5'` into `12.5`; an empty input becomes `0`, so pair it with a
  `z.string().min(1)` check or a `refine` when empty must fail.
- Messages for people: `z.string().min(1, { error: 'A tag is required' })`.
  In v4 the option is `error`; the old `message` still works but is
  deprecated.
- Errors by field: `z.flattenError(result.error).fieldErrors.tag` is an
  array of messages (or undefined). `z.prettifyError(error)` is one
  readable string for a whole object.
- v4 moves the string formats to the top: `z.email()`, `z.url()`,
  `z.uuid()`, `z.iso.date()`. `z.string().email()` still runs, deprecated.
- Check rows from `host.db` too: a schema at the edge catches a column that
  changed before it breaks a chart.
- No eval: this brain runs Zod with `jitless` on (the frame has no
  `unsafe-eval`), so parsing is the plain interpreter, fast enough for
  forms and thousands of rows.

## App example

```tsx
import { useState } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const Reading = z.object({
  tag: z.string().regex(/^[A-Z]{1,3}-\d{2,5}$/, { error: 'Use a tag like PT-1042' }),
  pressure: z.coerce
    .number({ error: 'A number, please' })
    .min(0, { error: 'Not below 0 bar' })
    .max(250, { error: 'Not above 250 bar' }),
  inspector: z.email({ error: 'An email address' }),
});
type Reading = z.infer<typeof Reading>;

const FIELDS = [
  { name: 'tag', label: 'Tag' },
  { name: 'pressure', label: 'Pressure (bar)' },
  { name: 'inspector', label: 'Inspector email' },
] as const;

export default function App() {
  const [form, setForm] = useState({ tag: 'pt-12', pressure: '300', inspector: 'sam@' });
  const [saved, setSaved] = useState<Reading[]>([]);
  const result = Reading.safeParse(form);
  const errors = result.success ? {} : z.flattenError(result.error).fieldErrors;
  return (
    <div className="mx-auto max-w-lg space-y-4 p-6 text-foreground">
      <Card>
        <CardHeader>
          <CardTitle>Log a reading</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {FIELDS.map((f) => (
            <div key={f.name} className="space-y-1">
              <Label htmlFor={f.name}>{f.label}</Label>
              <Input
                id={f.name}
                value={form[f.name]}
                onChange={(e) => setForm({ ...form, [f.name]: e.target.value })}
              />
              {errors[f.name] && <p className="text-sm text-destructive">{errors[f.name]![0]}</p>}
            </div>
          ))}
          <Button
            disabled={!result.success}
            onClick={() => result.success && setSaved([result.data, ...saved])}
          >
            Save
          </Button>
        </CardContent>
      </Card>
      <ul className="space-y-1 text-sm">
        {saved.map((r, i) => (
          <li key={i} className="rounded-md border bg-card px-3 py-2 font-mono">
            {r.tag} {r.pressure} bar {r.inspector}
          </li>
        ))}
      </ul>
    </div>
  );
}
```
