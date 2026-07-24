'use client';

import * as React from 'react';
import { TrendingUp } from 'lucide-react';
import { Label, Pie, PieChart } from 'recharts';

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@mantle/web-ui/ui/card';
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@mantle/web-ui/ui/chart';
const chartData = [
  { model: 'opus', tokens: 275, fill: 'var(--color-opus)' },
  { model: 'sonnet', tokens: 287, fill: 'var(--color-sonnet)' },
  { model: 'haiku', tokens: 200, fill: 'var(--color-haiku)' },
  { model: 'local', tokens: 173, fill: 'var(--color-local)' },
  { model: 'embed', tokens: 190, fill: 'var(--color-embed)' },
];

const chartConfig = {
  tokens: {
    label: 'Tokens',
  },
  opus: {
    label: 'Opus 4.7',
    color: 'var(--chart-1)',
  },
  sonnet: {
    label: 'Sonnet 4.6',
    color: 'var(--chart-2)',
  },
  haiku: {
    label: 'Haiku 4.5',
    color: 'var(--chart-3)',
  },
  local: {
    label: 'Local',
    color: 'var(--chart-4)',
  },
  embed: {
    label: 'Embeddings',
    color: 'var(--chart-5)',
  },
} satisfies ChartConfig;

export function ChartPieDonut() {
  const totalTokens = React.useMemo(() => {
    return chartData.reduce((acc, curr) => acc + curr.tokens, 0);
  }, []);

  return (
    <Card className="flex flex-col h-full">
      <CardHeader className="items-center pb-0">
        <CardTitle>Tokens by model</CardTitle>
        <CardDescription>Last 6 months</CardDescription>
      </CardHeader>
      <CardContent className="flex-1 pb-0">
        <ChartContainer config={chartConfig} className="mx-auto aspect-square max-h-[300px]">
          <PieChart>
            <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel />} />
            <Pie data={chartData} dataKey="tokens" nameKey="model" innerRadius={60} strokeWidth={5}>
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
                          className="fill-foreground text-3xl font-bold"
                        >
                          {totalTokens.toLocaleString()}
                        </tspan>
                        <tspan
                          x={viewBox.cx}
                          y={(viewBox.cy || 0) + 24}
                          className="fill-muted-foreground"
                        >
                          Tokens
                        </tspan>
                      </text>
                    );
                  }
                }}
              />
            </Pie>
          </PieChart>
        </ChartContainer>
      </CardContent>
      <CardFooter className="flex-col gap-2 text-sm">
        <div className="flex items-center gap-2 font-medium leading-none">
          Trending up by 5.2% this month <TrendingUp className="h-4 w-4" />
        </div>
        <div className="leading-none text-muted-foreground">
          Showing total tokens by model for the last 6 months
        </div>
      </CardFooter>
    </Card>
  );
}
