'use client';

import * as React from 'react';
import { Bar, BarChart, CartesianGrid, XAxis } from 'recharts';
import type { IngestDay } from '@/lib/dashboard';
import { formatCount } from '@mantle/web-ui/lib/format-bytes';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@mantle/web-ui/ui/card';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@mantle/web-ui/ui/chart';

const PALETTE = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
];
const MAX_SERIES = 5;

/** Nodes ingested per day, stacked by node type. The set of types is derived
 *  from the data: top-N by volume get their own colour, the rest fold into
 *  "other". */
export function IngestChart({ data }: { data: IngestDay[] }) {
  const { rows, config, keys } = React.useMemo(() => {
    const totals = new Map<string, number>();
    for (const d of data)
      for (const [t, c] of Object.entries(d.byType)) totals.set(t, (totals.get(t) ?? 0) + c);
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
    const top = ranked.slice(0, MAX_SERIES);
    const hasOther = ranked.length > top.length;
    const seriesKeys = hasOther ? [...top, 'other'] : top;

    const cfg: ChartConfig = {};
    seriesKeys.forEach((k, i) => {
      cfg[k] = {
        label: k === 'other' ? 'Other' : k.replace(/_/g, ' '),
        color: k === 'other' ? 'var(--muted-foreground)' : PALETTE[i % PALETTE.length],
      };
    });

    const built = data.map((d) => {
      const row: Record<string, string | number> = { day: d.day };
      let other = 0;
      for (const [t, c] of Object.entries(d.byType)) {
        if (top.includes(t)) row[t] = c;
        else other += c;
      }
      for (const k of top) if (!(k in row)) row[k] = 0;
      if (hasOther) row.other = other;
      return row;
    });
    return { rows: built, config: cfg, keys: seriesKeys };
  }, [data]);

  const total = React.useMemo(() => data.reduce((a, d) => a + d.total, 0), [data]);

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="text-base">Ingest activity</CardTitle>
        <CardDescription>
          {formatCount(total)} nodes added over {data.length} days
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={config} className="aspect-auto h-[220px] w-full">
          <BarChart data={rows} margin={{ left: 4, right: 8, top: 8 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="day"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={24}
              tickFormatter={(v: string) => v.slice(5)}
            />
            <ChartTooltip content={<ChartTooltipContent labelKey="day" />} />
            <ChartLegend content={<ChartLegendContent />} />
            {keys.map((k) => (
              <Bar key={k} dataKey={k} stackId="a" fill={`var(--color-${k})`} />
            ))}
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
