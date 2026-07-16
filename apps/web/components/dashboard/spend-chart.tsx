'use client';

import * as React from 'react';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import type { DailySpend } from '@/lib/metrics';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { formatMicroUsd } from '@/lib/traces-format';

const config = {
  usd: { label: 'Spend', color: 'var(--chart-1)' },
} satisfies ChartConfig;

/** LLM spend per day. Fed the full window from the server; the range toggle
 *  slices the prefetched array client-side (no refetch). */
export function SpendChart({ data }: { data: DailySpend[] }) {
  const [range, setRange] = React.useState<'7' | '14' | '30'>('14');
  const rows = React.useMemo(() => {
    const n = Number(range);
    return data.slice(-n).map((d) => ({
      day: d.day,
      usd: d.costMicroUsd / 1_000_000,
      microUsd: d.costMicroUsd,
    }));
  }, [data, range]);

  const total = React.useMemo(() => rows.reduce((a, r) => a + r.microUsd, 0), [rows]);

  return (
    <Card className="h-full">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">LLM spend</CardTitle>
          <CardDescription>
            {formatMicroUsd(total)} over last {range} days
          </CardDescription>
        </div>
        <ToggleGroup
          type="single"
          value={range}
          onValueChange={(v) => v && setRange(v as '7' | '14' | '30')}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="7">7d</ToggleGroupItem>
          <ToggleGroupItem value="14">14d</ToggleGroupItem>
          <ToggleGroupItem value="30">30d</ToggleGroupItem>
        </ToggleGroup>
      </CardHeader>
      <CardContent>
        <ChartContainer config={config} className="aspect-auto h-[220px] w-full">
          <AreaChart data={rows} margin={{ left: 4, right: 8, top: 8 }}>
            <defs>
              <linearGradient id="fillSpend" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-usd)" stopOpacity={0.7} />
                <stop offset="95%" stopColor="var(--color-usd)" stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="day"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={24}
              tickFormatter={(v: string) => v.slice(5)}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={48}
              tickFormatter={(v: number) => formatMicroUsd(v * 1_000_000)}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelKey="day"
                  formatter={(value) => formatMicroUsd((value as number) * 1_000_000)}
                />
              }
            />
            <Area
              dataKey="usd"
              type="monotone"
              fill="url(#fillSpend)"
              stroke="var(--color-usd)"
              strokeWidth={2}
            />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
