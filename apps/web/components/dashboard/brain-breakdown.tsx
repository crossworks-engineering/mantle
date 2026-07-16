'use client';

import * as React from 'react';
import { Label, Pie, PieChart } from 'recharts';
import { formatCount } from '@/lib/format-bytes';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';

type Bucket = { key: string; count: number };
const PALETTE = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
];
const MAX_SLICES = 5;

function Donut({
  title,
  description,
  buckets,
  centerLabel,
}: {
  title: string;
  description?: string;
  buckets: Bucket[];
  centerLabel: string;
}) {
  const { data, config, total } = React.useMemo(() => {
    const ranked = [...buckets].sort((a, b) => b.count - a.count);
    const top = ranked.slice(0, MAX_SLICES);
    const rest = ranked.slice(MAX_SLICES);
    const slices = [...top];
    if (rest.length) slices.push({ key: 'other', count: rest.reduce((a, b) => a + b.count, 0) });

    const cfg: ChartConfig = {};
    const rows = slices.map((s, i) => {
      const id = s.key.replace(/[^a-z0-9_]/gi, '_');
      cfg[id] = {
        label: s.key === 'other' ? 'Other' : s.key.replace(/_/g, ' '),
        color: s.key === 'other' ? 'var(--muted-foreground)' : PALETTE[i % PALETTE.length],
      };
      return { name: id, label: s.key, value: s.count, fill: `var(--color-${id})` };
    });
    return { data: rows, config: cfg, total: slices.reduce((a, b) => a + b.count, 0) };
  }, [buckets]);

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="items-center pb-0 text-center">
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="flex-1 pb-2">
        {total === 0 ? (
          <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
            Nothing yet.
          </div>
        ) : (
          <ChartContainer config={config} className="mx-auto aspect-square max-h-[220px]">
            <PieChart>
              <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel />} />
              <Pie data={data} dataKey="value" nameKey="name" innerRadius={55} strokeWidth={4}>
                <Label
                  content={({ viewBox }) => {
                    if (viewBox && 'cx' in viewBox && 'cy' in viewBox) {
                      return (
                        <text
                          x={viewBox.cx}
                          y={viewBox.cy}
                          textAnchor="middle"
                          dominantBaseline="middle"
                        >
                          <tspan
                            x={viewBox.cx}
                            y={viewBox.cy}
                            className="fill-foreground text-2xl font-bold"
                          >
                            {formatCount(total)}
                          </tspan>
                          <tspan
                            x={viewBox.cx}
                            y={(viewBox.cy ?? 0) + 20}
                            className="fill-muted-foreground text-xs"
                          >
                            {centerLabel}
                          </tspan>
                        </text>
                      );
                    }
                  }}
                />
              </Pie>
            </PieChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

/** Two composition donuts: nodes by type and entities by kind. */
export function BrainBreakdown({
  nodesByType,
  entitiesByKind,
}: {
  nodesByType: Bucket[];
  entitiesByKind: Bucket[];
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Donut title="Nodes by type" buckets={nodesByType} centerLabel="nodes" />
      <Donut title="Entities by kind" buckets={entitiesByKind} centerLabel="entities" />
    </div>
  );
}
