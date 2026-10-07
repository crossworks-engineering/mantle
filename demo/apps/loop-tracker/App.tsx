/**
 * Loop check tracker: the twelve PS3 signals and where each one stands.
 *
 * A SHELL, like every demo app: the list is a constant that matches the PS3
 * I/O schedule table (day 1 proved seven signals, five are left for day 2).
 * Ticking a box here changes nothing in the brain; it only shows what the
 * tracker would feel like on site.
 *
 * Written against the curated app runtime only: react, lucide-react, the
 * `@/components/ui/*` kit, `@/lib/utils` and Tailwind's theme tokens.
 */
import { useMemo, useState } from 'react';
import { CheckCircle2, Circle, Radio, Filter } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

type Signal = { tag: string; name: string; type: 'AI' | 'AO' | 'DI' | 'DO'; range: string; day: 1 | 2; done: boolean };

const SIGNALS: Signal[] = [
  { tag: 'LT-101', name: 'Wet well level', type: 'AI', range: '0 to 6 m', day: 1, done: true },
  { tag: 'FT-201', name: 'Delivery flow', type: 'AI', range: '0 to 600 m³/h', day: 1, done: true },
  { tag: 'PT-301', name: 'Delivery pressure', type: 'AI', range: '0 to 10 bar', day: 1, done: true },
  { tag: 'P-101.RUN', name: 'Duty pump running', type: 'DI', range: 'on/off', day: 1, done: true },
  { tag: 'P-102.RUN', name: 'Standby pump running', type: 'DI', range: 'on/off', day: 1, done: true },
  { tag: 'MAINS.OK', name: 'Mains supply healthy', type: 'DI', range: 'on/off', day: 1, done: true },
  { tag: 'DOOR.OPEN', name: 'Kiosk door open', type: 'DI', range: 'on/off', day: 1, done: true },
  { tag: 'P-101.FLT', name: 'Duty pump fault', type: 'DI', range: 'on/off', day: 2, done: false },
  { tag: 'XV-401.POS', name: 'Delivery valve position', type: 'AI', range: '0 to 100 %', day: 2, done: false },
  { tag: 'XV-401.CMD', name: 'Delivery valve command', type: 'AO', range: '0 to 100 %', day: 2, done: false },
  { tag: 'GEN.RUN', name: 'Standby generator running', type: 'DI', range: 'on/off', day: 2, done: false },
  { tag: 'RTU.BATT', name: 'RTU battery voltage', type: 'AI', range: '0 to 30 V', day: 2, done: false },
];

export default function App() {
  const [done, setDone] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(SIGNALS.map((s) => [s.tag, s.done])),
  );
  const [onlyOpen, setOnlyOpen] = useState(false);
  const proven = SIGNALS.filter((s) => done[s.tag]).length;
  const shown = useMemo(() => SIGNALS.filter((s) => !onlyOpen || !done[s.tag]), [onlyOpen, done]);
  const pct = Math.round((proven / SIGNALS.length) * 100);

  return (
    <div className="min-h-full bg-background p-5 text-foreground">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary">
            <Radio className="size-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold leading-tight">Loop check tracker</h1>
            <p className="text-xs text-muted-foreground">PS3 · rev B order: level, flow, pressure, then the valve</p>
          </div>
        </div>
        <Button variant={onlyOpen ? 'default' : 'outline'} size="sm" onClick={() => setOnlyOpen((v) => !v)}>
          <Filter className="mr-1.5 size-3.5" />
          {onlyOpen ? 'Showing what is left' : 'Show what is left'}
        </Button>
      </div>

      <Card className="mt-5 p-4">
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-medium">Signals proven</span>
          <span className="text-2xl font-semibold tabular-nums">
            {proven}
            <span className="text-sm text-muted-foreground"> / {SIGNALS.length}</span>
          </span>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Day 1 proved seven signals. Day 2 is witnessed by Lena Marsh and needs a sixty-second radio outage for the XV-401 test.
        </p>
      </Card>

      <Card className="mt-3 divide-y p-0">
        {shown.map((s) => {
          const ok = done[s.tag];
          const Icon = ok ? CheckCircle2 : Circle;
          return (
            <button
              key={s.tag}
              type="button"
              onClick={() => setDone((d) => ({ ...d, [s.tag]: !d[s.tag] }))}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/60"
            >
              <Icon className={cn('size-4 shrink-0', ok ? 'text-emerald-500' : 'text-muted-foreground/60')} />
              <span className="w-28 font-mono text-sm">{s.tag}</span>
              <span className="flex-1 text-sm">{s.name}</span>
              <Badge variant="secondary" className="text-[10px]">{s.type}</Badge>
              <span className="hidden w-28 text-right text-xs text-muted-foreground tabular-nums sm:block">{s.range}</span>
              <span className="w-12 text-right text-xs text-muted-foreground">day {s.day}</span>
            </button>
          );
        })}
      </Card>

      <p className="mt-4 text-center text-[11px] text-muted-foreground">
        Demonstration shell · ticks are not saved
      </p>
    </div>
  );
}
