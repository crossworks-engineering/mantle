/**
 * Battery autonomy calculator: the standby study's one sum, with sliders.
 *
 * Same arithmetic as the "Battery autonomy for a grid outage" formula:
 * usable energy (nameplate x depth of discharge x inverter efficiency) over
 * the net load (station load less solar). Defaults are option B at night
 * with one pump: 350 kWh, 90 %, 95 %, 65 kW, no solar, so 4.6 hours.
 *
 * Written against the curated app runtime only: react, lucide-react, the
 * `@/components/ui/*` kit, `@/lib/utils` and Tailwind's theme tokens.
 */
import { useState } from 'react';
import { BatteryCharging, Sun, Zap, Clock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const TARGET_H = 4;

function Slider(props: { label: string; unit: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground">{props.label}</span>
        <span className="font-medium tabular-nums">
          {props.value} {props.unit}
        </span>
      </div>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        className="mt-2 w-full accent-primary"
      />
    </label>
  );
}

export default function App() {
  const [nameplate, setNameplate] = useState(350);
  const [dod, setDod] = useState(90);
  const [inverter, setInverter] = useState(95);
  const [load, setLoad] = useState(65);
  const [solar, setSolar] = useState(0);

  const usable = nameplate * (dod / 100) * (inverter / 100);
  const net = Math.max(load - solar, 0.1);
  const hours = usable / net;
  const margin = hours - TARGET_H;
  const rating = margin >= 0.5 ? 'Meets' : margin >= 0 ? 'Marginal' : 'Short';
  const tone =
    rating === 'Meets'
      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
      : rating === 'Marginal'
        ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
        : 'bg-destructive/15 text-destructive';

  const preset = (n: number, s: number) => {
    setNameplate(n);
    setSolar(s);
  };

  return (
    <div className="min-h-full bg-background p-5 text-foreground">
      <div className="flex items-center gap-3">
        <div className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary">
          <BatteryCharging className="size-5" />
        </div>
        <div>
          <h1 className="text-lg font-semibold leading-tight">Battery autonomy calculator</h1>
          <p className="text-xs text-muted-foreground">PS3 standby study · target {TARGET_H} hours with the grid down</p>
        </div>
      </div>

      <div className="mt-5 grid gap-3 lg:grid-cols-5">
        <Card className="space-y-5 p-4 lg:col-span-3">
          <Slider label="Nameplate capacity" unit="kWh" min={200} max={500} step={10} value={nameplate} onChange={setNameplate} />
          <Slider label="Depth of discharge" unit="%" min={70} max={100} step={1} value={dod} onChange={setDod} />
          <Slider label="Inverter efficiency" unit="%" min={85} max={99} step={1} value={inverter} onChange={setInverter} />
          <Slider label="Station load" unit="kW" min={4} max={124} step={1} value={load} onChange={setLoad} />
          <Slider label="Solar" unit="kW" min={0} max={40} step={1} value={solar} onChange={setSolar} />
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" variant="outline" onClick={() => preset(300, 0)}>300 kWh, night</Button>
            <Button size="sm" variant="outline" onClick={() => preset(350, 0)}>350 kWh, night</Button>
            <Button size="sm" variant="outline" onClick={() => preset(350, 25)}>350 kWh, winter noon</Button>
          </div>
        </Card>

        <Card className="flex flex-col justify-between p-4 lg:col-span-2">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Autonomy</span>
              <Badge className={cn('hover:bg-transparent', tone)}>{rating}</Badge>
            </div>
            <div className="mt-2 flex items-baseline gap-1.5">
              <span className="text-5xl font-semibold tabular-nums tracking-tight">{hours.toFixed(1)}</span>
              <span className="text-sm text-muted-foreground">hours</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground tabular-nums">
              {margin >= 0 ? '+' : ''}
              {margin.toFixed(2)} h against the {TARGET_H} h target
            </p>
          </div>
          <div className="mt-6 space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-muted-foreground"><Zap className="size-3.5" />Usable energy</span>
              <span className="tabular-nums">{usable.toFixed(0)} kWh</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-muted-foreground"><Sun className="size-3.5" />Net load</span>
              <span className="tabular-nums">{net.toFixed(0)} kW</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-muted-foreground"><Clock className="size-3.5" />Target</span>
              <span className="tabular-nums">{TARGET_H} h</span>
            </div>
          </div>
        </Card>
      </div>

      <p className="mt-4 text-center text-[11px] text-muted-foreground">
        Demonstration shell · the brain's formula is the source of truth
      </p>
    </div>
  );
}
