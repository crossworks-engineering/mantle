/**
 * PS3 Control Room — the demo's showcase mini-app.
 *
 * A SHELL, deliberately: every number here is a constant. It exists to show
 * what a mini-app can look like when someone has bothered, not to be a working
 * SCADA head-end. Nothing it renders is fetched, so it cannot go stale, cannot
 * fail against the read-only demo, and cannot mislead anyone into thinking the
 * demo brain is wired to plant.
 *
 * Written against the curated app runtime only: react, lucide-react, the
 * `@/components/ui/*` kit, `@/lib/utils`, and Tailwind's theme tokens. It uses
 * semantic tokens (bg-background, text-muted-foreground, border) rather than
 * fixed colours, so it follows the brain's theme and both light and dark look
 * deliberate instead of one being an accident.
 */
import { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Droplets,
  Gauge,
  Power,
  Waves,
  Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

/** 24 hourly flow readings (m³/h) — a plausible diurnal curve, not random. */
const FLOW = [
  262, 241, 228, 224, 231, 268, 330, 392, 428, 441, 436, 424, 418, 421, 430, 447,
  468, 486, 472, 430, 388, 344, 306, 281,
];
const SETPOINT = 420;

const KPIS = [
  { key: 'flow', label: 'Duty flow', value: '431', unit: 'm³/h', delta: +2.4, icon: Droplets },
  { key: 'head', label: 'Total head', value: '38.2', unit: 'm', delta: -0.6, icon: Waves },
  { key: 'power', label: 'Absorbed power', value: '61.1', unit: 'kW', delta: +1.1, icon: Zap },
  { key: 'se', label: 'Specific energy', value: '0.145', unit: 'kWh/m³', delta: -3.2, icon: Gauge },
];

const PUMPS = [
  { id: 'P-101', role: 'Duty', running: true, hours: 18432, speed: 82, temp: 41 },
  { id: 'P-102', role: 'Standby', running: false, hours: 17980, speed: 0, temp: 24 },
  { id: 'P-103', role: 'Assist', running: true, hours: 9120, speed: 64, temp: 38 },
];

const EVENTS = [
  { at: '04:12', severity: 'info', text: 'P-103 ramped in on rising wet-well level' },
  { at: '03:58', severity: 'warn', text: 'Discharge pressure 2.1 bar below setpoint for 4 min' },
  { at: '02:30', severity: 'info', text: 'Tariff period changed to off-peak' },
  { at: '01:07', severity: 'crit', text: 'P-102 failed to start on test — motor protection tripped' },
  { at: '00:15', severity: 'info', text: 'Daily volume rolled over: 9 842 m³' },
];

/** Flow curve as an SVG path, with the area under it filled. */
function curve(values: number[], w: number, h: number, pad = 4) {
  const lo = Math.min(...values) * 0.92;
  const hi = Math.max(...values) * 1.04;
  const x = (i: number) => pad + (i * (w - pad * 2)) / (values.length - 1);
  const y = (v: number) => h - pad - ((v - lo) / (hi - lo)) * (h - pad * 2);
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return { line, area: `${line} L${x(values.length - 1)},${h} L${x(0)},${h} Z`, y };
}

function Delta({ value }: { value: number }) {
  const up = value >= 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-xs font-medium tabular-nums',
        up ? 'text-emerald-600 dark:text-emerald-400' : 'text-sky-600 dark:text-sky-400',
      )}
    >
      <Icon className="size-3" />
      {Math.abs(value).toFixed(1)}%
    </span>
  );
}

const SEVERITY: Record<string, string> = {
  info: 'bg-muted text-muted-foreground',
  warn: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  crit: 'bg-destructive/15 text-destructive',
};

export default function App() {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 200;
  const { line, area, y } = curve(FLOW, W, H);
  const shown = hover ?? FLOW.length - 1;

  return (
    <div className="min-h-full bg-background p-5 text-foreground">
      {/* ── Header ───────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary">
            <Activity className="size-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold leading-tight">PS3 Control Room</h1>
            <p className="text-xs text-muted-foreground">Pumphouse · telemetry mirror · 30 s refresh</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge className="gap-1.5 bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-400">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
            </span>
            Online
          </Badge>
          <span className="text-xs text-muted-foreground tabular-nums">updated 04:23</span>
        </div>
      </div>

      {/* ── KPI row ──────────────────────────────────────────────────── */}
      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {KPIS.map((k) => {
          const Icon = k.icon;
          return (
            <Card key={k.key} className="p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">{k.label}</span>
                <Icon className="size-4 text-muted-foreground/70" />
              </div>
              <div className="mt-2 flex items-baseline gap-1.5">
                <span className="text-2xl font-semibold tabular-nums tracking-tight">{k.value}</span>
                <span className="text-xs text-muted-foreground">{k.unit}</span>
              </div>
              <div className="mt-1">
                <Delta value={k.delta} />
                <span className="ml-1.5 text-xs text-muted-foreground">vs 7d</span>
              </div>
            </Card>
          );
        })}
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        {/* ── Flow chart ─────────────────────────────────────────────── */}
        <Card className="p-4 lg:col-span-2">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold">Flow, last 24 hours</h2>
              <p className="text-xs text-muted-foreground">
                Setpoint {SETPOINT} m³/h · hover to read a point
              </p>
            </div>
            <div className="text-right">
              <div className="text-xl font-semibold tabular-nums">{FLOW[shown]}</div>
              <div className="text-xs text-muted-foreground tabular-nums">
                {String(shown).padStart(2, '0')}:00
              </div>
            </div>
          </div>

          <svg viewBox={`0 0 ${W} ${H}`} className="mt-3 w-full" onMouseLeave={() => setHover(null)}>
            <defs>
              <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
                <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
              </linearGradient>
            </defs>
            <line
              x1="0"
              x2={W}
              y1={y(SETPOINT)}
              y2={y(SETPOINT)}
              className="stroke-muted-foreground/40"
              strokeDasharray="4 4"
              strokeWidth="1"
            />
            <path d={area} className="text-primary" fill="url(#fill)" />
            <path d={line} className="stroke-primary" fill="none" strokeWidth="2.5" strokeLinejoin="round" />
            {FLOW.map((v, i) => (
              <rect
                key={i}
                x={(i * W) / FLOW.length}
                y={0}
                width={W / FLOW.length}
                height={H}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
              />
            ))}
            <circle
              cx={4 + (shown * (W - 8)) / (FLOW.length - 1)}
              cy={y(FLOW[shown]!)}
              r="4"
              className="fill-background stroke-primary"
              strokeWidth="2.5"
            />
          </svg>
        </Card>

        {/* ── Pumps ──────────────────────────────────────────────────── */}
        <Card className="p-4">
          <h2 className="text-sm font-semibold">Pump set</h2>
          <div className="mt-3 space-y-3">
            {PUMPS.map((p, i) => (
              <div key={p.id}>
                {i > 0 && <Separator className="mb-3" />}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Power
                      className={cn(
                        'size-4',
                        p.running ? 'text-emerald-500' : 'text-muted-foreground/50',
                      )}
                    />
                    <span className="font-medium">{p.id}</span>
                    <Badge variant="secondary" className="text-[10px]">
                      {p.role}
                    </Badge>
                  </div>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {p.hours.toLocaleString()} h
                  </span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all',
                      p.running ? 'bg-primary' : 'bg-muted-foreground/30',
                    )}
                    style={{ width: `${p.running ? p.speed : 3}%` }}
                  />
                </div>
                <div className="mt-1 flex justify-between text-[11px] text-muted-foreground tabular-nums">
                  <span>{p.running ? `${p.speed}% speed` : 'stopped'}</span>
                  <span>{p.temp}°C bearing</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* ── Events ───────────────────────────────────────────────────── */}
      <Card className="mt-3 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Overnight events</h2>
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <AlertTriangle className="size-3.5" />1 needs review
          </span>
        </div>
        <div className="mt-3 space-y-1.5">
          {EVENTS.map((e) => (
            <div
              key={e.at}
              className="flex items-start gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/60"
            >
              <span className="pt-0.5 text-xs text-muted-foreground tabular-nums">{e.at}</span>
              <span
                className={cn(
                  'rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                  SEVERITY[e.severity],
                )}
              >
                {e.severity}
              </span>
              <span className="text-sm leading-snug">{e.text}</span>
            </div>
          ))}
        </div>
      </Card>

      <p className="mt-4 text-center text-[11px] text-muted-foreground">
        Demonstration shell · figures are illustrative, not live plant data
      </p>
    </div>
  );
}
