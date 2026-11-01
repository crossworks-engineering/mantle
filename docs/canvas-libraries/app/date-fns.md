# date-fns in a mini app

Version: date-fns 4.4.0, as this brain's app runtime serves it.
Source: the date-fns docs (date-fns.org: format tokens, intervals, v4
release notes). Written for Mantle, not copied.

## Import

```tsx
import { format, addBusinessDays, differenceInCalendarDays, parseISO } from 'date-fns';
```

Named imports only. Subpaths (`date-fns/locale`, `date-fns/fp`) are
refused, so dates print in English. The frame's import map serves it; it is
not bundled into the app.

## In a React component

- Functions take a `Date` and return a new one; nothing is changed in
  place. Keep dates as ISO strings (`'2026-11-02'`) in state and in
  `host.db`, and `parseISO` them when you compute. `new Date('2026-11-02')`
  reads UTC midnight, `parseISO('2026-11-02')` reads local midnight: use
  `parseISO`.
- `format(d, 'yyyy-MM-dd')`, `format(d, 'EEE d MMM')`, `format(d, 'HH:mm')`.
  The tokens are Unicode ones: `yyyy` and `dd`, not `YYYY` and `DD` (those
  throw a RangeError, to catch the mistake).
- Arithmetic: `addDays`, `addBusinessDays` (skips Saturday and Sunday),
  `subMonths`, `differenceInCalendarDays(later, earlier)`,
  `differenceInBusinessDays`.
- Ranges: `eachDayOfInterval({ start, end })`, `startOfWeek(d, { weekStartsOn: 1 })`
  for a Monday week, `isWithinInterval(d, { start, end })`.
- Checks: `isWeekend`, `isBefore`, `isAfter`, `isSameDay`, `isValid`.
- `formatDistanceToNow(d, { addSuffix: true })` gives "3 days ago".
- Time zones: v4 works in the browser's own zone. There is no zone
  database here (`@date-fns/tz` is not served); store UTC and show local.
- Holidays are not known to `addBusinessDays`: keep a list of ISO dates and
  skip them yourself.

## App example

```tsx
import { useMemo, useState } from 'react';
import {
  addBusinessDays,
  differenceInCalendarDays,
  eachDayOfInterval,
  format,
  isValid,
  isWeekend,
  parseISO,
} from 'date-fns';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const STEPS = [
  { name: 'Isolate and drain', days: 2 },
  { name: 'Open and inspect', days: 3 },
  { name: 'Repair', days: 4 },
  { name: 'Close, test, hand back', days: 2 },
];

export default function App() {
  const [start, setStart] = useState('2026-11-02');
  // A cleared date input gives '': an invalid date would make format throw.
  const first = isValid(parseISO(start)) ? parseISO(start) : parseISO('2026-11-02');
  const plan = useMemo(() => {
    let at = first;
    return STEPS.map((s) => {
      const from = at;
      at = addBusinessDays(at, s.days);
      return { ...s, from, to: at };
    });
  }, [start]);
  const end = plan[plan.length - 1]!.to;
  const days = eachDayOfInterval({ start: first, end });
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6 text-foreground">
      <Card>
        <CardHeader>
          <CardTitle>Shutdown plan</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="start">Start</Label>
              <Input
                id="start"
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </div>
            <p className="text-sm text-muted-foreground">
              Ends {format(end, 'EEE d MMM yyyy')}, {differenceInCalendarDays(end, first)} calendar
              days.
            </p>
          </div>
          <ol className="space-y-2">
            {plan.map((s) => (
              <li key={s.name} className="flex justify-between rounded-md border px-3 py-2">
                <span>{s.name}</span>
                <span className="font-mono text-sm text-muted-foreground">
                  {format(s.from, 'd MMM')} to {format(s.to, 'd MMM')}
                </span>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-1">
            {days.map((d) => (
              <span
                key={d.toISOString()}
                title={format(d, 'EEEE d MMMM')}
                className={`w-9 rounded py-1 text-center text-xs ${
                  isWeekend(d)
                    ? 'bg-muted text-muted-foreground'
                    : 'bg-primary text-primary-foreground'
                }`}
              >
                {format(d, 'd')}
              </span>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```
